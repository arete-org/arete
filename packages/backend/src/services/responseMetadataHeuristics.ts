/**
 * @description: Centralizes deterministic TRACE metadata fallbacks used during reflect response assembly.
 * @footnote-scope: utility
 * @footnote-module: ResponseMetadataHeuristics
 * @footnote-risk: medium - Incorrect fallback rules can misstate metadata chips or tradeoff visibility.
 * @footnote-ethics: high - Provenance-facing metadata must stay consistent and explainable for user trust.
 */
import type { PartialResponseTemperament } from '@footnote/contracts/ethics-core';

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
    const normalizedAssistantCount = normalizeTradeoffCount(assistantTradeoffCount);
    if (normalizedAssistantCount !== undefined) {
        return normalizedAssistantCount;
    }

    return inferPlannerTradeoffCount(plannerTemperament);
};

