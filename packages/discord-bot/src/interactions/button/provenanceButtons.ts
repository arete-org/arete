/**
 * @description: Handles provenance-related button actions including details lookup and incident report launch.
 * @footnote-scope: core
 * @footnote-module: ProvenanceButtonHandlers
 * @footnote-risk: high - Bad metadata parsing can hide trace details or crash details rendering.
 * @footnote-ethics: high - Provenance details and reporting actions directly affect transparency and accountability.
 */
import type { ButtonInteraction } from 'discord.js';
import {
    formatExecutionTimelineSummary,
    type ExecutionEvent,
    type ResponseMetadata,
} from '@footnote/contracts/ethics-core';
import { ResponseMetadataSchema } from '@footnote/contracts/web/schemas';
import { botApi } from '../../api/botApi.js';
import { logger } from '../../utils/logger.js';
import { parseProvenanceActionCustomId } from '../../utils/response/provenanceCgi.js';
import { handleIncidentReportButton } from '../../utils/response/incidentReporting.js';
import { EPHEMERAL_FLAG } from './shared.js';

const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DETAILS_SECTION_SEPARATOR = '\n\n';
const DETAILS_CODE_FENCE_PREFIX = '```json\n';
const DETAILS_CODE_FENCE_SUFFIX = '\n```';
const DETAILS_TRUNCATION_SUFFIX = '\n... (truncated)';
const DETAILS_FALLBACK_REASON = 'metadata_unavailable';
const DETAILS_INLINE_FIELD_LIMIT = 120;
const DETAILS_CITATION_LIMIT = 4;
const DETAILS_EXECUTION_EVENT_LIMIT = 5;

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

function truncateInline(value: string, limit: number): string {
    if (value.length <= limit) {
        return value;
    }

    if (limit <= 3) {
        return value.slice(0, Math.max(0, limit));
    }

    return `${value.slice(0, limit - 3)}...`;
}

function formatMarkdownValue(
    value: string | number | null | undefined,
    limit = DETAILS_INLINE_FIELD_LIMIT
): string {
    if (value === null || value === undefined) {
        return 'n/a';
    }

    const normalized = String(value).replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return 'n/a';
    }

    return truncateInline(normalized.replace(/`/g, "'"), limit);
}

function formatSummarySection(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    if (!('provenance' in payload)) {
        return [
            '**Summary**',
            `- Response ID: \`${formatMarkdownValue(payload.responseId)}\``,
            '- Provenance metadata: unavailable',
            `- Reason: \`${payload.reason}\``,
        ].join('\n');
    }

    return [
        '**Summary**',
        `- Response ID: \`${formatMarkdownValue(payload.responseId)}\``,
        `- Provenance: \`${formatMarkdownValue(payload.provenance)}\``,
        `- Risk Tier: \`${formatMarkdownValue(payload.riskTier)}\``,
        `- Tradeoffs: \`${formatMarkdownValue(payload.tradeoffCount)}\``,
        `- Model: \`${formatMarkdownValue(payload.modelVersion)}\``,
        `- Stale After: \`${formatMarkdownValue(payload.staleAfter)}\``,
    ].join('\n');
}

function formatTraceSection(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    if (!('provenance' in payload)) {
        return ['**TRACE**', '- TRACE scores unavailable'].join('\n');
    }

    const temperament = payload.temperament;
    return [
        '**TRACE**',
        `- Tightness: \`${formatMarkdownValue(temperament?.tightness)}\``,
        `- Rationale: \`${formatMarkdownValue(temperament?.rationale)}\``,
        `- Attribution: \`${formatMarkdownValue(temperament?.attribution)}\``,
        `- Caution: \`${formatMarkdownValue(temperament?.caution)}\``,
        `- Extent: \`${formatMarkdownValue(temperament?.extent)}\``,
        `- Evidence: \`${formatMarkdownValue(payload.evidenceScore)}\``,
        `- Freshness: \`${formatMarkdownValue(payload.freshnessScore)}\``,
    ].join('\n');
}

function formatSourcesSection(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    if (!('provenance' in payload)) {
        return ['**Sources**', '- Source metadata unavailable'].join('\n');
    }

    if (!payload.citations.length) {
        return ['**Sources**', '- No citations recorded'].join('\n');
    }

    const lines = ['**Sources**'];
    const citationCount = Math.min(
        payload.citations.length,
        DETAILS_CITATION_LIMIT
    );
    for (let index = 0; index < citationCount; index += 1) {
        const citation = payload.citations[index];
        const title = formatMarkdownValue(citation.title, 70);
        const url = formatMarkdownValue(citation.url, 140);
        lines.push(`${index + 1}. [${title}](${url})`);
    }

    if (payload.citations.length > citationCount) {
        lines.push(
            `- ...and ${payload.citations.length - citationCount} more source(s)`
        );
    }

    return lines.join('\n');
}

function formatExecutionEventLine(event: ExecutionEvent): string {
    const identity =
        event.kind === 'tool'
            ? formatMarkdownValue(event.toolName, 40)
            : formatMarkdownValue(
                  event.model ??
                      event.effectiveProfileId ??
                      event.profileId ??
                      event.originalProfileId ??
                      event.provider,
                  40
              );
    const reason =
        event.status !== 'executed' && event.reasonCode
            ? `, ${formatMarkdownValue(event.reasonCode, 60)}`
            : '';
    const duration =
        event.durationMs !== undefined ? `, ${event.durationMs}ms` : '';
    return `- ${event.kind}:${identity} (${event.status}${reason}${duration})`;
}

function formatExecutionSection(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    if (!('provenance' in payload)) {
        return ['**Execution**', '- Execution metadata unavailable'].join('\n');
    }

    const lines = ['**Execution**'];
    const summary = formatExecutionTimelineSummary(payload.execution);
    if (summary) {
        lines.push(`- Timeline: \`${formatMarkdownValue(summary, 180)}\``);
    } else {
        lines.push('- Timeline: unavailable');
    }

    if (!payload.execution?.length) {
        lines.push('- Events: none');
        return lines.join('\n');
    }

    const executedCount = payload.execution.filter(
        (event) => event.status === 'executed'
    ).length;
    const skippedCount = payload.execution.filter(
        (event) => event.status === 'skipped'
    ).length;
    const failedCount = payload.execution.filter(
        (event) => event.status === 'failed'
    ).length;
    lines.push(
        `- Status counts: executed=${executedCount}, skipped=${skippedCount}, failed=${failedCount}`
    );
    if (payload.totalDurationMs !== undefined) {
        lines.push(`- Total duration: ${payload.totalDurationMs}ms`);
    }

    const eventCount = Math.min(
        payload.execution.length,
        DETAILS_EXECUTION_EVENT_LIMIT
    );
    for (let index = 0; index < eventCount; index += 1) {
        lines.push(formatExecutionEventLine(payload.execution[index]));
    }
    if (payload.execution.length > eventCount) {
        lines.push(
            `- ...and ${payload.execution.length - eventCount} more execution event(s)`
        );
    }

    return lines.join('\n');
}

function truncateBlockToLength(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }

    const truncatedLength = Math.max(
        0,
        maxLength - DETAILS_TRUNCATION_SUFFIX.length
    );
    return `${value.slice(0, truncatedLength)}${DETAILS_TRUNCATION_SUFFIX}`;
}

function formatRawJsonSection(
    payload: ResponseMetadata | DetailsFallbackPayload,
    maxLength: number
): string | null {
    if (maxLength <= 0) {
        return null;
    }

    const title = '**Raw JSON (debug)**\n';
    const framingLength =
        title.length +
        DETAILS_CODE_FENCE_PREFIX.length +
        DETAILS_CODE_FENCE_SUFFIX.length;
    if (maxLength <= framingLength) {
        return null;
    }

    const serialized = JSON.stringify(payload, null, 2);
    const maxPayloadLength = maxLength - framingLength;
    const body = truncateBlockToLength(serialized, maxPayloadLength);
    return `${title}${DETAILS_CODE_FENCE_PREFIX}${body}${DETAILS_CODE_FENCE_SUFFIX}`;
}

/**
 * Builds markdown-first details with a small optional raw JSON debug section.
 * This keeps provenance easy to scan while still preserving inspectability.
 */
function formatDetailsMarkdownBody(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    return [
        formatSummarySection(payload),
        formatTraceSection(payload),
        formatSourcesSection(payload),
        formatExecutionSection(payload),
    ].join(DETAILS_SECTION_SEPARATOR);
}

/**
 * Renders details payload and truncates when needed so we do not
 * exceed Discord's hard message-length cap.
 */
function formatDetailsPayloadForDiscord(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    const markdownBody = formatDetailsMarkdownBody(payload);
    if (markdownBody.length >= DISCORD_MESSAGE_MAX_LENGTH) {
        return truncateBlockToLength(markdownBody, DISCORD_MESSAGE_MAX_LENGTH);
    }

    const sectionBreakLength = DETAILS_SECTION_SEPARATOR.length;
    const rawJsonRoom =
        DISCORD_MESSAGE_MAX_LENGTH - markdownBody.length - sectionBreakLength;
    const rawJsonSection = formatRawJsonSection(payload, rawJsonRoom);
    if (!rawJsonSection) {
        return markdownBody;
    }

    return `${markdownBody}${DETAILS_SECTION_SEPARATOR}${rawJsonSection}`;
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
    const provenanceAction = parseProvenanceActionCustomId(
        interaction.customId
    );
    if (!provenanceAction) {
        return false;
    }

    if (provenanceAction.action === 'details') {
        await interaction.deferReply({
            flags: [EPHEMERAL_FLAG],
        });
        let metadata: ResponseMetadata | null = null;
        try {
            const traceResponse = await botApi.getTrace(
                provenanceAction.responseId
            );
            metadata = extractMetadataFromTraceResponse(traceResponse.data);
            if (!metadata) {
                logger.warn(
                    'Trace payload did not contain valid response metadata; using fallback details payload.',
                    {
                        responseId: provenanceAction.responseId,
                        reason: 'metadata_extraction_failed',
                    }
                );
            }
        } catch (error) {
            logger.warn(
                'Failed to load provenance metadata for details action',
                {
                    responseId: provenanceAction.responseId,
                    reason: 'metadata_unavailable',
                    error,
                }
            );
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
