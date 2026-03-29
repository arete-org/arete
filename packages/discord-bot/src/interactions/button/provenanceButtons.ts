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
import { runtimeConfig } from '../../config/runtime.js';
import { parseProvenanceActionCustomId } from '../../utils/response/provenanceCgi.js';
import { handleIncidentReportButton } from '../../utils/response/incidentReporting.js';
import { EPHEMERAL_FLAG } from './shared.js';

const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DETAILS_SECTION_SEPARATOR = '\n\n';
const DETAILS_TRUNCATION_SUFFIX = '\n... (truncated)';
const DETAILS_FALLBACK_REASON = 'metadata_unavailable';
const DETAILS_INLINE_FIELD_LIMIT = 120;
const DETAILS_CITATION_LIMIT = 4;
const DETAILS_EXECUTION_EVENT_LIMIT = 5;
const DETAILS_MIN_EXECUTION_SECTION_LENGTH = 320;
const EXECUTION_TABLE_COLUMN_WIDTHS = {
    kind: 10,
    status: 10,
    target: 34,
    reason: 30,
    duration: 8,
} as const;
const EXECUTION_TABLE_HEADER = [
    'kind'.padEnd(EXECUTION_TABLE_COLUMN_WIDTHS.kind),
    'status'.padEnd(EXECUTION_TABLE_COLUMN_WIDTHS.status),
    'target'.padEnd(EXECUTION_TABLE_COLUMN_WIDTHS.target),
    'reason'.padEnd(EXECUTION_TABLE_COLUMN_WIDTHS.reason),
    'duration'.padEnd(EXECUTION_TABLE_COLUMN_WIDTHS.duration),
].join(' ');

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

function escapeMarkdownLinkText(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function escapeMarkdownLinkUrl(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
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

/**
 * Render the "Sources" section as Markdown, listing citations or an appropriate fallback message.
 *
 * @param payload - The response metadata containing `citations` or a fallback payload indicating provenance is unavailable.
 * @returns A Markdown string that either:
 *  - lists up to DETAILS_CITATION_LIMIT numbered citation links (title and URL), optionally followed by a line like `- ...and N more source(s)` when truncated; or
 *  - shows `- No citations recorded` when there are no citations; or
 *  - shows `- Source metadata unavailable` when provenance metadata is absent.
 */
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
        const title = escapeMarkdownLinkText(
            formatMarkdownValue(citation.title, 70)
        );
        const url = escapeMarkdownLinkUrl(
            formatMarkdownValue(citation.url, 140)
        );
        lines.push(`${index + 1}. [${title}](${url})`);
    }

    if (payload.citations.length > citationCount) {
        lines.push(
            `- ...and ${payload.citations.length - citationCount} more source(s)`
        );
    }

    return lines.join('\n');
}

/**
 * Render an execution event as a single fixed-width, column-aligned table row.
 *
 * @param event - The execution event to format; the event's `kind` influences how the `target` and `reason` columns are derived.
 * @returns A single-line string containing five fixed-width columns — kind, status, target, reason, and duration — each padded or truncated to the table's configured column widths.
 */
function formatExecutionEventLine(event: ExecutionEvent): string {
    const target =
        event.kind === 'evaluator'
            ? event.evaluator
                ? event.evaluator.safetyDecision.action !== 'allow'
                    ? `${event.evaluator.safetyDecision.riskTier}/${event.evaluator.provenance}/${event.evaluator.safetyDecision.action}/${event.evaluator.safetyDecision.ruleId}`
                    : `${event.evaluator.safetyDecision.riskTier}/${event.evaluator.provenance}/${event.evaluator.safetyDecision.action}`
                : 'decision'
            : event.kind === 'tool'
              ? formatMarkdownValue(event.toolName, 40)
              : formatMarkdownValue(
                    event.model ??
                        event.effectiveProfileId ??
                        event.profileId ??
                        event.originalProfileId ??
                        event.provider,
                    40
                );
    const reasonText =
        event.kind === 'evaluator' &&
        event.evaluator?.safetyDecision.action !== 'allow' &&
        event.evaluator?.safetyDecision.reason
            ? event.evaluator.safetyDecision.reasonCode
                ? `${event.evaluator.safetyDecision.reasonCode}: ${event.evaluator.safetyDecision.reason}`
                : event.evaluator.safetyDecision.reason
            : (event.reasonCode ?? '-');
    const duration =
        event.durationMs !== undefined ? `${event.durationMs}ms` : '-';
    const formatCell = (value: string, width: number): string =>
        truncateInline(value.replace(/\s+/g, ' ').trim(), width).padEnd(width);

    return [
        formatCell(event.kind, EXECUTION_TABLE_COLUMN_WIDTHS.kind),
        formatCell(event.status, EXECUTION_TABLE_COLUMN_WIDTHS.status),
        formatCell(target, EXECUTION_TABLE_COLUMN_WIDTHS.target),
        formatCell(reasonText, EXECUTION_TABLE_COLUMN_WIDTHS.reason),
        formatCell(duration, EXECUTION_TABLE_COLUMN_WIDTHS.duration),
    ].join(' ');
}

/**
 * Build the "Execution" section as a Markdown-compatible string, optionally truncating the execution table to fit a maximum total length.
 *
 * When `payload` is a fallback (no `provenance` field), returns a short block indicating execution metadata is unavailable.
 * Otherwise the returned text includes:
 * - A timeline line (or "unavailable"),
 * - Counts for executed/skipped/failed events and optional total duration,
 * - A fenced "```text" fixed-width table of up to `DETAILS_EXECUTION_EVENT_LIMIT` formatted execution event rows,
 * - An overflow line (`- ...and N more execution event(s)`) when additional events were omitted and it fits within the length budget.
 *
 * @param payload - The response metadata to render, or a fallback payload indicating provenance is unavailable.
 * @param maxLength - Optional maximum allowed length for the entire returned string; when finite, the table body and optional overflow line are truncated so the result does not exceed this limit.
 * @returns The formatted Execution section as a single string suitable for inclusion in a Discord message.
 */
function formatExecutionSection(
    payload: ResponseMetadata | DetailsFallbackPayload,
    maxLength = Number.POSITIVE_INFINITY
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

    const candidateEventCount = Math.min(
        payload.execution.length,
        DETAILS_EXECUTION_EVENT_LIMIT
    );
    const candidateTableLines = [
        EXECUTION_TABLE_HEADER,
        '-'.repeat(EXECUTION_TABLE_HEADER.length),
    ];
    for (let index = 0; index < candidateEventCount; index += 1) {
        candidateTableLines.push(
            formatExecutionEventLine(payload.execution[index])
        );
    }

    const linesWithFence = [...lines, '```text', '```'];
    const fixedLength = linesWithFence.join('\n').length;
    const availableTableBodyLength = Number.isFinite(maxLength)
        ? Math.max(0, maxLength - fixedLength)
        : Number.POSITIVE_INFINITY;

    const tableLines: string[] = [];
    let tableBodyLength = 0;
    for (const tableLine of candidateTableLines) {
        const projectedLength =
            tableBodyLength +
            tableLine.length +
            (tableLines.length > 0 ? 1 : 0);
        if (projectedLength > availableTableBodyLength) {
            break;
        }
        tableLines.push(tableLine);
        tableBodyLength = projectedLength;
    }

    lines.push('```text');
    lines.push(...tableLines);
    lines.push('```');

    const shownEventCount = Math.max(0, tableLines.length - 2);
    const remainingEventCount = payload.execution.length - shownEventCount;
    if (remainingEventCount > 0) {
        const overflowLine = `- ...and ${remainingEventCount} more execution event(s)`;
        const withOverflow = [...lines, overflowLine].join('\n');
        if (!Number.isFinite(maxLength) || withOverflow.length <= maxLength) {
            lines.push(overflowLine);
        }
    }

    return lines.join('\n');
}

/**
 * Ensure a string fits within a maximum length, appending a truncation suffix when necessary.
 *
 * @param value - The input string to constrain
 * @param maxLength - Maximum allowed length of the returned string (number of characters)
 * @returns `value` truncated to at most `maxLength` characters. If truncation occurs, the returned string ends with `DETAILS_TRUNCATION_SUFFIX`. If `maxLength` is smaller than the suffix length, the returned string will consist of the suffix only.
 */
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

/**
 * Builds a trace viewer URL for a given response identifier.
 *
 * @param responseId - The response identifier to include in the URL; leading and trailing whitespace are ignored. If `null`, `undefined`, or empty after trimming, no URL is produced.
 * @returns The full trace viewer URL formed by appending `/traces/{encodedResponseId}` to the configured web base URL, or `null` if `responseId` is missing or blank.
 */
function buildTraceViewerUrl(
    responseId: string | null | undefined
): string | null {
    if (!responseId || responseId.trim().length === 0) {
        return null;
    }
    const baseUrl = runtimeConfig.webBaseUrl.trim().replace(/\/+$/, '');
    return `${baseUrl}/traces/${encodeURIComponent(responseId.trim())}`;
}

/**
 * Render the "Trace Viewer" section containing a link to the full trace or an unavailable notice.
 *
 * Uses `payload.responseId` to build the trace viewer URL; if a URL cannot be constructed,
 * the section will indicate the link is unavailable.
 *
 * @param payload - Object that may include `responseId` used to build the trace viewer URL
 * @returns A Markdown-formatted section titled `**Trace Viewer**` with either `- [Open full trace](<url>)`
 *          or `- Trace link unavailable`
 */
function formatTraceViewerSection(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    const traceUrl = buildTraceViewerUrl(payload.responseId);
    if (!traceUrl) {
        return ['**Trace Viewer**', '- Trace link unavailable'].join('\n');
    }

    return ['**Trace Viewer**', `- [Open full trace](${traceUrl})`].join('\n');
}

/**
 * Compose a Discord-ready details message from provenance payloads and truncate sections to fit the message-length limit.
 *
 * Builds the Summary, Trace, Sources, Execution, and Trace Viewer sections, budgets available characters so the combined
 * output does not exceed Discord's maximum message length, and truncates the head or tail sections as needed.
 *
 * @param payload - Valid provenance metadata or a fallback payload used when metadata is unavailable
 * @returns The final composed details string, truncated as necessary to be within Discord's message-length limit
 */
function formatDetailsPayloadForDiscord(
    payload: ResponseMetadata | DetailsFallbackPayload
): string {
    const summarySection = formatSummarySection(payload);
    const traceSection = formatTraceSection(payload);
    const sourcesSection = formatSourcesSection(payload);
    const traceViewerSection = formatTraceViewerSection(payload);
    const maxExecutionLength = Math.max(
        DETAILS_MIN_EXECUTION_SECTION_LENGTH,
        DISCORD_MESSAGE_MAX_LENGTH -
            traceViewerSection.length -
            DETAILS_SECTION_SEPARATOR.length
    );
    const executionSection = formatExecutionSection(
        payload,
        maxExecutionLength
    );
    const tail = [executionSection, traceViewerSection].join(
        DETAILS_SECTION_SEPARATOR
    );

    if (tail.length >= DISCORD_MESSAGE_MAX_LENGTH) {
        return truncateBlockToLength(tail, DISCORD_MESSAGE_MAX_LENGTH);
    }

    const head = truncateBlockToLength(
        [summarySection, traceSection, sourcesSection].join(
            DETAILS_SECTION_SEPARATOR
        ),
        DISCORD_MESSAGE_MAX_LENGTH -
            tail.length -
            DETAILS_SECTION_SEPARATOR.length
    );
    return [head, tail].join(DETAILS_SECTION_SEPARATOR);
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
