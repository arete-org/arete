/**
 * @description: Owns search reroute fallback policy and deterministic ranking of search-capable model profiles.
 * @footnote-scope: core
 * @footnote-module: SearchFallbackPolicy
 * @footnote-risk: medium - Incorrect ranking or selection-source policy can reroute search to unintended models.
 * @footnote-ethics: medium - Search reroute decisions affect retrieval quality and operator trust in fallback behavior.
 */
import type {
    ModelCostClass,
    ModelLatencyClass,
    ModelProfile,
} from '@footnote/contracts';
import type { ToolInvocationReasonCode } from '@footnote/contracts/ethics-core';
import type { ExecutionPolicyRoutingIntent } from './executionPolicyContract.js';
import type { PlannerSelectionSource } from './plannerFallbackTelemetryRollup.js';

type SearchFallbackPolicy = {
    allowReroute: boolean;
    rerouteReasonCode: ToolInvocationReasonCode;
    skipReasonCode: ToolInvocationReasonCode;
};

export const searchFallbackRankingPolicy = {
    steps: [
        'prefer_same_provider',
        'prefer_shared_tier_binding',
        'prefer_lower_latency_class',
        'prefer_lower_cost_class',
        'tie_break_by_profile_id_ascending',
    ] as const,
};

const searchFallbackPolicyByRoutingStrategy: Record<
    ExecutionPolicyRoutingIntent['strategy'],
    SearchFallbackPolicy
> = {
    'capability-first': {
        allowReroute: true,
        rerouteReasonCode: 'search_rerouted_to_fallback_profile',
        skipReasonCode: 'search_reroute_no_tool_capable_fallback_available',
    },
    'profile-first': {
        allowReroute: false,
        rerouteReasonCode: 'search_rerouted_to_fallback_profile',
        skipReasonCode: 'search_reroute_not_permitted_by_selection_source',
    },
};

const latencyClassRank: Record<ModelLatencyClass, number> = {
    low: 0,
    medium: 1,
    high: 2,
};

const costClassRank: Record<ModelCostClass, number> = {
    low: 0,
    medium: 1,
    high: 2,
};

const rankLatencyClass = (latencyClass: ModelLatencyClass | undefined) =>
    latencyClass === undefined ? 3 : latencyClassRank[latencyClass];

const rankCostClass = (costClass: ModelCostClass | undefined) =>
    costClass === undefined ? 3 : costClassRank[costClass];

const compareNumbers = (left: number, right: number) => left - right;

const rankSearchFallbackProfiles = (
    selectedProfile: ModelProfile,
    candidates: ModelProfile[]
): ModelProfile[] => {
    const selectedTierBindings = new Set(selectedProfile.tierBindings);
    return [...candidates].sort((left, right) => {
        const providerRank = compareNumbers(
            left.provider === selectedProfile.provider ? 0 : 1,
            right.provider === selectedProfile.provider ? 0 : 1
        );
        if (providerRank !== 0) {
            return providerRank;
        }

        const tierBindingRank = compareNumbers(
            left.tierBindings.some((binding) =>
                selectedTierBindings.has(binding)
            )
                ? 0
                : 1,
            right.tierBindings.some((binding) =>
                selectedTierBindings.has(binding)
            )
                ? 0
                : 1
        );
        if (tierBindingRank !== 0) {
            return tierBindingRank;
        }

        const latencyRank = compareNumbers(
            rankLatencyClass(left.latencyClass),
            rankLatencyClass(right.latencyClass)
        );
        if (latencyRank !== 0) {
            return latencyRank;
        }

        const costRank = compareNumbers(
            rankCostClass(left.costClass),
            rankCostClass(right.costClass)
        );
        if (costRank !== 0) {
            return costRank;
        }

        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
};

type ResolveSearchFallbackPolicyInput = {
    selectionSource: PlannerSelectionSource;
    routingStrategy: ExecutionPolicyRoutingIntent['strategy'];
    selectedProfile: ModelProfile;
    searchCapableProfiles: ModelProfile[];
};

type ResolveSearchFallbackPolicyResult = {
    fallbackPolicy: SearchFallbackPolicy;
    rankedFallbackCandidates: ModelProfile[];
    fallbackProfile: ModelProfile | undefined;
    fallbackOrder: string[];
};

export const resolveSearchFallbackPolicy = (
    input: ResolveSearchFallbackPolicyInput
): ResolveSearchFallbackPolicyResult => {
    const fallbackPolicy =
        searchFallbackPolicyByRoutingStrategy[input.routingStrategy];
    const rankedFallbackCandidates = rankSearchFallbackProfiles(
        input.selectedProfile,
        input.searchCapableProfiles.filter(
            (profile) => profile.id !== input.selectedProfile.id
        )
    );
    const fallbackProfile = fallbackPolicy.allowReroute
        ? rankedFallbackCandidates[0]
        : undefined;

    return {
        fallbackPolicy,
        rankedFallbackCandidates,
        fallbackProfile,
        fallbackOrder: rankedFallbackCandidates.map((profile) => profile.id),
    };
};
