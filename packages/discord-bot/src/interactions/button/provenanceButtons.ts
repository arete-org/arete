/**
 * @description: Handles provenance-related button actions including details lookup and incident report launch.
 * @footnote-scope: core
 * @footnote-module: ProvenanceButtonHandlers
 * @footnote-risk: high - Bad metadata parsing can hide trace details or crash details rendering.
 * @footnote-ethics: high - Provenance details and reporting actions directly affect transparency and accountability.
 */
import type { ButtonInteraction } from 'discord.js';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { ResponseMetadataSchema } from '@footnote/contracts/web/schemas';
import { botApi } from '../../api/botApi.js';
import { logger } from '../../utils/logger.js';
import { parseProvenanceActionCustomId } from '../../utils/response/provenanceCgi.js';
import { handleIncidentReportButton } from '../../utils/response/incidentReporting.js';
import { EPHEMERAL_FLAG } from './shared.js';

const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DETAILS_CODE_FENCE_PREFIX = '```json\n';
const DETAILS_CODE_FENCE_SUFFIX = '\n```';
const DETAILS_TRUNCATION_SUFFIX = '\n... (truncated)';
const DETAILS_FALLBACK_REASON = 'metadata_unavailable';

type DetailsFallbackPayload = {
    responseId: string | null;
    metadata: null;
    reason: typeof DETAILS_FALLBACK_REASON;
};

/**
 * Builds a safe fallback shape for provenance details when trace lookup fails.
 * This keeps the details button stable even when backend trace retrieval errors.
 */
function buildDetailsPayload(
    responseId: string | undefined,
    metadata: ResponseMetadata | null
): ResponseMetadata | DetailsFallbackPayload {
    if (metadata) {
        return metadata;
    }

    return {
        responseId: responseId ?? null,
        metadata: null,
        reason: DETAILS_FALLBACK_REASON,
    };
}

/**
 * Narrow runtime guard for plain object payloads.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

/**
 * Validates unknown trace payloads before we render them in Discord.
 */
function isValidResponseMetadataPayload(
    payload: unknown
): ResponseMetadata | null {
    const parsed = ResponseMetadataSchema.safeParse(payload);
    if (!parsed.success) {
        return null;
    }

    return parsed.data as ResponseMetadata;
}

/**
 * Supports both direct metadata responses and wrapped `{ metadata }` responses
 * so the UI stays resilient across backend shape differences.
 */
function extractMetadataFromTraceResponse(
    payload: unknown
): ResponseMetadata | null {
    const directMetadata = isValidResponseMetadataPayload(payload);
    if (directMetadata) {
        return directMetadata;
    }

    if (isPlainObject(payload) && 'metadata' in payload) {
        return isValidResponseMetadataPayload(
            (payload as { metadata?: unknown }).metadata
        );
    }

    return null;
}

/**
 * Keeps citation and temperament entries compact when rendering JSON previews
 * in Discord's 2,000 character message limit.
 */
function formatInlineJsonObject(value: Record<string, unknown>): string {
    const entries = Object.entries(value).filter(
        ([, entryValue]) => entryValue !== undefined
    );
    const serializedEntries = entries.map(
        ([entryKey, entryValue]) =>
            `${JSON.stringify(entryKey)}: ${JSON.stringify(entryValue)}`
    );
    return `{ ${serializedEntries.join(', ')} }`;
}

/**
 * Serializes metadata in a predictable order/shape for the details button.
 * We keep this custom serializer so large citation arrays stay readable.
 */
function serializeDetailsPayload(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    if (!('provenance' in payload)) {
        return JSON.stringify(payload, null, 2);
    }

    const lines: string[] = ['{'];
    const entries = Object.entries(payload).filter(
        ([, value]) => value !== undefined
    );

    for (let index = 0; index < entries.length; index += 1) {
        const [key, value] = entries[index];
        const hasTrailingComma = index < entries.length - 1;
        const trailingComma = hasTrailingComma ? ',' : '';

        if (key === 'citations' && Array.isArray(value)) {
            lines.push('  "citations": [');
            for (
                let citationIndex = 0;
                citationIndex < value.length;
                citationIndex += 1
            ) {
                const citation = value[citationIndex];
                const citationComma =
                    citationIndex < value.length - 1 ? ',' : '';
                if (isPlainObject(citation)) {
                    lines.push(
                        `    ${formatInlineJsonObject(citation)}${citationComma}`
                    );
                } else {
                    lines.push(
                        `    ${JSON.stringify(citation)}${citationComma}`
                    );
                }
            }
            lines.push(`  ]${trailingComma}`);
            continue;
        }

        if (key === 'temperament' && isPlainObject(value)) {
            lines.push(
                `  "temperament": ${formatInlineJsonObject(value)}${trailingComma}`
            );
            continue;
        }

        lines.push(
            `  ${JSON.stringify(key)}: ${JSON.stringify(value)}${trailingComma}`
        );
    }

    lines.push('}');
    return lines.join('\n');
}

/**
 * Wraps details payload in a code fence and truncates when needed so we do not
 * exceed Discord's hard message-length cap.
 */
function formatDetailsPayloadForDiscord(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    const serialized = serializeDetailsPayload(payload);
    const maxPayloadLength =
        DISCORD_MESSAGE_MAX_LENGTH -
        DETAILS_CODE_FENCE_PREFIX.length -
        DETAILS_CODE_FENCE_SUFFIX.length;

    if (serialized.length <= maxPayloadLength) {
        return `${DETAILS_CODE_FENCE_PREFIX}${serialized}${DETAILS_CODE_FENCE_SUFFIX}`;
    }

    const truncatedPayloadLength = Math.max(
        0,
        maxPayloadLength - DETAILS_TRUNCATION_SUFFIX.length
    );
    const truncatedPayload = `${serialized.slice(0, truncatedPayloadLength)}${DETAILS_TRUNCATION_SUFFIX}`;
    return `${DETAILS_CODE_FENCE_PREFIX}${truncatedPayload}${DETAILS_CODE_FENCE_SUFFIX}`;
}

/**
 * @description: Routes provenance button interactions for details lookup and incident report actions.
 * @footnote-scope: core
 * @footnote-module: HandleProvenanceButtonInteraction
 * @footnote-risk: high - Incorrect routing or reply handling can hide trace details or break report workflows.
 * @footnote-ethics: high - Provenance and reporting controls directly affect transparency and accountability for users.
 */
export async function handleProvenanceButtonInteraction(
    interaction: ButtonInteraction
): Promise<boolean> {
    const provenanceAction = parseProvenanceActionCustomId(interaction.customId);
    if (!provenanceAction) {
        return false;
    }

    if (provenanceAction.action === 'details') {
        await interaction.deferReply({
            flags: [EPHEMERAL_FLAG],
        });
        let metadata: ResponseMetadata | null = null;
        try {
            const traceResponse = await botApi.getTrace(provenanceAction.responseId);
            metadata = extractMetadataFromTraceResponse(traceResponse.data);
        } catch (error) {
            logger.warn('Failed to load provenance metadata for details action', {
                responseId: provenanceAction.responseId,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        const detailsPayload = buildDetailsPayload(
            provenanceAction.responseId,
            metadata
        );
        await interaction.editReply({
            content: formatDetailsPayloadForDiscord(detailsPayload),
        });
        return true;
    }

    if (provenanceAction.action === 'report_issue') {
        await handleIncidentReportButton(interaction);
        return true;
    }

    return false;
}
