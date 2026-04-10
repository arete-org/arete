/**
 * @description: Resolves deterministic breaker decision context from response
 * metadata with fail-open-safe runtime guards.
 * @footnote-scope: interface
 * @footnote-module: BreakerDecisionResolver
 * @footnote-risk: low - Incorrect parsing can desynchronize surface enforcement from evaluator metadata.
 * @footnote-ethics: high - This parser determines whether non-allow safety decisions are recognized by adapters.
 */

import type {
    EvaluatorAuthorityLevel,
    EvaluatorDecisionMode,
    ResponseMetadata,
    SafetyDecision,
} from './types.js';

export type BreakerDecisionSource = 'metadata.evaluator' | 'metadata.execution';

export type BreakerDecisionContext = {
    source: BreakerDecisionSource;
    authorityLevel: EvaluatorAuthorityLevel;
    mode: EvaluatorDecisionMode;
    safetyDecision: SafetyDecision;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const isBreakerSafetyDecision = (value: unknown): value is SafetyDecision => {
    if (!isObjectRecord(value)) {
        return false;
    }

    const action = value.action;
    const safetyTier = value.safetyTier;
    const ruleId = value.ruleId;

    if (
        action !== 'allow' &&
        action !== 'block' &&
        action !== 'redirect' &&
        action !== 'safe_partial' &&
        action !== 'human_review'
    ) {
        return false;
    }

    if (
        safetyTier !== 'Low' &&
        safetyTier !== 'Medium' &&
        safetyTier !== 'High'
    ) {
        return false;
    }

    if (action === 'allow') {
        return ruleId === null;
    }

    return (
        typeof ruleId === 'string' &&
        ruleId.length > 0 &&
        typeof value.reasonCode === 'string' &&
        value.reasonCode.length > 0 &&
        typeof value.reason === 'string' &&
        value.reason.length > 0
    );
};

const toBreakerDecisionContext = (
    value: unknown,
    source: BreakerDecisionSource
): BreakerDecisionContext | null => {
    if (!isObjectRecord(value)) {
        return null;
    }

    const authorityLevel = value.authorityLevel;
    const mode = value.mode;
    const safetyDecision = value.safetyDecision;
    const normalizedAuthorityLevel =
        authorityLevel === 'observe' ||
        authorityLevel === 'influence' ||
        authorityLevel === 'enforce'
            ? authorityLevel
            : mode === 'observe_only'
              ? isBreakerSafetyDecision(safetyDecision) &&
                safetyDecision.action !== 'allow'
                  ? 'influence'
                  : 'observe'
              : mode === 'enforced'
                ? 'enforce'
                : null;
    const normalizedMode =
        mode === 'observe_only' || mode === 'enforced'
            ? mode
            : normalizedAuthorityLevel === 'enforce'
              ? 'enforced'
              : 'observe_only';
    if (
        normalizedAuthorityLevel === null ||
        !isBreakerSafetyDecision(safetyDecision)
    ) {
        return null;
    }

    return {
        source,
        authorityLevel: normalizedAuthorityLevel,
        mode: normalizedMode,
        safetyDecision,
    };
};

/**
 * Resolves evaluator decision context used by surface-level breaker enforcement.
 *
 * Source precedence:
 * 1) metadata.evaluator
 * 2) first evaluator entry in metadata.execution
 *
 * Returns null on malformed or missing evaluator payloads so callers can
 * continue with explicit fail-open behavior.
 */
export const resolveBreakerDecisionContext = (
    metadata: ResponseMetadata
): BreakerDecisionContext | null => {
    const directEvaluator = toBreakerDecisionContext(
        metadata.evaluator,
        'metadata.evaluator'
    );
    if (directEvaluator) {
        return directEvaluator;
    }

    for (const executionEvent of metadata.execution ?? []) {
        if (executionEvent.kind !== 'evaluator') {
            continue;
        }
        const executionEvaluator = toBreakerDecisionContext(
            executionEvent.evaluator,
            'metadata.execution'
        );
        if (executionEvaluator) {
            return executionEvaluator;
        }
    }

    return null;
};
