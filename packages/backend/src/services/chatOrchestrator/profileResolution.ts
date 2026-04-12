/**
 * @description: Resolves response model profile selection and search fallback
 * behavior for orchestrator execution.
 * @footnote-scope: core
 * @footnote-module: ChatOrchestratorProfileResolution
 * @footnote-risk: high - Selection regressions here can route requests to wrong providers or drop capabilities.
 * @footnote-ethics: medium - Profile and fallback choices influence answer quality and transparency expectations.
 */
import type {
    ToolExecutionContext,
    ToolInvocationRequest,
} from '@footnote/contracts/ethics-core';
import type { ModelProfile } from '@footnote/contracts';
import type { PostChatRequest } from '@footnote/contracts/web';
import type { ChatPlan } from '../chatPlanner.js';
import type { ChatGenerationPlan } from '../chatGenerationTypes.js';
import type { ExecutionContract } from '../executionContract.js';
import type {
    CapabilityProfileId,
    ModelCapabilityReasonCode,
} from '../modelCapabilityPolicy.js';
import { selectModelProfileForWorkflowStep } from '../modelCapabilityPolicy.js';
import type {
    PlannerFallbackReason,
    PlannerSelectionSource,
} from '../plannerFallbackTelemetryRollup.js';
import {
    resolveSearchFallbackPolicy,
    searchFallbackRankingPolicy,
} from '../searchFallbackPolicy.js';

const RESPONSE_PROFILE_FALLBACK_POLICY = 'response_profile_fallback_v1';
const SEARCH_REROUTE_FALLBACK_POLICY = 'search_reroute_profile_fallback_v1';

type ResolveExecutionProfileInput = {
    normalizedRequest: PostChatRequest;
    plan: ChatPlan;
    enabledProfiles: ModelProfile[];
    searchCapableProfiles: ModelProfile[];
    enabledProfilesById: Map<string, ModelProfile>;
    defaultResponseProfile: ModelProfile;
    generationForExecution: ChatGenerationPlan;
    resolvedExecutionPolicy: ExecutionContract;
};

type ResolveExecutionProfileResult = {
    generationForExecution: ChatGenerationPlan;
    selectedResponseProfile: ModelProfile;
    fallbackRollupSelectionSource: PlannerSelectionSource;
    originalSelectedProfileId: string;
    effectiveSelectedProfileId: string;
    rerouteApplied: boolean;
    webSearchToolRequestContextOverride: ToolInvocationRequest | undefined;
    toolExecutionContext: ToolExecutionContext | undefined;
    selectedCapabilityProfile: CapabilityProfileId;
    capabilityReasonCode: ModelCapabilityReasonCode | undefined;
    fallbackReasons: PlannerFallbackReason[];
};

/**
 * Chooses the model profile we will actually use for this response.
 *
 * The easy mistake is to treat planner output as the final answer. It is only
 * one input here. A request-level override may win, and the default profile is
 * still the fallback if the requested or planned choice is missing or disabled.
 */
export const resolveExecutionProfile = (
    input: ResolveExecutionProfileInput,
    onWarn: {
        warn: (message: string, meta?: Record<string, unknown>) => void;
    }
): ResolveExecutionProfileResult => {
    const fallbackReasons: PlannerFallbackReason[] = [];
    const routingStrategy = input.resolvedExecutionPolicy.routing.strategy;
    let selectedResponseProfile = input.defaultResponseProfile;
    let profileSelectionSource: PlannerSelectionSource = 'default';
    const requestedModelProfileId = input.normalizedRequest.profileId?.trim();
    const allowRequestProfileOverride =
        input.normalizedRequest.trigger.kind === 'submit' &&
        routingStrategy === 'profile-first';
    const selectedCapabilityDecision = selectModelProfileForWorkflowStep({
        step: 'generation',
        requestedCapabilityProfile: input.plan.requestedCapabilityProfile,
        profiles: input.enabledProfiles,
        requiresSearch: input.generationForExecution.search !== undefined,
        routingIntent: input.resolvedExecutionPolicy.routing,
    });
    const plannerSelectedModelProfileId =
        selectedCapabilityDecision.selectedProfile?.id.trim();
    const profileSelectionOrder: Array<{
        source: PlannerSelectionSource;
        profileId?: string;
    }> =
        routingStrategy === 'profile-first'
            ? [
                  {
                      source: 'request',
                      profileId: allowRequestProfileOverride
                          ? requestedModelProfileId
                          : undefined,
                  },
                  {
                      source: 'default',
                      profileId: input.defaultResponseProfile.id,
                  },
                  {
                      source: 'planner',
                      profileId: plannerSelectedModelProfileId,
                  },
              ]
            : [
                  {
                      source: 'planner',
                      profileId: plannerSelectedModelProfileId,
                  },
                  {
                      source: 'default',
                      profileId: input.defaultResponseProfile.id,
                  },
              ];

    for (const candidate of profileSelectionOrder) {
        if (!candidate.profileId) {
            continue;
        }

        if (candidate.source === 'default') {
            selectedResponseProfile = input.defaultResponseProfile;
            profileSelectionSource = 'default';
            break;
        }

        const matchedModelProfile = input.enabledProfilesById.get(
            candidate.profileId
        );
        if (matchedModelProfile) {
            selectedResponseProfile = matchedModelProfile;
            profileSelectionSource = candidate.source;
            break;
        }

        const candidateStage =
            candidate.source === 'planner'
                ? 'invalid_capability_candidate'
                : 'invalid_profile_candidate';
        onWarn.warn(
            'chat profile selection candidate is invalid or disabled; continuing fallback order',
            {
                event: 'chat.orchestration.profile_fallback',
                policy: RESPONSE_PROFILE_FALLBACK_POLICY,
                stage: candidateStage,
                source: candidate.source,
                selectedProfileId: candidate.profileId,
                requestedCapabilityProfile:
                    input.plan.requestedCapabilityProfile,
                selectedCapabilityProfile:
                    selectedCapabilityDecision.selectedCapabilityProfile,
                capabilityReasonCode: selectedCapabilityDecision.reasonCode,
                defaultProfileId: input.defaultResponseProfile.id,
                fallbackOrder: profileSelectionOrder.map(
                    (entry) => entry.source
                ),
                surface: input.normalizedRequest.surface,
            }
        );
        if (candidate.source === 'request') {
            fallbackReasons.push('request_invalid_or_disabled_profile');
        } else if (candidate.source === 'planner') {
            fallbackReasons.push('planner_invalid_or_disabled_profile');
        }
    }

    if (
        profileSelectionSource === 'request' &&
        plannerSelectedModelProfileId &&
        plannerSelectedModelProfileId !== selectedResponseProfile.id
    ) {
        onWarn.warn(
            'chat request profile override superseded planner capability selection',
            {
                event: 'chat.orchestration.profile_fallback',
                policy: RESPONSE_PROFILE_FALLBACK_POLICY,
                stage: 'request_override_superseded_planner',
                requestedProfileId: selectedResponseProfile.id,
                plannerProfileId: plannerSelectedModelProfileId,
                requestedCapabilityProfile:
                    input.plan.requestedCapabilityProfile,
                selectedCapabilityProfile:
                    selectedCapabilityDecision.selectedCapabilityProfile,
                capabilityReasonCode: selectedCapabilityDecision.reasonCode,
                surface: input.normalizedRequest.surface,
            }
        );
    }
    const originalSelectedProfileId = selectedResponseProfile.id;
    let effectiveSelectedProfileId = selectedResponseProfile.id;
    let rerouteApplied = false;
    let fallbackRollupSelectionSource: PlannerSelectionSource =
        profileSelectionSource;
    let webSearchToolRequestContextOverride: ToolInvocationRequest | undefined;
    let toolExecutionContext: ToolExecutionContext | undefined;
    let generationForExecution = input.generationForExecution;
    if (
        generationForExecution.search &&
        !selectedResponseProfile.capabilities.canUseSearch
    ) {
        // A plan can ask for search and still land on a profile that cannot
        // search. Handle that mismatch here so the rest of the orchestrator can
        // work with one resolved profile.
        const searchPolicySelectionSource: PlannerSelectionSource =
            selectedCapabilityDecision.reasonCode ===
            'planner_requested_capability_profile_no_floor_match'
                ? 'planner'
                : profileSelectionSource;
        fallbackRollupSelectionSource = searchPolicySelectionSource;
        const searchFallbackDecision = resolveSearchFallbackPolicy({
            selectionSource: searchPolicySelectionSource,
            routingStrategy,
            selectedProfile: selectedResponseProfile,
            searchCapableProfiles: input.searchCapableProfiles,
        });
        const {
            fallbackPolicy,
            rankedFallbackCandidates,
            fallbackProfile,
            fallbackOrder: searchFallbackOrder,
        } = searchFallbackDecision;

        if (fallbackProfile) {
            rerouteApplied = true;
            selectedResponseProfile = fallbackProfile;
            effectiveSelectedProfileId = fallbackProfile.id;
            toolExecutionContext = {
                toolName: 'web_search',
                status: 'executed',
                reasonCode: fallbackPolicy.rerouteReasonCode,
            };
            fallbackReasons.push('planner_non_search_profile_rerouted');
            onWarn.warn(
                'selected profile cannot use search; rerouting to policy-ranked tool-capable fallback profile',
                {
                    event: 'chat.orchestration.profile_fallback',
                    policy: SEARCH_REROUTE_FALLBACK_POLICY,
                    stage: 'search_rerouted',
                    reasonCode: fallbackPolicy.rerouteReasonCode,
                    originalProfileId: originalSelectedProfileId,
                    effectiveProfileId: effectiveSelectedProfileId,
                    selectionSource: searchPolicySelectionSource,
                    rankingPolicy: searchFallbackRankingPolicy.steps,
                    rankedFallbackProfileIds: rankedFallbackCandidates.map(
                        (profile) => profile.id
                    ),
                    fallbackOrder: searchFallbackOrder,
                    surface: input.normalizedRequest.surface,
                }
            );
        } else {
            generationForExecution = {
                ...generationForExecution,
                search: undefined,
            };
            webSearchToolRequestContextOverride = {
                toolName: 'web_search',
                requested: true,
                eligible: false,
                reasonCode: 'search_not_supported_by_selected_profile',
            };
            toolExecutionContext = {
                toolName: 'web_search',
                status: 'skipped',
                reasonCode: fallbackPolicy.skipReasonCode,
            };
            if (searchPolicySelectionSource === 'planner') {
                fallbackReasons.push('search_dropped_no_fallback_profile');
            } else {
                fallbackReasons.push('search_dropped_selection_source_guard');
            }
            onWarn.warn(
                'search is not supported by selected profile; continuing without search',
                {
                    event: 'chat.orchestration.profile_fallback',
                    policy: SEARCH_REROUTE_FALLBACK_POLICY,
                    stage:
                        searchPolicySelectionSource === 'planner'
                            ? 'search_dropped_no_search_capable_fallback'
                            : 'search_dropped_by_selection_policy',
                    originalProfileId: originalSelectedProfileId,
                    effectiveProfileId: effectiveSelectedProfileId,
                    rerouteApplied,
                    reasonCode: fallbackPolicy.skipReasonCode,
                    selectionSource: searchPolicySelectionSource,
                    fallbackOrder: searchFallbackOrder,
                    rankingPolicy: searchFallbackRankingPolicy.steps,
                    rankedFallbackProfileIds: rankedFallbackCandidates.map(
                        (profile) => profile.id
                    ),
                    surface: input.normalizedRequest.surface,
                }
            );
        }
    }

    return {
        generationForExecution,
        selectedResponseProfile,
        fallbackRollupSelectionSource,
        originalSelectedProfileId,
        effectiveSelectedProfileId,
        rerouteApplied,
        webSearchToolRequestContextOverride,
        toolExecutionContext,
        selectedCapabilityProfile:
            selectedCapabilityDecision.selectedCapabilityProfile,
        capabilityReasonCode: selectedCapabilityDecision.reasonCode,
        fallbackReasons,
    };
};
