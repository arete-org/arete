/**
 * @description: Builds TRACE CGI provenance controls and trace-card request payloads for Discord follow-up messages.
 * @footnote-scope: interface
 * @footnote-module: ProvenanceCgi
 * @footnote-risk: medium - Broken control IDs or card payload mapping can block provenance actions.
 * @footnote-ethics: high - Provenance controls and scores affect transparency and user trust.
 */
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import type {
    ResponseMetadata,
    ResponseTemperament,
    TraceAxisScore,
} from '@footnote/contracts/ethics-core';
import type { PostTraceCardRequest } from '@footnote/contracts/web';

export type ProvenanceAction = 'details' | 'report_issue';

const PROVENANCE_ACTIONS = new Set<ProvenanceAction>([
    'details',
    'report_issue',
]);
const UNKNOWN_RESPONSE_ID_FALLBACK = 'unknown_response_id';
const TRACE_CARD_FRESHNESS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_CHIP_SCORE = 3;

const NEUTRAL_TEMPERAMENT: ResponseTemperament = {
    tightness: 5,
    rationale: 5,
    attribution: 5,
    caution: 5,
    extent: 5,
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function normalizeResponseId(responseId: string): string {
    const trimmed = responseId.trim();
    return trimmed.length > 0 ? trimmed : UNKNOWN_RESPONSE_ID_FALLBACK;
}

function toTraceAxisScore(value: number): TraceAxisScore {
    return Math.round(clamp(value, 1, 10)) as TraceAxisScore;
}

function normalizeTemperament(
    temperament: ResponseTemperament | undefined
): ResponseTemperament {
    if (!temperament) {
        return NEUTRAL_TEMPERAMENT;
    }

    return {
        tightness: toTraceAxisScore(temperament.tightness),
        rationale: toTraceAxisScore(temperament.rationale),
        attribution: toTraceAxisScore(temperament.attribution),
        caution: toTraceAxisScore(temperament.caution),
        extent: toTraceAxisScore(temperament.extent),
    };
}

/**
 * Maps response confidence (0..1) to TRACE evidence chip score (1..5).
 */
export function mapConfidenceToEvidenceScore(confidence: number): number {
    if (!Number.isFinite(confidence)) {
        return DEFAULT_CHIP_SCORE;
    }

    const normalized = clamp(confidence, 0, 1);
    return 1 + normalized * 4;
}

/**
 * Maps freshness horizon to TRACE freshness chip score (1..5).
 */
export function mapStaleAfterToFreshnessScore(
    staleAfter: string,
    nowMs: number = Date.now()
): number {
    const staleAfterMs = Date.parse(staleAfter);
    if (!Number.isFinite(staleAfterMs)) {
        return DEFAULT_CHIP_SCORE;
    }

    const horizonRatio = clamp(
        (staleAfterMs - nowMs) / TRACE_CARD_FRESHNESS_WINDOW_MS,
        0,
        1
    );
    return 1 + horizonRatio * 4;
}

/**
 * Builds the backend trace-card request from response metadata.
 */
export function buildTraceCardRequest(
    metadata: ResponseMetadata,
    nowMs: number = Date.now()
): PostTraceCardRequest {
    return {
        responseId: normalizeResponseId(metadata.responseId),
        temperament: normalizeTemperament(metadata.temperament),
        chips: {
            evidenceScore: mapConfidenceToEvidenceScore(metadata.confidence),
            freshnessScore: mapStaleAfterToFreshnessScore(
                metadata.staleAfter,
                nowMs
            ),
        },
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
