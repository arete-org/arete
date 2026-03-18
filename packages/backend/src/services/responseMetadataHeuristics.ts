/**
 * @description: Centralizes deterministic TRACE metadata fallbacks used during reflect response assembly.
 * @footnote-scope: utility
 * @footnote-module: ResponseMetadataHeuristics
 * @footnote-risk: medium - Incorrect fallback rules can misstate metadata chips or tradeoff visibility.
 * @footnote-ethics: high - Provenance-facing metadata must stay consistent and explainable for user trust.
 */
import type {
    GenerationSearchContextSize,
    GenerationSearchIntent,
} from '@footnote/agent-runtime';
import type { PartialResponseTemperament } from '@footnote/contracts/ethics-core';
import type { TraceAxisScore } from '@footnote/contracts/ethics-core';

/**
 * Normalizes assistant-supplied tradeoff counts into schema-safe integers.
 */
export const normalizeTradeoffCount = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }

    return Math.max(0, Math.trunc(value));
};

/**
 * Planner fallback for tradeoff count.
 * If the planner asks for broad option coverage (`extent >= 4`), assume at least
 * one tradeoff should be represented even when the assistant omits a count.
 */
export const inferPlannerTradeoffCount = (
    plannerTemperament: PartialResponseTemperament | undefined
): number =>
    plannerTemperament?.extent !== undefined && plannerTemperament.extent >= 4
        ? 1
        : 0;

/**
 * Resolves the final tradeoff count by preferring explicit assistant metadata
 * and falling back to planner heuristics only when needed.
 */
export const resolveTradeoffCount = (
    assistantTradeoffCount: unknown,
    plannerTemperament: PartialResponseTemperament | undefined
): number => {
    const normalizedAssistantCount = normalizeTradeoffCount(
        assistantTradeoffCount
    );
    if (normalizedAssistantCount !== undefined) {
        return normalizedAssistantCount;
    }

    return inferPlannerTradeoffCount(plannerTemperament);
};

/**
 * Retrieval facts the backend uses when it has to derive compact provenance
 * chips on its own.
 */
export type RetrievedChipContext = {
    citationCount: number;
    intent?: GenerationSearchIntent;
    // Reserved for future scoring heuristics that may account for retrieval breadth.
    contextSize?: GenerationSearchContextSize;
};

/**
 * Keeps derived chip scores inside the TRACE 1..5 range.
 */
const clampTraceAxisScore = (value: number): TraceAxisScore =>
    Math.min(5, Math.max(1, Math.trunc(value))) as TraceAxisScore;

/**
 * Derives the evidence chip from how many citations survived normalization.
 *
 * This is intentionally simple and auditable. More citations do not guarantee
 * truth, but they are the best deterministic signal the backend currently owns
 * for "how much evidence made it into the final answer."
 */
export const deriveRetrievedEvidenceScore = ({
    citationCount,
}: RetrievedChipContext): TraceAxisScore => {
    if (citationCount <= 0) {
        return 2;
    }

    if (citationCount === 1) {
        return 3;
    }

    if (citationCount <= 3) {
        return 4;
    }

    return 5;
};

/**
 * Derives the freshness chip from retrieval intent, then applies a small
 * penalty when the answer is retrieved but no citations survived parsing.
 *
 * `current_facts` gets the higher baseline because the planner explicitly chose
 * a recency-oriented retrieval mode. Missing intent falls back conservatively
 * to the lower repo-explainer baseline.
 */
export const deriveRetrievedFreshnessScore = ({
    citationCount,
    intent,
}: RetrievedChipContext): TraceAxisScore => {
    const baseScore = intent === 'current_facts' ? 4 : 3;
    const adjustedScore = citationCount <= 0 ? baseScore - 1 : baseScore;

    return clampTraceAxisScore(adjustedScore);
};

/**
 * Derives both compact provenance chips for retrieved responses in one place
 * so callers do not accidentally apply mismatched rules.
 */
export const deriveRetrievedChips = (
    context: RetrievedChipContext
): {
    evidenceScore: TraceAxisScore;
    freshnessScore: TraceAxisScore;
} => ({
    evidenceScore: deriveRetrievedEvidenceScore(context),
    freshnessScore: deriveRetrievedFreshnessScore(context),
});
