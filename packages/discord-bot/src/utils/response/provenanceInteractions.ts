/**
 * @description: Shared provenance helper functions used by Discord incident reporting and image follow-ups.
 * @footnote-scope: interface
 * @footnote-module: ProvenanceInteractions
 * @footnote-risk: medium - Broken response-id recovery or anchor resolution can block provenance lookups and incident reporting.
 * @footnote-ethics: high - These helpers control how users reach trace details and report issues, so they need predictable fail-open behavior.
 */
import type {
    APIInteractionGuildMember,
    GuildMember,
    Message,
} from 'discord.js';
import type {
    Citation,
    ResponseMetadata,
} from '@footnote/contracts/ethics-core';
import { botApi } from '../../api/botApi.js';
import { logger } from '../logger.js';
import { parseProvenanceActionCustomId } from './provenanceCgi.js';

const provenanceLogger = logger.child({ module: 'provenance' });
const MAX_PRECEDING_RESPONSE_MESSAGES = 16;

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
    const validSafetyTier =
        candidate.safetyTier === 'Low' ||
        candidate.safetyTier === 'Medium' ||
        candidate.safetyTier === 'High';
    const validCitations =
        Array.isArray(candidate.citations) &&
        candidate.citations.every(isCitationPayload);

    return (
        typeof candidate.responseId === 'string' &&
        validProvenance &&
        validSafetyTier &&
        typeof candidate.tradeoffCount === 'number' &&
        Number.isFinite(candidate.tradeoffCount) &&
        validCitations
    );
};

const getComponentCustomId = (component: unknown): string | null => {
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
};

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
 * Loads stored provenance metadata for a Discord message when the message
 * still carries TRACE controls with a recoverable response ID.
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
                    payloadKeys:
                        response.data &&
                        typeof response.data === 'object' &&
                        !Array.isArray(response.data)
                            ? Object.keys(response.data)
                            : [],
                }
            );
            return { responseId, metadata: null };
        }

        if (response.data.responseId !== responseId) {
            provenanceLogger.warn(
                'Failed to load provenance metadata: mismatched responseId',
                {
                    responseId,
                    status: response.status,
                    payloadKeys:
                        response.data &&
                        typeof response.data === 'object' &&
                        !Array.isArray(response.data)
                            ? Object.keys(response.data)
                            : [],
                }
            );
            return { responseId, metadata: null };
        }

        return {
            responseId,
            metadata: response.data,
        };
    } catch (error) {
        provenanceLogger.warn('Failed to load provenance metadata', {
            responseId,
            error,
        });
        return { responseId, metadata: null };
    }
}

/**
 * Finds the message chunk that should be treated as the response anchor for a
 * provenance action.
 */
export async function resolveResponseAnchorMessage(
    message: Message
): Promise<Message | null> {
    const directContent = message.content?.trim();
    if (directContent) {
        return message;
    }

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
        const previousMessages = await message.channel.messages.fetch({
            before: message.id,
            limit: MAX_PRECEDING_RESPONSE_MESSAGES,
        });
        const ordered = Array.from(previousMessages.values()).sort(
            (a, b) => b.createdTimestamp - a.createdTimestamp
        );

        for (const candidate of ordered) {
            if (candidate.author.id !== botId) {
                break;
            }

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
            'Failed to fetch recent messages while resolving provenance anchor:',
            error
        );
    }

    return null;
}
