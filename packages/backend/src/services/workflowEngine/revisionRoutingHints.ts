/**
 * @description: Extracts and applies lightweight assess routing hints for revision generation ordering.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineRevisionRoutingHints
 * @footnote-risk: medium - Incorrect hint interpretation can reorder revision attempts unexpectedly.
 * @footnote-ethics: medium - Hint routing shifts style/cost/logic tradeoffs for user-visible responses.
 */

import type { ModelProfile } from '@footnote/contracts';
import type { ReviewDecision } from './reviewDecision.js';
import type { ResolvedStepRoutingCandidate } from '../stepRoutingChains.js';

export const ROUTING_HINT_VALUES = [
    'style.ai_speak_down',
    'style.creativity_up',
    'logic.precision_up',
    'grounding.citation_strict',
    'cost.cheaper_path',
] as const;

export type RoutingHint = (typeof ROUTING_HINT_VALUES)[number];

type RoutingHintLane =
    | 'openai_first_logic'
    | 'ollama_first_style'
    | 'cheaper_first'
    | 'none';

export type RevisionRoutingHintDecision = {
    hints: RoutingHint[];
    lane: RoutingHintLane;
    conflictResolved?: 'logic_over_style';
};

const ROUTING_HINT_SET = new Set<string>(ROUTING_HINT_VALUES);

const extractHintTokens = (value: string): RoutingHint[] =>
    value
        .split(/[\s,;|]+/g)
        .map((token) => token.trim().toLowerCase())
        .filter((token): token is RoutingHint => ROUTING_HINT_SET.has(token));

const hasAnyPhrase = (content: string, patterns: RegExp[]): boolean =>
    patterns.some((pattern) => pattern.test(content));

/**
 * Parse hint tokens from assess raw output and normalized review fields.
 * This intentionally remains freeform-compatible and fail-open.
 */
export const extractRoutingHintsFromAssess = (input: {
    assessRawText: string;
    reviewDecision: ReviewDecision;
}): RoutingHint[] => {
    const explicitHints = Array.isArray(input.reviewDecision.routingHints)
        ? input.reviewDecision.routingHints
        : [];
    const haystack = [
        input.assessRawText,
        input.reviewDecision.reviewReason,
        input.reviewDecision.revisionInstruction ?? '',
        explicitHints.join(' '),
    ]
        .join('\n')
        .toLowerCase();

    const hints = new Set<RoutingHint>(extractHintTokens(haystack));

    // Prefer explicit assess-provided hints and keep phrase matching as fail-open fallback.
    for (const explicitHint of explicitHints) {
        const normalizedHint = explicitHint.trim().toLowerCase();
        if (ROUTING_HINT_SET.has(normalizedHint)) {
            hints.add(normalizedHint as RoutingHint);
        }
    }

    if (
        hasAnyPhrase(haystack, [
            /\bai[-\s]?speak\b/i,
            /\btoo stiff\b/i,
            /\brobotic\b/i,
            /\bless formal\b/i,
            /\bmore natural\b/i,
        ]) ||
        input.reviewDecision.concerns?.style === 'too_stiff'
    ) {
        hints.add('style.ai_speak_down');
    }
    if (
        hasAnyPhrase(haystack, [
            /\bmore creative\b/i,
            /\blinguistic creativity\b/i,
            /\bmore expressive\b/i,
            /\bmore vivid\b/i,
        ])
    ) {
        hints.add('style.creativity_up');
    }
    if (
        hasAnyPhrase(haystack, [
            /\bmore precise\b/i,
            /\bprecision\b/i,
            /\btighter logic\b/i,
            /\bimprove logic\b/i,
            /\bmore accurate\b/i,
        ])
    ) {
        hints.add('logic.precision_up');
    }
    if (
        hasAnyPhrase(haystack, [
            /\bgrounding\b/i,
            /\bcitation(s)?\b/i,
            /\bcite\b/i,
            /\battribution\b/i,
            /\bsource-backed\b/i,
        ]) ||
        input.reviewDecision.concerns?.evidence === 'needs_caution'
    ) {
        hints.add('grounding.citation_strict');
    }
    if (
        hasAnyPhrase(haystack, [
            /\bcheaper\b/i,
            /\breduce cost\b/i,
            /\blower cost\b/i,
        ])
    ) {
        hints.add('cost.cheaper_path');
    }

    return [...hints];
};

export const decideRevisionRoutingHintLane = (
    hints: RoutingHint[]
): RevisionRoutingHintDecision => {
    const hasLogic = hints.some(
        (hint) =>
            hint === 'logic.precision_up' ||
            hint === 'grounding.citation_strict'
    );
    const hasStyle = hints.some(
        (hint) =>
            hint === 'style.ai_speak_down' || hint === 'style.creativity_up'
    );
    const hasCost = hints.includes('cost.cheaper_path');

    if (hasLogic && hasStyle) {
        return {
            hints,
            lane: 'openai_first_logic',
            conflictResolved: 'logic_over_style',
        };
    }
    if (hasLogic) {
        return { hints, lane: 'openai_first_logic' };
    }
    if (hasStyle) {
        return { hints, lane: 'ollama_first_style' };
    }
    if (hasCost) {
        return { hints, lane: 'cheaper_first' };
    }
    return { hints, lane: 'none' };
};

const profileForCandidate = (
    candidate: ResolvedStepRoutingCandidate,
    enabledProfilesById: Map<string, ModelProfile>
): ModelProfile | undefined => enabledProfilesById.get(candidate.profileId);

/**
 * Reorder only revision-generation candidates according to a selected hint lane.
 * Unknown profiles keep stable order and fail-open semantics.
 */
export const reorderRevisionCandidatesByHintLane = (input: {
    candidates: ResolvedStepRoutingCandidate[];
    enabledProfilesById: Map<string, ModelProfile>;
    lane: RoutingHintLane;
}): ResolvedStepRoutingCandidate[] => {
    const decorated = input.candidates.map((candidate, index) => ({
        candidate,
        index,
        profile: profileForCandidate(candidate, input.enabledProfilesById),
    }));

    if (input.lane === 'none') {
        return input.candidates;
    }

    if (input.lane === 'openai_first_logic') {
        return [...decorated]
            .sort((left, right) => {
                const leftOpenAi = left.profile?.provider === 'openai' ? 0 : 1;
                const rightOpenAi =
                    right.profile?.provider === 'openai' ? 0 : 1;
                if (leftOpenAi !== rightOpenAi) {
                    return leftOpenAi - rightOpenAi;
                }
                return left.index - right.index;
            })
            .map((entry) => entry.candidate);
    }

    if (input.lane === 'ollama_first_style') {
        return [...decorated]
            .sort((left, right) => {
                const leftOllama = left.profile?.provider === 'ollama' ? 0 : 1;
                const rightOllama =
                    right.profile?.provider === 'ollama' ? 0 : 1;
                if (leftOllama !== rightOllama) {
                    return leftOllama - rightOllama;
                }
                return left.index - right.index;
            })
            .map((entry) => entry.candidate);
    }

    return [...decorated]
        .sort((left, right) => {
            const leftCost = left.profile?.costClass;
            const rightCost = right.profile?.costClass;
            const rank = (value: ModelProfile['costClass']): number => {
                if (value === 'low') {
                    return 0;
                }
                if (value === 'medium') {
                    return 1;
                }
                if (value === 'high') {
                    return 2;
                }
                return 3;
            };
            const costDiff = rank(leftCost) - rank(rightCost);
            if (costDiff !== 0) {
                return costDiff;
            }
            return left.index - right.index;
        })
        .map((entry) => entry.candidate);
};
