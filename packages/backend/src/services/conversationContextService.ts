/**
 * @description: Builds canonical conversation messages plus a backend-owned
 * context envelope used by planner/generation workflow seams.
 * @footnote-scope: core
 * @footnote-module: ConversationContextService
 * @footnote-risk: high - Conversation assembly is the single history source for planner and generation.
 * @footnote-ethics: high - Incorrect identity/visibility handling can misattribute speakers or leak backend-only context.
 */
import type {
    ChatConversationMessage,
    PostChatRequest,
} from '@footnote/contracts/web';

const DISCORD_CONTEXT_WINDOW_SIZE = 24;

type ConversationContextLogger = {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    debug: (message: string, meta?: Record<string, unknown>) => void;
};

export type ConversationContextVisibility = 'model_visible' | 'backend_only';
export type ConversationContextAuthority =
    | 'conversation'
    | 'instructional'
    | 'advisory'
    | 'internal';

export type ConversationContextEnvelope = {
    participants: Array<{
        speakerId: string;
        speakerLabel: string;
        roleHint: 'user' | 'assistant' | 'system';
    }>;
    turns: Array<{
        turnId: string;
        role: 'system' | 'user' | 'assistant';
        speakerId: string;
        speakerLabel: string;
        visibility: ConversationContextVisibility;
        authority: ConversationContextAuthority;
        messageId?: string;
        createdAt?: string;
    }>;
    diagnostics: {
        surface: PostChatRequest['surface'];
        totalInputMessages: number;
        projectedMessageCount: number;
        trimmedMessageCount: number;
        sanitizedTimestampCount: number;
        projectedSpeakerLabelCount: number;
    };
};

export type ConversationContextProjectionTurn = {
    role: 'system' | 'user' | 'assistant';
    content: string;
    speakerId: string;
    speakerLabel: string;
    visibility: ConversationContextVisibility;
};

export type ConversationContextServiceOutput = {
    messages: Array<Pick<ChatConversationMessage, 'role' | 'content'>>;
    contextEnvelope: ConversationContextEnvelope;
};

export type ConversationContextEnvelopeSnapshot = {
    schemaVersion: 'v1';
    counts: {
        participantCount: number;
        turnCount: number;
        projectedMessageCount: number;
    };
    roleCounts: {
        system: number;
        user: number;
        assistant: number;
    };
    visibilityCounts: {
        modelVisible: number;
        backendOnly: number;
    };
    authorityCounts: Partial<Record<ConversationContextAuthority, number>>;
    diagnostics: ConversationContextEnvelope['diagnostics'];
};

export class ConversationContextAssemblyError extends Error {
    readonly reasonCode:
        | 'invalid_message_shape'
        | 'invalid_role'
        | 'missing_content'
        | 'missing_speaker_identity';

    constructor(
        reasonCode: ConversationContextAssemblyError['reasonCode'],
        message: string
    ) {
        super(message);
        this.name = 'ConversationContextAssemblyError';
        this.reasonCode = reasonCode;
    }
}

const normalizeScopeValue = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const parseCreatedAt = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }
    return date.toISOString();
};

const trimDiscordConversationWindow = (
    conversation: PostChatRequest['conversation']
): PostChatRequest['conversation'] => {
    const retainedReverse: PostChatRequest['conversation'] = [];
    let nonSystemCount = 0;
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
        const message = conversation[index];
        if (!message) {
            continue;
        }
        if (message.role === 'system') {
            retainedReverse.push(message);
            continue;
        }
        if (nonSystemCount >= DISCORD_CONTEXT_WINDOW_SIZE) {
            continue;
        }
        retainedReverse.push(message);
        nonSystemCount += 1;
    }
    return retainedReverse.reverse();
};

const normalizeConversationWindow = (
    request: PostChatRequest
): {
    conversation: PostChatRequest['conversation'];
    trimmedMessageCount: number;
} => {
    if (request.surface !== 'discord') {
        return {
            conversation: request.conversation,
            trimmedMessageCount: 0,
        };
    }
    const trimmedConversation = trimDiscordConversationWindow(
        request.conversation
    );
    return {
        conversation: trimmedConversation,
        trimmedMessageCount: Math.max(
            0,
            request.conversation.length - trimmedConversation.length
        ),
    };
};

/**
 * Produces one canonical, role-aligned message list plus a backend-owned
 * envelope. If role/speaker identity cannot be determined, fail closed.
 */
export const projectConversationMessages = (
    turns: ConversationContextProjectionTurn[]
): Array<Pick<ChatConversationMessage, 'role' | 'content'>> => {
    const visibleHumanSpeakerIds = new Set(
        turns
            .filter(
                (turn) =>
                    turn.visibility === 'model_visible' && turn.role === 'user'
            )
            .map((turn) => turn.speakerId)
    );
    const requiresSpeakerProjection = visibleHumanSpeakerIds.size > 1;
    return turns
        .filter((turn) => turn.visibility === 'model_visible')
        .map((turn) => ({
            role: turn.role,
            content:
                requiresSpeakerProjection && turn.role !== 'system'
                    ? `[${turn.speakerLabel}] ${turn.content}`
                    : turn.content,
        }));
};

/**
 * Produces one canonical, role-aligned message list plus a backend-owned
 * envelope. If role/speaker identity cannot be determined, fail closed.
 */
export const buildConversationContext = (
    request: PostChatRequest,
    logger: ConversationContextLogger
): ConversationContextServiceOutput => {
    const { conversation, trimmedMessageCount } =
        normalizeConversationWindow(request);
    const participants = new Map<
        string,
        {
            speakerId: string;
            speakerLabel: string;
            roleHint: 'user' | 'assistant' | 'system';
        }
    >();
    const envelopeTurns: ConversationContextEnvelope['turns'] = [];
    let sanitizedTimestampCount = 0;

    const normalizedTurns = conversation.map((message, index) => {
        if (!message || typeof message !== 'object') {
            throw new ConversationContextAssemblyError(
                'invalid_message_shape',
                `Conversation message at index ${index} is not an object.`
            );
        }

        if (
            message.role !== 'system' &&
            message.role !== 'user' &&
            message.role !== 'assistant'
        ) {
            throw new ConversationContextAssemblyError(
                'invalid_role',
                `Conversation message at index ${index} has an invalid role.`
            );
        }

        if (typeof message.content !== 'string') {
            throw new ConversationContextAssemblyError(
                'missing_content',
                `Conversation message at index ${index} is missing string content.`
            );
        }

        const content = message.content.trim();
        const speakerId =
            message.role === 'system'
                ? 'system'
                : (normalizeScopeValue(message.authorId) ??
                  normalizeScopeValue(message.authorName) ??
                  message.role);

        const speakerLabel =
            normalizeScopeValue(message.authorName) ??
            normalizeScopeValue(message.authorId) ??
            (message.role === 'assistant'
                ? 'Assistant'
                : message.role === 'user'
                  ? 'User'
                  : 'System');
        const createdAt = parseCreatedAt(message.createdAt);
        if (message.createdAt && !createdAt) {
            sanitizedTimestampCount += 1;
        }

        const key = `${message.role}:${speakerId}`;
        if (!participants.has(key)) {
            participants.set(key, {
                speakerId,
                speakerLabel,
                roleHint: message.role,
            });
        }

        envelopeTurns.push({
            turnId: `turn_${index}`,
            role: message.role,
            speakerId,
            speakerLabel,
            visibility: 'model_visible',
            authority: 'conversation',
            ...(message.messageId && { messageId: message.messageId }),
            ...(createdAt && { createdAt }),
        });

        return {
            role: message.role,
            content,
            speakerId,
            speakerLabel,
        };
    });

    const messages = projectConversationMessages(
        normalizedTurns.map((turn) => ({
            role: turn.role,
            content: turn.content,
            speakerId: turn.speakerId,
            speakerLabel: turn.speakerLabel,
            visibility: 'model_visible' as const,
        }))
    );
    const projectedSpeakerLabelCount = messages.filter((message) =>
        message.content.startsWith('[')
    ).length;

    if (trimmedMessageCount > 0) {
        logger.debug('conversation.trimmed', {
            originalLength: request.conversation.length,
            trimmedLength: conversation.length,
        });
    }
    if (sanitizedTimestampCount > 0) {
        logger.warn('conversation.context.timestamp_sanitized', {
            event: 'conversation.context.timestamp_sanitized',
            surface: request.surface,
            sanitizedTimestampCount,
        });
    }

    return {
        messages,
        contextEnvelope: {
            participants: [...participants.values()],
            turns: envelopeTurns,
            diagnostics: {
                surface: request.surface,
                totalInputMessages: request.conversation.length,
                projectedMessageCount: messages.length,
                trimmedMessageCount,
                sanitizedTimestampCount,
                projectedSpeakerLabelCount,
            },
        },
    };
};

/**
 * Redacts runtime envelope into a snapshot-safe summary.
 * Excludes speaker ids/labels, turn content, and backend-only payload internals.
 */
export const toSnapshotContextEnvelope = (
    envelope: ConversationContextEnvelope
): ConversationContextEnvelopeSnapshot => {
    const roleCounts = {
        system: 0,
        user: 0,
        assistant: 0,
    };
    let modelVisible = 0;
    let backendOnly = 0;
    const authorityCounts: Partial<
        Record<ConversationContextAuthority, number>
    > = {};

    for (const turn of envelope.turns) {
        roleCounts[turn.role] += 1;
        if (turn.visibility === 'model_visible') {
            modelVisible += 1;
        } else {
            backendOnly += 1;
        }
        authorityCounts[turn.authority] =
            (authorityCounts[turn.authority] ?? 0) + 1;
    }

    return {
        schemaVersion: 'v1',
        counts: {
            participantCount: envelope.participants.length,
            turnCount: envelope.turns.length,
            projectedMessageCount: envelope.diagnostics.projectedMessageCount,
        },
        roleCounts,
        visibilityCounts: {
            modelVisible,
            backendOnly,
        },
        authorityCounts,
        diagnostics: envelope.diagnostics,
    };
};
