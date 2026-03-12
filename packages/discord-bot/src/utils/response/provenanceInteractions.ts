/**
 * @description: Handles provenance control interactions, lenses, and trace lookups.
 * @footnote-scope: interface
 * @footnote-module: ProvenanceInteractions
 * @footnote-risk: medium - Interaction failures can block provenance navigation.
 * @footnote-ethics: high - Provenance access affects user trust and accountability.
 */
import type {
    ButtonInteraction,
    InteractionReplyOptions,
    Message,
    ModalSubmitInteraction,
    StringSelectMenuInteraction,
    GuildMember,
    APIInteractionGuildMember,
} from 'discord.js';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import type {
    ResponseMetadata,
    Citation,
} from '@footnote/contracts/ethics-core';
import { logger } from '../logger.js';
import { ResponseHandler } from './ResponseHandler.js';
import {
    OpenAIService,
    type OpenAIMessage,
    type OpenAIOptions,
    type SupportedModel,
} from '../openaiService.js';
import { renderPromptWithProfileOverlay } from '../../config.js';
import { Planner } from '../prompting/Planner.js';
import { botApi } from '../../api/botApi.js';
import { parseProvenanceActionCustomId } from './provenanceCgi.js';

/**
 * Supported alternative-lens presets exposed in the provenance UI.
 */
export type AlternativeLensKey =
    | 'DANEEL'
    | 'UTILITARIAN'
    | 'DEONTOLOGICAL'
    | 'VIRTUE_ETHICS'
    | 'EASTERN'
    | 'CUSTOM';

/**
 * One selectable lens option shown to the user.
 */
export interface AlternativeLensDefinition {
    key: AlternativeLensKey;
    label: string;
    description: string;
    requiresCustomDescription?: boolean;
}

/**
 * Snapshot of the original response and metadata needed to generate a
 * follow-up lens rewrite.
 */
export interface AlternativeLensContext {
    /**
     * Raw text of the assistant message to reinterpret.
     */
    messageText: string;
    /**
     * Persisted provenance metadata for the message, when available.
     */
    metadata: ResponseMetadata | null;
    /**
     * Discord message identifier associated with provenance controls.
     * Useful when posting follow-up replies.
     */
    messageId: string;
    /**
     * Discord channel identifier where the interaction took place.
     */
    channelId: string;
    /**
     * Stored response identifier, if it could be recovered from controls.
     */
    responseId?: string;
}

/**
 * Mutable session state for one user's in-progress alternative-lens flow.
 */
export interface AlternativeLensSession {
    context: AlternativeLensContext;
    selectedLensKey: AlternativeLensKey | null;
    customDescription: string | null;
}

type AlternativeLensSessionRecord = {
    session: AlternativeLensSession;
    expiresAt: number;
};

type LensTelemetryInteraction = ButtonInteraction | StringSelectMenuInteraction;
type AlternativeLensAction =
    | 'alt_lens:init'
    | 'alt_lens:select'
    | 'alt_lens:submit';

// -----------------------------
// Lens catalogue configuration
// -----------------------------
const LENS_DEFINITIONS: AlternativeLensDefinition[] = [
    {
        key: 'DANEEL',
        label: 'Asimovian (Daneel character)',
        description:
            'Channel Daneel Olivaw: state clean facts, guard human welfare, and apply Zeroth Law judgment.',
    },
    {
        key: 'UTILITARIAN',
        label: 'Utilitarian',
        description: 'Prioritise overall outcomes and collective wellbeing.',
    },
    {
        key: 'DEONTOLOGICAL',
        label: 'Deontological',
        description: 'Emphasise duties, rules, and principled obligations.',
    },
    {
        key: 'VIRTUE_ETHICS',
        label: 'Virtue Ethics',
        description:
            'Highlight character, cultivation of virtues, and moral exemplars.',
    },
    {
        key: 'EASTERN',
        label: 'Eastern Philosophy',
        description:
            'Incorporate perspectives rooted in Confucian, Buddhist, or Daoist thought.',
    },
    {
        key: 'CUSTOM',
        label: 'Custom Lens',
        description: 'Provide your own framing or perspective.',
        requiresCustomDescription: true,
    },
];

const provenanceLogger = logger.child({ module: 'provenance' });

/**
 * Custom ID prefix for the alternative-lens select menu.
 */
export const ALTERNATIVE_LENS_SELECT_PREFIX = 'alt_lens_select:';
/**
 * Custom ID prefix for the alternative-lens submit button.
 */
export const ALTERNATIVE_LENS_SUBMIT_PREFIX = 'alt_lens_submit:';
/**
 * Custom ID prefix for the custom-lens modal dialog.
 */
export const ALTERNATIVE_LENS_MODAL_PREFIX = 'alt_lens_custom_modal:';
/**
 * Text input ID used inside the custom-lens modal.
 */
export const ALT_LENS_CUSTOM_DESCRIPTION_INPUT_ID =
    'alt_lens_custom_description';
// Message body retrieval - keep bounded to reduce API calls and avoid stale context in busy channels.
const MAX_PRECEDING_RESPONSE_MESSAGES = 16;
const MAX_RESPONSE_CHAIN_WINDOW_MS = 2 * 60_000;
// Keep interaction state bounded so abandoned flows do not accumulate forever.
// We prune lazily during normal reads/writes instead of running a background timer.
const ALTERNATIVE_LENS_SESSION_TTL_MS = 15 * 60_000;

/**
 * Builds the cache key for one user's alternative-lens session on a message.
 */
export const buildAlternativeLensSessionKey = (
    userId: string,
    messageId: string
) => `${userId}:${messageId}`;

const isCitationPayload = (value: unknown): value is Citation => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<Citation>;
    return (
        typeof candidate.title === 'string' &&
        typeof candidate.url === 'string' &&
        (candidate.snippet === undefined ||
            typeof candidate.snippet === 'string')
    );
};

const isResponseMetadataPayload = (
    value: unknown
): value is ResponseMetadata => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<ResponseMetadata>;
    const validProvenance =
        candidate.provenance === 'Retrieved' ||
        candidate.provenance === 'Inferred' ||
        candidate.provenance === 'Speculative';
    const validRiskTier =
        candidate.riskTier === 'Low' ||
        candidate.riskTier === 'Medium' ||
        candidate.riskTier === 'High';
    const validCitations =
        Array.isArray(candidate.citations) &&
        candidate.citations.every(isCitationPayload);

    return (
        typeof candidate.responseId === 'string' &&
        validProvenance &&
        validRiskTier &&
        typeof candidate.tradeoffCount === 'number' &&
        Number.isFinite(candidate.tradeoffCount) &&
        validCitations
    );
};

// -----------------------------
// Session lifecycle helpers
// -----------------------------
const sessions = new Map<string, AlternativeLensSessionRecord>();
const alternativeLensInProgress = new Map<string, number>();

const getSessionExpiry = (): number =>
    Date.now() + ALTERNATIVE_LENS_SESSION_TTL_MS;

const getMessageIdFromSessionKey = (sessionKey: string): string =>
    sessionKey.split(':').slice(1).join(':');

const pruneExpiredInProgressEntries = (entries: Map<string, number>): void => {
    const now = Date.now();
    for (const [key, expiresAt] of entries) {
        if (expiresAt <= now) {
            entries.delete(key);
        }
    }
};

const pruneExpiredSessions = (): void => {
    const now = Date.now();
    for (const [sessionKey, record] of sessions) {
        if (record.expiresAt <= now) {
            clearAlternativeLensSession(sessionKey);
        }
    }
};

const pruneExpiredProvenanceInteractionState = (): void => {
    pruneExpiredSessions();
    pruneExpiredInProgressEntries(alternativeLensInProgress);
};

const getSessionRecord = (
    sessionKey: string
): AlternativeLensSessionRecord | undefined => {
    const record = sessions.get(sessionKey);
    if (!record) {
        return undefined;
    }

    if (record.expiresAt <= Date.now()) {
        clearAlternativeLensSession(sessionKey);
        return undefined;
    }

    return record;
};

const refreshSessionExpiry = (sessionKey: string): void => {
    const record = sessions.get(sessionKey);
    if (!record) {
        return;
    }

    record.expiresAt = getSessionExpiry();
};

type ProvenanceInteraction =
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction;

function isMessageWithEdit(candidate: unknown): candidate is Message {
    return (
        !!candidate &&
        typeof (candidate as Message).edit === 'function' &&
        typeof (candidate as Message).id === 'string'
    );
}

// Discord returns 40060 when an interaction token was already acknowledged elsewhere.
function isAlreadyAcknowledgedInteraction(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const { code, message } = error as { code?: number; message?: string };
    return (
        code === 40060 ||
        (typeof message === 'string' &&
            message.includes('Interaction has already been acknowledged'))
    );
}

/**
 * Replies to a provenance interaction and gracefully falls back to follow-up
 * mode when Discord has already acknowledged the token elsewhere.
 */
export async function safeInteractionReply(
    interaction: ProvenanceInteraction,
    options: InteractionReplyOptions,
    logContext: Record<string, unknown>,
    logLabel: string
): Promise<Message | null> {
    // Centralize acknowledgement retries so provenance interactions don't crash on duplicate tokens.
    const payload: InteractionReplyOptions = {
        ...options,
        fetchReply: true,
    };

    const resolveMessage = async (
        response: unknown,
        stage: string
    ): Promise<Message | null> => {
        if (isMessageWithEdit(response)) {
            return response;
        }

        try {
            return (await interaction.fetchReply()) as Message;
        } catch (error) {
            provenanceLogger.warn('Failed to fetch interaction reply message', {
                ...logContext,
                phase: 'fetch_reply_failed',
                stage,
                error,
            });
            return null;
        }
    };

    if (interaction.deferred || interaction.replied) {
        try {
            const response = await interaction.followUp(payload);
            return await resolveMessage(response, 'follow_up');
        } catch (error) {
            provenanceLogger.error(
                'Failed to follow up on acknowledged interaction',
                {
                    ...logContext,
                    phase: 'error',
                    reason: logLabel,
                    error,
                }
            );
            return null;
        }
    }

    try {
        const response = await interaction.reply(payload);
        return await resolveMessage(response, 'reply');
    } catch (error) {
        if (!isAlreadyAcknowledgedInteraction(error)) {
            throw error;
        }

        // Fall back to follow-up when another handler already acknowledged the token.
        provenanceLogger.warn(
            'Interaction already acknowledged; using follow-up',
            {
                ...logContext,
                phase: 'fallback',
                reason: logLabel,
            }
        );
        try {
            const response = await interaction.followUp(payload);
            return await resolveMessage(response, 'fallback_follow_up');
        } catch (followUpError) {
            provenanceLogger.error(
                'Failed to follow up after acknowledgement fallback',
                {
                    ...logContext,
                    phase: 'error',
                    reason: logLabel,
                    error: followUpError,
                }
            );
            return null;
        }
    }
}

/**
 * Resolves the best user-facing display name available from Discord member
 * data.
 */
export function resolveMemberDisplayName(
    member: GuildMember | APIInteractionGuildMember | null | undefined,
    fallback: string
): string {
    if (!member) {
        return fallback;
    }

    if (
        'displayName' in member &&
        typeof member.displayName === 'string' &&
        member.displayName.length > 0
    ) {
        return member.displayName;
    }

    if (
        'nickname' in member &&
        typeof member.nickname === 'string' &&
        member.nickname.length > 0
    ) {
        return member.nickname;
    }

    if (
        'nick' in member &&
        typeof member.nick === 'string' &&
        member.nick.length > 0
    ) {
        return member.nick;
    }

    if (
        'user' in member &&
        member.user &&
        typeof member.user.username === 'string'
    ) {
        return member.user.username;
    }

    return fallback;
}

/**
 * Returns whether an alternative-lens generation is already running for this
 * message.
 */
export function isAlternativeLensInProgress(key: string): boolean {
    pruneExpiredInProgressEntries(alternativeLensInProgress);
    const expiresAt = alternativeLensInProgress.get(key);
    if (!expiresAt) {
        return false;
    }

    if (expiresAt <= Date.now()) {
        alternativeLensInProgress.delete(key);
        return false;
    }

    return true;
}

/**
 * Marks an alternative-lens generation as active.
 */
export function markAlternativeLensInProgress(key: string): void {
    pruneExpiredProvenanceInteractionState();
    alternativeLensInProgress.set(key, getSessionExpiry());
}

/**
 * Clears the in-progress marker for an alternative-lens generation.
 */
export function clearAlternativeLensInProgress(key: string): void {
    alternativeLensInProgress.delete(key);
}

/**
 * Returns a copy of the lens catalogue so callers cannot mutate the shared
 * definitions array.
 */
export function getAlternativeLensDefinitions(): AlternativeLensDefinition[] {
    return LENS_DEFINITIONS.map((definition) => ({ ...definition }));
}

/**
 * Looks up one lens definition by key.
 */
export function getAlternativeLensDefinition(
    key: AlternativeLensKey
): AlternativeLensDefinition | undefined {
    return LENS_DEFINITIONS.find((lens) => lens.key === key);
}

/**
 * Starts a fresh alternative-lens session for a message interaction.
 */
export function createAlternativeLensSession(
    sessionKey: string,
    context: AlternativeLensContext
): AlternativeLensSession {
    pruneExpiredProvenanceInteractionState();
    const session: AlternativeLensSession = {
        context,
        selectedLensKey: null,
        customDescription: null,
    };
    sessions.set(sessionKey, {
        session,
        expiresAt: getSessionExpiry(),
    });
    return session;
}

/**
 * Retrieves a previously created alternative-lens session, if it still exists.
 */
export function getAlternativeLensSession(
    sessionKey: string
): AlternativeLensSession | undefined {
    pruneExpiredSessions();
    return getSessionRecord(sessionKey)?.session;
}

/**
 * Stores the currently selected lens and clears stale custom text when the
 * user switches away from the custom option.
 */
export function setAlternativeLensSelection(
    sessionKey: string,
    lensKey: AlternativeLensKey
): AlternativeLensSession | undefined {
    const record = getSessionRecord(sessionKey);
    if (!record) {
        return undefined;
    }

    const { session } = record;
    session.selectedLensKey = lensKey;
    if (lensKey !== 'CUSTOM') {
        session.customDescription = null;
    }
    refreshSessionExpiry(sessionKey);
    return session;
}

/**
 * Stores the custom lens description for the current session.
 */
export function setAlternativeLensCustomDescription(
    sessionKey: string,
    description: string
): AlternativeLensSession | undefined {
    const record = getSessionRecord(sessionKey);
    if (!record) {
        return undefined;
    }

    const { session } = record;
    session.customDescription = description.trim();
    refreshSessionExpiry(sessionKey);
    return session;
}

/**
 * Deletes the cached alternative-lens session once the flow ends or expires.
 */
export function clearAlternativeLensSession(sessionKey: string): void {
    sessions.delete(sessionKey);
    alternativeLensInProgress.delete(getMessageIdFromSessionKey(sessionKey));
}

/**
 *
 * @param interaction - The Discord component that triggered the event.
 * @param action - The provenance action identifier.
 * @param responseId - Provenance response ID to associate with the metadata.
 * @param extra - Additional context to include in the log entry.
 * @returns - A structured log context object.
 */
function buildAlternativeLensLogContext(
    interaction: LensTelemetryInteraction,
    action: AlternativeLensAction,
    responseId?: string,
    extra?: Record<string, unknown>
): Record<string, unknown> {
    return {
        action,
        userId: interaction.user.id,
        guildId: interaction.guild?.id ?? null,
        channelId: interaction.channelId ?? null,
        messageId: interaction.message.id,
        ...(responseId ? { responseId } : {}),
        ...extra,
    };
}

/**
 * Converts the current session into the payload used for prompt construction.
 */
export function buildLensPayload(session: AlternativeLensSession): {
    key: AlternativeLensKey;
    label: string;
    description: string;
} | null {
    if (!session.selectedLensKey) {
        return null;
    }

    const definition = getAlternativeLensDefinition(session.selectedLensKey);
    if (!definition) {
        return null;
    }

    if (definition.key === 'CUSTOM') {
        if (!session.customDescription) {
            return null;
        }
        return {
            key: definition.key,
            label: definition.label,
            description: session.customDescription,
        };
    }

    return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
    };
}

/**
 * Input needed to generate an alternative-lens rewrite.
 */
export interface AlternativeLensGenerationContext {
    messageText: string;
    metadata: ResponseMetadata | null;
    channelId?: string;
}

/**
 * Finalized lens data passed to generation code after session validation.
 */
export interface AlternativeLensPayload {
    key: AlternativeLensKey;
    label: string;
    description: string;
}

const DEFAULT_ALT_LENS_MODEL: SupportedModel = 'gpt-5-mini';

// -----------------------------
// Lens message generation
// -----------------------------
/**
 * Calls OpenAI to rewrite the original assistant message using the requested lens.
 * Includes provenance metadata so the model can reference trade-offs and citations when useful.
 */
export async function generateAlternativeLensMessage(
    openaiService: OpenAIService,
    context: AlternativeLensGenerationContext,
    lens: AlternativeLensPayload,
    openaiOptions?: OpenAIOptions
): Promise<string> {
    const baseSystemPrompt = renderPromptWithProfileOverlay(
        'discord.chat.system',
        'provenance'
    );
    const systemPromptLines = [
        'You are an ethics editor who rewrites assistant responses using a specified philosophical or cultural lens.',
        'Preserve factual accuracy and original intent while foregrounding the requested perspective.',
        'Respond in natural markdown with no JSON payloads or tool calls.',
    ];
    const metadataSummary = formatMetadataSummary(context.metadata);
    const userPromptSections = [
        `Selected lens: ${lens.label}`,
        `Lens guidance: ${lens.description}`,
        `Provenance summary:\n${metadataSummary}`,
        'Original assistant response:',
        context.messageText,
    ];

    const messages: OpenAIMessage[] = [
        {
            role: 'system',
            content:
                `${baseSystemPrompt}\n\n${systemPromptLines.join(' ')}`.trim(),
        },
        { role: 'user', content: userPromptSections.join('\n\n') },
    ];

    const requestOptions: OpenAIOptions = {
        reasoningEffort: 'low',
        verbosity: 'medium',
        ...(openaiOptions ?? {}),
    };

    const response = await openaiService.generateResponse(
        DEFAULT_ALT_LENS_MODEL,
        messages,
        {
            ...requestOptions,
            channelContext:
                requestOptions.channelContext ??
                (context.channelId
                    ? { channelId: context.channelId, guildId: undefined }
                    : undefined),
        }
    );

    const text = response.message?.content?.trim();
    if (!text) {
        throw new Error(
            'The model returned an empty alternative lens response.'
        );
    }

    return text;
}

type PlannerRequest = {
    kind: 'alternative_lens';
    messageText: string;
    lens: AlternativeLensPayload;
    metadata: ResponseMetadata | null;
};

/**
 * Asks the planner for OpenAI generation options tuned to the provenance
 * follow-up task.
 */
export async function requestProvenanceOpenAIOptions(
    openaiService: OpenAIService,
    request: PlannerRequest
): Promise<OpenAIOptions | undefined> {
    try {
        const planner = new Planner(openaiService);
        const baseSystemPrompt = renderPromptWithProfileOverlay(
            'discord.chat.system',
            'provenance'
        );

        const context: OpenAIMessage[] = [
            { role: 'system', content: baseSystemPrompt },
            { role: 'assistant', content: request.messageText },
        ];

        const instructions: string[] = [
            'A user clicked a provenance control. Recommend OpenAI options (reasoning effort, verbosity, etc.) for the follow-up response.',
        ];

        instructions.push(
            `Task: Reframe the assistant response using the "${request.lens.label}" perspective.`,
            `Lens guidance: ${request.lens.description}`
        );
        if (request.metadata) {
            instructions.push(
                `Provenance metadata:\n${formatMetadataSummary(request.metadata)}`
            );
        }

        context.push({ role: 'user', content: instructions.join('\n\n') });

        const plan = await planner.generatePlan(
            context,
            `provenance-${request.kind}`
        );
        return plan.openaiOptions;
    } catch (error) {
        provenanceLogger.warn(
            'Failed to retrieve planner options for provenance interaction',
            {
                requestKind: request.kind,
                error,
            }
        );
        return undefined;
    }
}

function formatMetadataSummary(metadata: ResponseMetadata | null): string {
    if (!metadata) {
        return 'Metadata unavailable; focus on the lens reinterpretation using the supplied text.';
    }

    const baseLines = [
        `Response ID: ${metadata.responseId}`,
        `Provenance: ${metadata.provenance}`,
        `Risk tier: ${metadata.riskTier}`,
        `Trade-offs noted: ${metadata.tradeoffCount}`,
    ];

    if (metadata.citations.length > 0) {
        const citationSummaries = metadata.citations.map(
            (citation: Citation) => `${citation.title} (${citation.url})`
        );
        baseLines.push(`Citations: ${citationSummaries.join('; ')}`);
    } else {
        baseLines.push('Citations: None supplied by the original response.');
    }

    return baseLines.join('\n');
}

// -----------------------------
// Metadata and message recovery
// -----------------------------
function getComponentCustomId(component: unknown): string | null {
    if (!component || typeof component !== 'object') {
        return null;
    }

    if (typeof (component as { customId?: unknown }).customId === 'string') {
        return (component as { customId: string }).customId;
    }

    if (typeof (component as { custom_id?: unknown }).custom_id === 'string') {
        return (component as { custom_id: string }).custom_id;
    }

    const nestedData = (component as { data?: unknown }).data;
    if (nestedData && typeof nestedData === 'object') {
        if (
            typeof (nestedData as { customId?: unknown }).customId === 'string'
        ) {
            return (nestedData as { customId: string }).customId;
        }

        if (
            typeof (nestedData as { custom_id?: unknown }).custom_id ===
            'string'
        ) {
            return (nestedData as { custom_id: string }).custom_id;
        }
    }

    return null;
}

/**
 * Scans provenance components to recover the responseId encoded in custom IDs.
 */
export function deriveResponseIdFromMessage(
    message: Message | null
): string | null {
    if (!message) {
        return null;
    }

    for (const row of message.components ?? []) {
        const components = (row as { components?: unknown }).components;
        if (!Array.isArray(components)) {
            continue;
        }

        for (const component of components) {
            const customId = getComponentCustomId(component);
            if (!customId) {
                continue;
            }

            const parsed = parseProvenanceActionCustomId(customId);
            if (parsed) {
                return parsed.responseId;
            }
        }
    }

    return null;
}

/**
 * Retrieve provenance metadata for a Discord message by extracting its response identifier from provenance controls and querying the trace service.
 *
 * @param message - The Discord message to inspect for provenance control custom IDs
 * @returns An object with `responseId` when a response identifier was found and `metadata` containing the provenance metadata, or `null` when no metadata is available (no response id found, the trace was removed (HTTP 410), or the lookup failed)
 */
export async function resolveProvenanceMetadata(
    message: Message
): Promise<{ responseId?: string; metadata: ResponseMetadata | null }> {
    const responseId = deriveResponseIdFromMessage(message);
    if (!responseId) {
        return { metadata: null };
    }

    try {
        const response = await botApi.getTrace(responseId);
        if (response.status === 410) {
            provenanceLogger.warn(
                'Failed to load provenance metadata: trace stale',
                {
                    responseId,
                    status: 410,
                }
            );
            return { responseId, metadata: null };
        }
        if (!isResponseMetadataPayload(response.data)) {
            provenanceLogger.warn(
                'Failed to load provenance metadata: invalid payload shape',
                {
                    responseId,
                    status: response.status,
                    payload: response.data,
                }
            );
            return { responseId, metadata: null };
        }
        const metadata = response.data;
        return { responseId, metadata };
    } catch (error) {
        provenanceLogger.warn('Failed to load provenance metadata', {
            responseId,
            error,
        });
        return { responseId, metadata: null };
    }
}

// Resolve the response message for provenance buttons.
/**
 * Finds the message chunk that should be treated as the response anchor for a
 * provenance action.
 */
export async function resolveResponseAnchorMessage(
    message: Message
): Promise<Message | null> {
    // If the button-bearing message carries content, use it directly.
    const directContent = message.content?.trim();
    if (directContent) {
        return message;
    }

    // If the controls were sent as a reply, use the replied message as anchor.
    const referencedId = message.reference?.messageId;
    if (referencedId && message.channel.isTextBased()) {
        try {
            const referenced =
                await message.channel.messages.fetch(referencedId);
            if (referenced) {
                return referenced;
            }
        } catch (error) {
            provenanceLogger.warn(
                `Failed to fetch referenced message ${referencedId} while resolving provenance anchor:`,
                error
            );
        }
    }

    if (!message.channel.isTextBased()) {
        provenanceLogger.warn(
            'Failed to resolve provenance anchor message: Channel is not text-based'
        );
        return null;
    }

    const botId = message.client.user?.id;
    if (!botId) {
        provenanceLogger.warn(
            'Failed to resolve provenance anchor message: Bot ID not found'
        );
        return null;
    }

    try {
        // Fetch previous messages before the current message
        const previousMessages = await message.channel.messages.fetch({
            before: message.id,
            limit: MAX_PRECEDING_RESPONSE_MESSAGES,
        });
        // Sort the messages by created timestamp in descending order
        const ordered = Array.from(previousMessages.values()).sort(
            (a, b) => b.createdTimestamp - a.createdTimestamp
        );
        // Iterate through the messages in descending order of creation timestamp
        for (const candidate of ordered) {
            // Only stitch messages immediately above controls to avoid unrelated outputs.
            if (candidate.author.id !== botId) {
                break;
            }

            // Stop at embedded/components to avoid unrelated interactive prompts.
            if (
                (candidate.embeds?.length ?? 0) > 0 ||
                (candidate.components?.length ?? 0) > 0
            ) {
                break;
            }

            if (candidate.content?.trim()) {
                return candidate;
            }
        }
    } catch (error) {
        provenanceLogger.warn(
            `Failed to fetch recent messages while resolving provenance anchor:`,
            error
        );
    }

    return null;
}

/**
 * Rebuilds the full assistant response text by stitching together adjacent bot
 * message chunks when the original reply was split.
 */
export async function recoverFullMessageText(
    message: Message,
    anchorMessage?: Message | null
): Promise<string> {
    // Use the resolved anchor to reconstruct the full response, even when split across messages.
    const anchor =
        anchorMessage ?? (await resolveResponseAnchorMessage(message));
    if (!anchor) {
        return '';
    }

    const botId = message.client.user?.id;
    if (!botId) {
        return anchor.content?.trim() ?? '';
    }

    const chunks: string[] = [];
    const anchorContent = anchor.content?.trim();
    if (anchorContent) {
        chunks.unshift(anchorContent);
    }

    // If the anchor is already a direct reply (single-chunk response), avoid merging earlier bot messages.
    if (anchor.reference?.messageId && chunks.length > 0) {
        return chunks.join('\n\n').trim();
    }

    if (!message.channel.isTextBased()) {
        return chunks.join('\n\n').trim();
    }

    try {
        const previousMessages = await message.channel.messages.fetch({
            before: anchor.id,
            limit: MAX_PRECEDING_RESPONSE_MESSAGES,
        });
        const ordered = Array.from(previousMessages.values()).sort(
            (a, b) => b.createdTimestamp - a.createdTimestamp
        );

        for (const candidate of ordered) {
            // Stop at the first non-bot or non-content message to keep the stitched response scoped.
            if (candidate.author.id !== botId) {
                break;
            }

            if (
                (candidate.embeds?.length ?? 0) > 0 ||
                (candidate.components?.length ?? 0) > 0
            ) {
                break;
            }

            const content = candidate.content?.trim();
            if (!content) {
                break;
            }

            // Bound by time to avoid stitching unrelated replies during slow or interleaved chatter.
            if (
                anchor.createdTimestamp - candidate.createdTimestamp >
                MAX_RESPONSE_CHAIN_WINDOW_MS
            ) {
                break;
            }

            chunks.unshift(content);

            // Once we reach the reply-bearing chunk, stop to avoid pulling older bot messages.
            if (candidate.reference?.messageId) {
                break;
            }
        }
    } catch (error) {
        provenanceLogger.warn(
            `Failed to recover previous response chunks for provenance actions:`,
            error
        );
    }

    return chunks.join('\n\n').trim();
}

// -----------------------------
// Interaction handlers
// -----------------------------
/**
 * Starts the alternative-lens flow by capturing the source response and
 * showing the private lens picker UI.
 */
export async function handleAlternativeLensButton(
    interaction: ButtonInteraction
): Promise<void> {
    const baseContext = buildAlternativeLensLogContext(
        interaction,
        'alt_lens:init'
    );
    let telemetryContext = baseContext;
    let sessionKey: string | null = null;
    provenanceLogger.info('Alternative lens init started', {
        ...telemetryContext,
        phase: 'start',
    });

    try {
        const anchorMessage = await resolveResponseAnchorMessage(
            interaction.message
        );
        const messageText = await recoverFullMessageText(
            interaction.message,
            anchorMessage
        );
        if (!messageText) {
            provenanceLogger.error(
                'Alternative lens init failed (missing message text)',
                {
                    ...telemetryContext,
                    phase: 'error',
                    reason: 'missing_message_text',
                }
            );
            await safeInteractionReply(
                interaction,
                {
                    content:
                        'I could not find the response text to reinterpret. Please try again from the original message.',
                    flags: [1 << 6],
                },
                telemetryContext,
                'alt_lens_missing_text'
            );
            return;
        }

        // Prime session state with the text + metadata snapshot from the original response.
        const { responseId, metadata } = await resolveProvenanceMetadata(
            interaction.message
        );
        if (responseId) {
            telemetryContext = buildAlternativeLensLogContext(
                interaction,
                'alt_lens:init',
                responseId
            );
        }
        sessionKey = buildAlternativeLensSessionKey(
            interaction.user.id,
            interaction.message.id
        );
        clearAlternativeLensSession(sessionKey);
        createAlternativeLensSession(sessionKey, {
            messageText,
            metadata,
            messageId: anchorMessage?.id ?? interaction.message.id,
            channelId: interaction.message.channelId,
            responseId,
        });

        const selectOptions = getAlternativeLensDefinitions();
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(
                `${ALTERNATIVE_LENS_SELECT_PREFIX}${interaction.message.id}`
            )
            .setPlaceholder('Choose a lens')
            .addOptions(
                selectOptions.map((option) =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(option.label)
                        .setValue(option.key)
                        .setDescription(
                            option.description.length > 100
                                ? `${option.description.slice(0, 97)}...`
                                : option.description
                        )
                )
            );

        const selectRow =
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                selectMenu
            );
        const submitRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `${ALTERNATIVE_LENS_SUBMIT_PREFIX}${interaction.message.id}`
                )
                .setLabel('Submit')
                .setStyle(ButtonStyle.Primary)
        );

        await safeInteractionReply(
            interaction,
            {
                content:
                    'Pick a perspective to reframe this answer. Selecting "Custom Lens" will prompt for details.',
                components: [selectRow, submitRow],
                flags: [1 << 6],
            },
            telemetryContext,
            'alt_lens_prompt'
        );
        provenanceLogger.info('Alternative lens init completed', {
            ...telemetryContext,
            phase: 'success',
        });
    } catch (error) {
        provenanceLogger.error('Alternative lens init error', {
            ...telemetryContext,
            phase: 'error',
            reason: 'initialisation_failed',
            error,
        });
        if (sessionKey) {
            clearAlternativeLensSession(sessionKey);
        }
        const replyOptions: InteractionReplyOptions = {
            content:
                'Something went wrong while starting the alternative lens flow. Please try again later.',
            flags: [1 << 6],
        };

        await safeInteractionReply(
            interaction,
            replyOptions,
            telemetryContext,
            'alt_lens_error_reply'
        ).catch(() => undefined);
    }
}

/**
 * Stores the user's selected lens and opens the custom-lens modal when needed.
 */
export async function handleAlternativeLensSelect(
    interaction: StringSelectMenuInteraction
): Promise<void> {
    const baseContext = buildAlternativeLensLogContext(
        interaction,
        'alt_lens:select'
    );
    let telemetryContext = baseContext;
    provenanceLogger.info('Alternative lens select started', {
        ...telemetryContext,
        phase: 'start',
    });

    try {
        const { customId, values } = interaction;
        const selected = values?.[0];

        if (!selected) {
            provenanceLogger.error(
                'Alternative lens select failed (no selection)',
                {
                    ...telemetryContext,
                    phase: 'error',
                    reason: 'no_selection',
                }
            );
            await interaction.deferUpdate();
            return;
        }

        const messageId = customId.slice(ALTERNATIVE_LENS_SELECT_PREFIX.length);
        const lensDefinition = getAlternativeLensDefinition(
            selected as AlternativeLensKey
        );

        if (!lensDefinition) {
            provenanceLogger.error(
                'Alternative lens select failed (unknown lens)',
                {
                    ...telemetryContext,
                    phase: 'error',
                    reason: 'unknown_lens',
                    lensKey: selected,
                }
            );
            await interaction.reply({
                content:
                    'That lens is no longer available. Please choose a different option.',
                flags: [1 << 6],
            });
            return;
        }

        const sessionKey = buildAlternativeLensSessionKey(
            interaction.user.id,
            messageId
        );
        const session = setAlternativeLensSelection(
            sessionKey,
            lensDefinition.key
        );
        if (!session) {
            provenanceLogger.error(
                'Alternative lens select failed (session expired)',
                {
                    ...telemetryContext,
                    phase: 'error',
                    reason: 'session_expired',
                    lensKey: lensDefinition.key,
                }
            );
            await interaction.reply({
                content:
                    'That alternative lens session expired. Click **Alternative Lens** again to restart.',
                flags: [1 << 6],
            });
            return;
        }

        if (session.context.responseId) {
            telemetryContext = buildAlternativeLensLogContext(
                interaction,
                'alt_lens:select',
                session.context.responseId
            );
        }

        if (lensDefinition.requiresCustomDescription) {
            const input = new TextInputBuilder()
                .setCustomId(ALT_LENS_CUSTOM_DESCRIPTION_INPUT_ID)
                .setLabel('Describe the custom lens')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Explain the perspective you want to apply.')
                .setMinLength(10)
                .setMaxLength(500);

            if (session.customDescription) {
                input.setValue(session.customDescription);
            }

            const modal = new ModalBuilder()
                .setCustomId(`${ALTERNATIVE_LENS_MODAL_PREFIX}${messageId}`)
                .setTitle('Custom Lens Details')
                .addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        input
                    )
                );

            await interaction.showModal(modal);
            provenanceLogger.info('Alternative lens select completed', {
                ...telemetryContext,
                phase: 'success',
                lensKey: lensDefinition.key,
                mode: 'modal_prompt',
            });
            return;
        }

        await interaction.deferUpdate();
        provenanceLogger.info('Alternative lens select completed', {
            ...telemetryContext,
            phase: 'success',
            lensKey: lensDefinition.key,
        });
    } catch (error) {
        provenanceLogger.error('Alternative lens select error', {
            ...telemetryContext,
            phase: 'error',
            reason: 'selection_failed',
            error,
        });
        if (!interaction.deferred && !interaction.replied) {
            await interaction
                .reply({
                    content:
                        'Something went wrong while updating the alternative lens selection. Please try again later.',
                    flags: [1 << 6],
                })
                .catch(() => undefined);
        }
    }
}

/**
 * Saves the free-form custom lens description submitted through the modal.
 */
export async function handleAlternativeLensModal(
    interaction: ModalSubmitInteraction
): Promise<void> {
    const messageId = interaction.customId.slice(
        ALTERNATIVE_LENS_MODAL_PREFIX.length
    );
    const sessionKey = buildAlternativeLensSessionKey(
        interaction.user.id,
        messageId
    );
    const session = getAlternativeLensSession(sessionKey);

    if (!session) {
        await interaction.reply({
            content:
                'That alternative lens session expired. Click **Alternative Lens** again to restart.',
            flags: [1 << 6],
        });
        return;
    }

    const description = interaction.fields
        .getTextInputValue(ALT_LENS_CUSTOM_DESCRIPTION_INPUT_ID)
        .trim();
    if (!description) {
        await interaction.reply({
            content: 'Please describe your custom lens before submitting.',
            flags: [1 << 6],
        });
        return;
    }

    setAlternativeLensSelection(sessionKey, 'CUSTOM');
    setAlternativeLensCustomDescription(sessionKey, description);
    await interaction.reply({
        content:
            'Custom lens saved. Press Submit when you are ready to generate the alternative perspective.',
        flags: [1 << 6],
    });
}

/**
 * Validates the saved session, generates the alternative-lens response, and
 * posts it back into the channel.
 */
export async function handleAlternativeLensSubmit(
    interaction: ButtonInteraction,
    openaiService: OpenAIService
): Promise<void> {
    const baseContext = buildAlternativeLensLogContext(
        interaction,
        'alt_lens:submit'
    );
    let telemetryContext = baseContext;
    provenanceLogger.info('Alternative lens submit started', {
        ...telemetryContext,
        phase: 'start',
    });

    const messageId = interaction.customId.slice(
        ALTERNATIVE_LENS_SUBMIT_PREFIX.length
    );
    const sessionKey = buildAlternativeLensSessionKey(
        interaction.user.id,
        messageId
    );
    const session = getAlternativeLensSession(sessionKey);

    if (!session) {
        provenanceLogger.error(
            'Alternative lens submit failed (session expired)',
            {
                ...telemetryContext,
                phase: 'error',
                reason: 'session_expired',
            }
        );
        await interaction.reply({
            content:
                'That alternative lens session expired. Click **Alternative Lens** again to start over.',
            flags: [1 << 6],
        });
        return;
    }

    if (session.context.responseId) {
        telemetryContext = buildAlternativeLensLogContext(
            interaction,
            'alt_lens:submit',
            session.context.responseId
        );
    }

    if (!session.context.messageText) {
        clearAlternativeLensSession(sessionKey);
        provenanceLogger.error(
            'Alternative lens submit failed (missing message text)',
            {
                ...telemetryContext,
                phase: 'error',
                reason: 'missing_message_text',
            }
        );
        await interaction.reply({
            content:
                'The original response is no longer available for reinterpretation. Start a new alternative lens request.',
            flags: [1 << 6],
        });
        return;
    }

    const lens = buildLensPayload(session);
    if (!lens) {
        provenanceLogger.error(
            'Alternative lens submit failed (lens not selected)',
            {
                ...telemetryContext,
                phase: 'error',
                reason: 'missing_lens',
            }
        );
        await interaction.reply({
            content:
                'Select a lens first. If you choose Custom Lens, provide a description before submitting.',
            flags: [1 << 6],
        });
        return;
    }

    if (isAlternativeLensInProgress(messageId)) {
        provenanceLogger.error(
            'Alternative lens submit failed (already in progress)',
            {
                ...telemetryContext,
                phase: 'error',
                reason: 'in_progress',
            }
        );
        await interaction.reply({
            content:
                '⚠️ An alternative lens is already being generated for this response. Please wait for it to finish.',
            flags: [1 << 6],
        });
        return;
    }

    markAlternativeLensInProgress(messageId);

    const requester = resolveMemberDisplayName(
        interaction.member,
        interaction.user.username
    );
    const lensDescription = lens.description?.trim() ?? '';
    const lensDetails = lensDescription ? `\n> ${lensDescription}` : '';
    const progressContent = `⏳ Alternative lens requested by **${requester}** — **${lens.label}**${lensDetails}\nGenerating response…`;

    try {
        await interaction.reply({
            content: progressContent,
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        clearAlternativeLensSession(sessionKey);
        clearAlternativeLensInProgress(messageId);
        provenanceLogger.error(
            'Alternative lens submit failed (acknowledgement error)',
            {
                ...telemetryContext,
                phase: 'error',
                reason: 'ack_failed',
                error,
            }
        );
        if (!interaction.replied) {
            await interaction
                .followUp({
                    content:
                        'I could not begin generating that alternative lens. Please try again.',
                    flags: [1 << 6],
                })
                .catch(() => undefined);
        }
        return;
    }

    try {
        const plannerOptions = await requestProvenanceOpenAIOptions(
            openaiService,
            {
                kind: 'alternative_lens',
                messageText: session.context.messageText,
                lens,
                metadata: session.context.metadata,
            }
        );

        const generated = await generateAlternativeLensMessage(
            openaiService,
            {
                messageText: session.context.messageText,
                metadata: session.context.metadata,
                channelId: session.context.channelId,
            },
            lens,
            plannerOptions
        );

        const channel = interaction.channel;
        if (!channel || !channel.isSendable()) {
            provenanceLogger.error(
                'Alternative lens submit failed (unsendable channel)',
                {
                    ...telemetryContext,
                    phase: 'error',
                    reason: 'unsendable_channel',
                }
            );
            await interaction.editReply({
                content:
                    'I could not post the alternative lens response in this channel.',
            });
            return;
        }

        const customNote =
            lens.key === 'CUSTOM' && lensDescription
                ? `\n> Custom guidance: ${lensDescription}`
                : '';
        const combinedContent = `**Alternative Lens: ${lens.label}**${customNote}\n\n${generated.trim()}`;
        let targetMessage: Message | null = null;

        if (channel.isTextBased()) {
            try {
                targetMessage = await channel.messages.fetch(
                    session.context.messageId
                );
            } catch (fetchError) {
                provenanceLogger.warn(
                    `Failed to fetch original message ${session.context.messageId} for alternative lens reply:`,
                    fetchError
                );
            }
        }

        if (targetMessage) {
            const responseHandler = new ResponseHandler(
                targetMessage,
                channel,
                interaction.user
            );
            await responseHandler.sendMessage(combinedContent, [], true, true);
        } else {
            // If the original message cannot be fetched, fall back to responding directly to the interaction message.
            const fallbackHandler = new ResponseHandler(
                interaction.message as Message,
                channel,
                interaction.user
            );
            await fallbackHandler.sendMessage(combinedContent, [], true, true);
        }

        const completionSummary = lensDescription
            ? `✅ Posted alternative lens (${lens.label} — ${lensDescription}).`
            : `✅ Posted alternative lens (${lens.label}).`;
        await interaction.editReply({ content: completionSummary });
        provenanceLogger.info('Alternative lens submit completed', {
            ...telemetryContext,
            phase: 'success',
            lensKey: lens.key,
        });
    } catch (error) {
        provenanceLogger.error('Alternative lens submit error', {
            ...telemetryContext,
            phase: 'error',
            reason: 'generation_failed',
            error,
        });
        await interaction.editReply({
            content:
                'I could not generate that alternative lens. Please try again later.',
        });
    } finally {
        clearAlternativeLensSession(sessionKey);
        clearAlternativeLensInProgress(messageId);
    }
}
