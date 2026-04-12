/**
 * @description: Builds TRACE CGI provenance controls and trace-card request payloads for Discord follow-up messages.
 * @footnote-scope: interface
 * @footnote-module: ProvenanceCgi
 * @footnote-risk: medium - Broken control IDs or card payload mapping can block provenance actions.
 * @footnote-ethics: high - Provenance controls and scores affect transparency and user trust.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type {
    PartialResponseTemperament,
    ResponseMetadata,
} from '@footnote/contracts/ethics-core';
import type { PostTraceCardRequest } from '@footnote/contracts/web';
import { normalizeTraceAxisScoreWithStringParsing } from '../traceAxisScore.js';

export type ProvenanceAction = 'details' | 'report_issue';

const PROVENANCE_ACTIONS = new Set<ProvenanceAction>([
    'details',
    'report_issue',
]);
const UNKNOWN_RESPONSE_ID_FALLBACK = 'unknown_response_id';
const TRACE_AXIS_KEYS = [
    'tightness',
    'rationale',
    'attribution',
    'caution',
    'extent',
] as const;

function normalizeResponseId(responseId: string): string {
    const trimmed = responseId.trim();
    return trimmed.length > 0 ? trimmed : UNKNOWN_RESPONSE_ID_FALLBACK;
}

const normalizeTemperament = (
    temperament: ResponseMetadata['trace_final']
): PartialResponseTemperament | undefined => {
    if (!temperament) {
        return undefined;
    }

    const normalized: PartialResponseTemperament = {};
    for (const axis of TRACE_AXIS_KEYS) {
        const score = normalizeTraceAxisScoreWithStringParsing(
            temperament[axis]
        );
        if (score !== undefined) {
            normalized[axis] = score;
        }
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeTraceCardChips = (
    metadata: ResponseMetadata
): PostTraceCardRequest['chips'] | undefined => {
    const evidenceScore = normalizeTraceAxisScoreWithStringParsing(
        metadata.evidenceScore
    );
    const freshnessScore = normalizeTraceAxisScoreWithStringParsing(
        metadata.freshnessScore
    );

    const chips: NonNullable<PostTraceCardRequest['chips']> = {};
    if (evidenceScore !== undefined) {
        chips.evidenceScore = evidenceScore;
    }
    if (freshnessScore !== undefined) {
        chips.freshnessScore = freshnessScore;
    }

    return Object.keys(chips).length > 0 ? chips : undefined;
};

/**
 * Builds the backend trace-card request from response metadata.
 */
export function buildTraceCardRequest(
    metadata: ResponseMetadata
): PostTraceCardRequest {
    const temperament = normalizeTemperament(metadata.trace_final);
    const chips = normalizeTraceCardChips(metadata);

    return {
        responseId: normalizeResponseId(metadata.responseId),
        ...(temperament && { temperament }),
        ...(chips && { chips }),
    };
}

/**
 * Encodes a provenance action and responseId into one Discord customId.
 */
export function buildProvenanceActionCustomId(
    action: ProvenanceAction,
    responseId: string
): string {
    return `${action}:${normalizeResponseId(responseId)}`;
}

/**
 * Parses a response-bound provenance action customId.
 */
export function parseProvenanceActionCustomId(
    customId: string
): { action: ProvenanceAction; responseId: string } | null {
    const separatorIndex = customId.indexOf(':');
    if (separatorIndex <= 0) {
        return null;
    }

    const action = customId.slice(0, separatorIndex) as ProvenanceAction;
    const responseId = customId.slice(separatorIndex + 1).trim();
    if (!PROVENANCE_ACTIONS.has(action) || responseId.length === 0) {
        return null;
    }

    return { action, responseId };
}

/**
 * Builds the compact provenance control row used under the trace card.
 */
export function buildProvenanceActionRow(
    responseId: string
): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(buildProvenanceActionCustomId('details', responseId))
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('\u{1F50D}'),
        new ButtonBuilder()
            .setCustomId(
                buildProvenanceActionCustomId('report_issue', responseId)
            )
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('\u{1F6A9}')
    );
}
