/**
 * @description: Orchestrates universal chat requests across web and Discord surfaces.
 * @footnote-scope: core
 * @footnote-module: ChatOrchestrator
 * @footnote-risk: high - Routing mistakes here can send the wrong action or break chat across surfaces.
 * @footnote-ethics: high - This is the canonical action-selection boundary for user-facing chat behavior.
 */
import type {
    PostChatRequest,
    PostChatResponse,
    ChatConversationMessage,
} from '@footnote/contracts/web';
import type {
    ModelCostClass,
    ModelLatencyClass,
    ModelProfile,
    CorrelationEnvelope,
} from '@footnote/contracts';
import type {
    SafetyBreakerAction,
    SafetyDecision,
    SafetyBreakerReasonCode,
    ToolExecutionContext,
    ToolInvocationReasonCode,
    ToolInvocationRequest,
    ExecutionReasonCode,
    ExecutionStatus,
    EvaluatorOutcome,
    RiskTier,
    RiskRuleId,
} from '@footnote/contracts/ethics-core';
import {
    computeProvenance,
    evaluateRiskTierDeterministic,
} from '../ethics-core/evaluators.js';
import { renderConversationPromptLayers } from './prompts/conversationPromptLayers.js';
import {
    createChatService,
    type CreateChatServiceOptions,
} from './chatService.js';
import { createChatPlanner, type ChatPlan } from './chatPlanner.js';
import type { ChatGenerationPlan } from './chatGenerationTypes.js';
import { normalizeDiscordConversation } from './chatConversationNormalization.js';
import {
    resolveActiveProfileOverlayPrompt,
    resolveBotProfileDisplayName,
} from './chatProfileOverlay.js';
import { coercePlanForSurface } from './chatSurfacePolicy.js';
import { createModelProfileResolver } from './modelProfileResolver.js';
import {
    createPlannerFallbackTelemetryRollup,
    type PlannerFallbackReason,
    type PlannerSelectionSource,
} from './plannerFallbackTelemetryRollup.js';
import type { WeatherForecastTool } from './weatherGovForecastTool.js';
import { applySingleToolPolicy } from './tools/toolPolicy.js';
import {
    executeSelectedTool,
    resolveToolSelection,
} from './tools/toolRegistry.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type CreateChatOrchestratorOptions = CreateChatServiceOptions & {
    weatherForecastTool?: WeatherForecastTool;
};

type PlannerWeatherFailureMarker = {
    failed: true;
    reason: 'weather_tool_failed';
};

type PlannerGenerationForPrompt = Omit<ChatGenerationPlan, 'weather'> & {
    weather?: ChatGenerationPlan['weather'] | PlannerWeatherFailureMarker;
};

type PlannerPayloadChatPlan = Omit<ChatPlan, 'generation'> & {
    generation: PlannerGenerationForPrompt;
};

const searchFallbackPolicyBySelectionSource: Record<
    PlannerSelectionSource,
    {
        allowReroute: boolean;
        rerouteReasonCode: ToolInvocationReasonCode;
        skipReasonCode: ToolInvocationReasonCode;
    }
> = {
    planner: {
        allowReroute: true,
        rerouteReasonCode: 'search_rerouted_to_fallback_profile',
        skipReasonCode: 'search_reroute_no_tool_capable_fallback_available',
    },
    request: {
        allowReroute: false,
        rerouteReasonCode: 'search_rerouted_to_fallback_profile',
        skipReasonCode: 'search_reroute_not_permitted_by_selection_source',
    },
    default: {
        allowReroute: false,
        rerouteReasonCode: 'search_rerouted_to_fallback_profile',
        skipReasonCode: 'search_reroute_not_permitted_by_selection_source',
    },
};

const searchFallbackRankingPolicy = {
    steps: [
        'prefer_same_provider',
        'prefer_shared_tier_binding',
        'prefer_lower_latency_class',
        'prefer_lower_cost_class',
        'tie_break_by_profile_id_ascending',
    ] as const,
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

const RESPONSE_PROFILE_FALLBACK_POLICY = 'response_profile_fallback_v1';
const SEARCH_REROUTE_FALLBACK_POLICY = 'search_reroute_profile_fallback_v1';

const plannerFallbackTelemetryRollup = createPlannerFallbackTelemetryRollup({
    logger,
});

const buildSafetyDecision = (ruleId: RiskRuleId | null): SafetyDecision => {
    if (!ruleId) {
        return {
            action: 'allow',
            riskTier: 'Low',
            ruleId: null,
        };
    }

    const reasonCodeByRuleId: Record<RiskRuleId, SafetyBreakerReasonCode> = {
        'risk.self_harm.crisis_intent.v1': 'self_harm_crisis_intent',
        'risk.safety.weaponization_request.v1': 'weaponization_request',
        'risk.professional.medical_or_legal_advice.v1':
            'professional_advice_guardrail',
    };
    const actionByRuleId: Record<
        RiskRuleId,
        Exclude<SafetyBreakerAction, 'allow'>
    > = {
        'risk.self_harm.crisis_intent.v1': 'block',
        'risk.safety.weaponization_request.v1': 'block',
        'risk.professional.medical_or_legal_advice.v1': 'safe_partial',
    };
    const riskTierByRuleId: Record<RiskRuleId, RiskTier> = {
        'risk.self_harm.crisis_intent.v1': 'High',
        'risk.safety.weaponization_request.v1': 'High',
        'risk.professional.medical_or_legal_advice.v1': 'Medium',
    };
    const reasonByRuleId: Record<RiskRuleId, string> = {
        'risk.self_harm.crisis_intent.v1':
            'Deterministic crisis-intent rule matched.',
        'risk.safety.weaponization_request.v1':
            'Deterministic weaponization-request rule matched.',
        'risk.professional.medical_or_legal_advice.v1':
            'Deterministic professional-advice guardrail rule matched.',
    };

    return {
        action: actionByRuleId[ruleId],
        riskTier: riskTierByRuleId[ruleId],
        ruleId,
        reasonCode: reasonCodeByRuleId[ruleId],
        reason: reasonByRuleId[ruleId],
    };
};

/**
 * Packs the normalized planner decision into one structured system payload.
 *
 * JSON keeps this payload machine-stable so generation can treat planner output
 * as data, not as ambiguous free-form text.
 */
const buildPlannerPayload = (
    plan: PlannerPayloadChatPlan,
    surfacePolicy?: { coercedFrom: ChatPlan['action'] }
): string =>
    JSON.stringify({
        action: plan.action,
        modality: plan.modality,
        profileId: plan.profileId,
        reaction: plan.reaction,
        imageRequest: plan.imageRequest,
        riskTier: plan.riskTier,
        reasoning: plan.reasoning,
        generation: plan.generation,
        ...(surfacePolicy && { surfacePolicy }),
    });

const buildCorrelationIds = (
    request: PostChatRequest,
    responseId: string | null = null
): CorrelationEnvelope => ({
    conversationId: request.sessionId ?? null,
    requestId: request.trigger.messageId ?? null,
    incidentId: null,
    responseId,
});

/**
 * The orchestrator keeps surface-specific policy in one place while reusing the
 * shared message-generation service for any branch that ends in text output.
 */
export const createChatOrchestrator = ({
    generationRuntime,
    storeTrace,
    buildResponseMetadata,
    defaultModel = runtimeConfig.modelProfiles.defaultProfileId,
    recordUsage,
    weatherForecastTool,
}: CreateChatOrchestratorOptions) => {
    const chatOrchestratorLogger =
        typeof logger.child === 'function'
            ? logger.child({ module: 'chatOrchestrator' })
            : logger;
    const catalogProfiles = runtimeConfig.modelProfiles.catalog;
    const enabledProfiles = catalogProfiles.filter(
        (profile) => profile.enabled
    );
    const searchCapableProfiles = enabledProfiles.filter(
        (profile) => profile.capabilities.canUseSearch
    );
    const enabledProfilesById = new Map(
        enabledProfiles.map((profile) => [profile.id, profile])
    );

    // Resolver remains authoritative for all profile-id/tier/raw selector
    // resolution and fail-open behavior.
    const modelProfileResolver = createModelProfileResolver({
        catalog: catalogProfiles,
        defaultProfileId: runtimeConfig.modelProfiles.defaultProfileId,
        legacyDefaultModel: runtimeConfig.openai.defaultModel,
        warn: chatOrchestratorLogger,
    });
    const plannerProfile = modelProfileResolver.resolve(
        runtimeConfig.modelProfiles.plannerProfileId
    );
    // Startup fallback profile for end-user response generation.
    // Planner may override this per-request with one catalog profile id.
    const defaultResponseProfile = modelProfileResolver.resolve(defaultModel);

    // Bounded profile payload sent to planner prompt context.
    // Description is trimmed to keep planner context predictable.
    const plannerProfileOptions = enabledProfiles.map((profile) => ({
        id: profile.id,
        description: profile.description.slice(0, 180),
        costClass: profile.costClass,
        latencyClass: profile.latencyClass,
        capabilities: {
            canUseSearch: profile.capabilities.canUseSearch,
        },
    }));
    // TODO(phase-5-provider-tool-registry): Add deterministic fallback ranking
    // metadata for planner/executor handoff (for example, preferred
    // search-capable backup profile ids by policy).

    // ChatService handles final message generation and trace/cost wiring.
    const chatService = createChatService({
        generationRuntime,
        storeTrace,
        buildResponseMetadata,
        defaultModel: defaultResponseProfile.providerModel,
        defaultProvider: defaultResponseProfile.provider,
        defaultCapabilities: defaultResponseProfile.capabilities,
        recordUsage,
    });
    const chatPlanner = createChatPlanner({
        availableProfiles: plannerProfileOptions,
        executePlanner: async ({
            messages,
            model,
            maxOutputTokens,
            reasoningEffort,
            verbosity,
        }) => {
            // Planner calls go through the same runtime seam so model usage and
            // behavior stay aligned with normal generation calls.
            const plannerResult = await generationRuntime.generate({
                messages,
                model,
                provider: plannerProfile.provider,
                capabilities: plannerProfile.capabilities,
                maxOutputTokens,
                reasoningEffort,
                verbosity,
            });

            return {
                text: plannerResult.text,
                model: plannerResult.model,
                usage: plannerResult.usage,
            };
        },
        defaultModel: plannerProfile.providerModel,
        recordUsage,
    });

    /**
     * Runs one chat request end-to-end:
     * 1) normalize conversation shape by surface
     * 2) plan action/modality
     * 3) apply surface policy guardrails
     * 4) execute message generation when action requires text output
     */
    const runChat = async (
        request: PostChatRequest
    ): Promise<PostChatResponse> => {
        // Total wall-clock budget for this request from planner entry to
        // final response payload. This is exposed as telemetry only.
        const orchestrationStartedAt = Date.now();
        const normalizedConversation =
            request.surface === 'discord'
                ? normalizeDiscordConversation(request, chatOrchestratorLogger)
                : request.conversation.map(
                      (message: PostChatRequest['conversation'][number]) => ({
                          role: message.role,
                          content: message.content,
                      })
                  );
        const normalizedRequest: PostChatRequest = {
            ...request,
            conversation: normalizedConversation,
        };
        // Planner and generation both consume this normalized request shape.
        const evaluatorStartedAt = Date.now();
        let evaluatorExecutionContext:
            | {
                  status: ExecutionStatus;
                  reasonCode?: ExecutionReasonCode;
                  outcome?: EvaluatorOutcome;
                  durationMs: number;
              }
            | undefined;
        let evaluatorRiskTierHint: RiskTier | undefined;
        try {
            const evaluatorContext = normalizedConversation.map(
                (message) => message.content
            );
            const riskEvaluation = evaluateRiskTierDeterministic(
                normalizedRequest.latestUserInput,
                evaluatorContext
            );
            const safetyDecision = buildSafetyDecision(riskEvaluation.ruleId);
            const evaluatorOutcome: EvaluatorOutcome = {
                mode: 'observe_only',
                provenance: computeProvenance(evaluatorContext),
                safetyDecision: {
                    ...safetyDecision,
                    riskTier: riskEvaluation.riskTier,
                },
            };
            evaluatorExecutionContext = {
                status: 'executed',
                outcome: evaluatorOutcome,
                durationMs: Math.max(0, Date.now() - evaluatorStartedAt),
            };
            evaluatorRiskTierHint = evaluatorOutcome.safetyDecision.riskTier;
            if (evaluatorOutcome.safetyDecision.action !== 'allow') {
                chatOrchestratorLogger.warn(
                    'deterministic breaker signaled a non-allow action in observe-only mode',
                    {
                        event: 'chat.orchestration.breaker_signal',
                        mode: evaluatorOutcome.mode,
                        action: evaluatorOutcome.safetyDecision.action,
                        ruleId: evaluatorOutcome.safetyDecision.ruleId,
                        reasonCode: evaluatorOutcome.safetyDecision.reasonCode,
                        reason: evaluatorOutcome.safetyDecision.reason,
                        riskTier: evaluatorOutcome.safetyDecision.riskTier,
                        surface: normalizedRequest.surface,
                        triggerKind: normalizedRequest.trigger.kind,
                        correlation: buildCorrelationIds(normalizedRequest),
                    }
                );
            }
        } catch (error) {
            // Evaluator failures must not block normal response generation.
            chatOrchestratorLogger.warn(
                'deterministic evaluator failed open; continuing without evaluator outcome',
                {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
            evaluatorExecutionContext = {
                status: 'failed',
                reasonCode: 'evaluator_runtime_error',
                durationMs: Math.max(0, Date.now() - evaluatorStartedAt),
            };
        }

        const botProfileDisplayName = resolveBotProfileDisplayName();
        const planned = await chatPlanner.planChat(normalizedRequest);
        const plannerExecution = planned.execution;
        const fallbackReasons: PlannerFallbackReason[] = [];
        if (plannerExecution.status === 'failed') {
            const plannerFailureReason =
                plannerExecution.reasonCode === 'planner_invalid_output'
                    ? 'planner_execution_failed_planner_invalid_output'
                    : plannerExecution.reasonCode === 'planner_runtime_error'
                      ? 'planner_execution_failed_planner_runtime_error'
                      : 'planner_execution_failed_unknown';
            fallbackReasons.push(plannerFailureReason);
        }
        const emitFallbackRollup = (
            selectionSource: PlannerSelectionSource
        ): void => {
            for (const reason of fallbackReasons) {
                plannerFallbackTelemetryRollup.record({
                    reason,
                    surface: normalizedRequest.surface,
                    selectionSource,
                });
            }
        };
        const { plan, surfacePolicy } = coercePlanForSurface(
            normalizedRequest,
            planned.plan,
            chatOrchestratorLogger
        );
        // Profile selection precedence:
        // 1) explicit request.profileId override (for example `/chat`)
        // 2) planner-selected profileId
        // 3) startup default response profile
        // Runtime resolution stays authoritative and fail-open:
        // unknown/disabled profile ids never hard-fail the request.
        let selectedResponseProfile = defaultResponseProfile;
        let profileSelectionSource: PlannerSelectionSource = 'default';
        const requestedProfileId = normalizedRequest.profileId?.trim();
        const plannerSelectedProfileId = plan.profileId?.trim();
        const profileSelectionOrder: Array<{
            source: PlannerSelectionSource;
            profileId?: string;
        }> = [
            {
                source: 'request',
                profileId: requestedProfileId,
            },
            {
                source: 'planner',
                profileId: plannerSelectedProfileId,
            },
            {
                source: 'default',
                profileId: defaultResponseProfile.id,
            },
        ];

        for (const candidate of profileSelectionOrder) {
            if (!candidate.profileId) {
                continue;
            }

            if (candidate.source === 'default') {
                selectedResponseProfile = defaultResponseProfile;
                profileSelectionSource = 'default';
                break;
            }

            const matchedProfile = enabledProfilesById.get(candidate.profileId);
            if (matchedProfile) {
                selectedResponseProfile = matchedProfile;
                profileSelectionSource = candidate.source;
                break;
            }

            chatOrchestratorLogger.warn(
                'chat profile selection candidate is invalid or disabled; continuing fallback order',
                {
                    event: 'chat.orchestration.profile_fallback',
                    policy: RESPONSE_PROFILE_FALLBACK_POLICY,
                    stage: 'invalid_profile_candidate',
                    source: candidate.source,
                    selectedProfileId: candidate.profileId,
                    defaultProfileId: defaultResponseProfile.id,
                    fallbackOrder: profileSelectionOrder.map(
                        (entry) => entry.source
                    ),
                    surface: normalizedRequest.surface,
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
            plan.profileId &&
            plan.profileId !== selectedResponseProfile.id
        ) {
            chatOrchestratorLogger.warn(
                'chat request profile override superseded planner profile selection',
                {
                    event: 'chat.orchestration.profile_fallback',
                    policy: RESPONSE_PROFILE_FALLBACK_POLICY,
                    stage: 'request_override_superseded_planner',
                    requestedProfileId: selectedResponseProfile.id,
                    plannerProfileId: plan.profileId,
                    surface: normalizedRequest.surface,
                }
            );
        }

        // Capability policy for this branch:
        // keep the selected profile, but drop search when capabilities disallow
        // it, instead of silently switching to a different profile/model.
        // Request-level generation overrides are advisory knobs from callers
        // like `/chat` that want quick side-by-side runs without changing
        // planner prompt semantics.
        const requestGeneration = normalizedRequest.generation;
        const originalSelectedProfileId = selectedResponseProfile.id;
        let effectiveSelectedProfileId = selectedResponseProfile.id;
        let rerouteApplied = false;
        let generationForExecution: ChatGenerationPlan = {
            ...plan.generation,
            ...(requestGeneration?.reasoningEffort
                ? { reasoningEffort: requestGeneration.reasoningEffort }
                : {}),
            ...(requestGeneration?.verbosity
                ? { verbosity: requestGeneration.verbosity }
                : {}),
        };
        const toolPolicyDecision = applySingleToolPolicy(
            generationForExecution
        );
        generationForExecution = toolPolicyDecision.generation;
        if (toolPolicyDecision.logEvent) {
            chatOrchestratorLogger.warn(
                'planner requested both weather and search; applying single-tool policy with weather priority',
                {
                    ...toolPolicyDecision.logEvent,
                    surface: normalizedRequest.surface,
                }
            );
        }
        let webSearchToolRequestContextOverride:
            | ToolInvocationRequest
            | undefined;
        let toolExecutionContext: ToolExecutionContext | undefined;
        if (
            generationForExecution.search &&
            !selectedResponseProfile.capabilities.canUseSearch
        ) {
            const fallbackPolicy =
                searchFallbackPolicyBySelectionSource[profileSelectionSource];
            const rankedFallbackCandidates = rankSearchFallbackProfiles(
                selectedResponseProfile,
                searchCapableProfiles.filter(
                    (profile) => profile.id !== selectedResponseProfile.id
                )
            );
            const fallbackProfile = fallbackPolicy.allowReroute
                ? rankedFallbackCandidates[0]
                : undefined;
            const searchFallbackOrder = rankedFallbackCandidates.map(
                (profile) => profile.id
            );

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
                chatOrchestratorLogger.warn(
                    'selected profile cannot use search; rerouting to policy-ranked tool-capable fallback profile',
                    {
                        event: 'chat.orchestration.profile_fallback',
                        policy: SEARCH_REROUTE_FALLBACK_POLICY,
                        stage: 'search_rerouted',
                        reasonCode: fallbackPolicy.rerouteReasonCode,
                        originalProfileId: originalSelectedProfileId,
                        effectiveProfileId: effectiveSelectedProfileId,
                        selectionSource: profileSelectionSource,
                        rankingPolicy: searchFallbackRankingPolicy.steps,
                        rankedFallbackProfileIds: rankedFallbackCandidates.map(
                            (profile) => profile.id
                        ),
                        fallbackOrder: searchFallbackOrder,
                        surface: normalizedRequest.surface,
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
                if (profileSelectionSource === 'planner') {
                    fallbackReasons.push('search_dropped_no_fallback_profile');
                } else {
                    fallbackReasons.push(
                        'search_dropped_selection_source_guard'
                    );
                }
                chatOrchestratorLogger.warn(
                    'search is not supported by selected profile; continuing without search',
                    {
                        event: 'chat.orchestration.profile_fallback',
                        policy: SEARCH_REROUTE_FALLBACK_POLICY,
                        stage:
                            profileSelectionSource === 'planner'
                                ? 'search_dropped_no_search_capable_fallback'
                                : 'search_dropped_by_selection_policy',
                        originalProfileId: originalSelectedProfileId,
                        effectiveProfileId: effectiveSelectedProfileId,
                        rerouteApplied,
                        reasonCode: fallbackPolicy.skipReasonCode,
                        selectionSource: profileSelectionSource,
                        fallbackOrder: searchFallbackOrder,
                        rankingPolicy: searchFallbackRankingPolicy.steps,
                        rankedFallbackProfileIds: rankedFallbackCandidates.map(
                            (profile) => profile.id
                        ),
                        surface: normalizedRequest.surface,
                    }
                );
            }
        }
        const toolSelection = resolveToolSelection({
            generation: generationForExecution,
            weatherForecastTool,
            webSearchToolRequestOverride: webSearchToolRequestContextOverride,
            inheritedToolExecution: toolExecutionContext,
        });
        const toolIntent = toolSelection.toolIntent;
        const toolRequestContext = toolSelection.toolRequest;
        toolExecutionContext =
            toolSelection.toolExecution ?? toolExecutionContext;
        // Persist the effective profile id in planner payload/snapshot so traces
        // reflect what was actually executed.
        const executionPlan: ChatPlan = {
            ...plan,
            generation: generationForExecution,
            profileId: selectedResponseProfile.id,
        };

        // Non-message actions return early and skip model generation.
        if (executionPlan.action === 'ignore') {
            emitFallbackRollup(profileSelectionSource);
            return {
                action: 'ignore',
                metadata: null,
            };
        }

        if (executionPlan.action === 'react') {
            emitFallbackRollup(profileSelectionSource);
            return {
                action: 'react',
                reaction: executionPlan.reaction ?? '👍',
                metadata: null,
            };
        }

        if (executionPlan.action === 'image' && executionPlan.imageRequest) {
            emitFallbackRollup(profileSelectionSource);
            return {
                action: 'image',
                imageRequest: executionPlan.imageRequest,
                metadata: null,
            };
        }

        if (executionPlan.action === 'image' && !executionPlan.imageRequest) {
            // Invalid image action should not block response flow.
            fallbackReasons.push('image_action_missing_image_request');
            chatOrchestratorLogger.warn(
                `Chat planner returned image without imageRequest; falling back to ignore. surface=${normalizedRequest.surface} trigger=${normalizedRequest.trigger.kind} latestUserInputLength=${normalizedRequest.latestUserInput.length}`
            );
            emitFallbackRollup(profileSelectionSource);
            return {
                action: 'ignore',
                metadata: null,
            };
        }
        const promptLayers = renderConversationPromptLayers(
            normalizedRequest.surface === 'discord'
                ? 'discord-chat'
                : 'web-chat',
            {
                botProfileDisplayName,
            }
        );
        const backendOwnedProfileOverlay =
            normalizedRequest.surface === 'discord'
                ? resolveActiveProfileOverlayPrompt(
                      normalizedRequest,
                      chatOrchestratorLogger
                  )
                : null;
        // Discord can inject backend-owned runtime overlay text.
        // Web keeps default prompt persona layers.
        const personaPrompt =
            backendOwnedProfileOverlay ?? promptLayers.personaPrompt;
        const toolExecution = await executeSelectedTool({
            toolSelection,
            weatherForecastTool,
            onWarn: (message, meta) => {
                chatOrchestratorLogger.warn(message, meta);
            },
        });
        const weatherToolResultMessage = toolExecution.toolResultMessage;
        toolExecutionContext =
            toolExecution.toolExecutionContext ?? toolExecutionContext;
        const weatherToolRequested =
            toolSelection.toolRequest.toolName === 'weather_forecast' &&
            toolSelection.toolRequest.requested;
        const plannerGenerationForPrompt: PlannerGenerationForPrompt =
            weatherToolResultMessage
                ? executionPlan.generation
                : weatherToolRequested
                  ? {
                        ...executionPlan.generation,
                        weather: {
                            failed: true,
                            reason: 'weather_tool_failed',
                        },
                    }
                  : executionPlan.generation;
        const executionPlanForPrompt: PlannerPayloadChatPlan = {
            ...executionPlan,
            generation: plannerGenerationForPrompt,
        };

        // Planner output is injected as a final system message so generation
        // can follow one backend-owned decision payload.
        const conversationMessages: Array<
            Pick<ChatConversationMessage, 'role' | 'content'>
        > = [
            {
                role: 'system',
                content: promptLayers.systemPrompt,
            },
            {
                role: 'system',
                content: personaPrompt,
            },
            ...normalizedConversation,
            ...(weatherToolResultMessage
                ? [
                      {
                          role: 'system' as const,
                          content: weatherToolResultMessage,
                      },
                  ]
                : []),
            {
                role: 'system',
                content: [
                    '// ==========',
                    '// BEGIN Planner Output',
                    '// This planner decision was made by the backend and should be treated as authoritative for this response.',
                    '// ==========',
                    buildPlannerPayload(executionPlanForPrompt, surfacePolicy),
                    '// ==========',
                    '// END Planner Output',
                    '// ==========',
                ].join('\n'),
            },
        ];
        const riskTierRank: Record<RiskTier, number> = {
            Low: 1,
            Medium: 2,
            High: 3,
        };
        const orchestrationRiskTier =
            evaluatorRiskTierHint &&
            riskTierRank[evaluatorRiskTierHint] >
                riskTierRank[executionPlan.riskTier]
                ? evaluatorRiskTierHint
                : executionPlan.riskTier;

        // Generation receives resolved provider/capabilities from the active
        // default model profile instead of relying on provider-name checks.
        const response = await chatService.runChatMessages({
            messages: conversationMessages,
            conversationSnapshot: JSON.stringify({
                request: normalizedRequest,
                planner: {
                    action: executionPlan.action,
                    modality: executionPlan.modality,
                    profileId: executionPlan.profileId,
                    riskTier: executionPlan.riskTier,
                    generation: plannerGenerationForPrompt,
                    toolIntent,
                    toolRequest: toolRequestContext,
                    ...(surfacePolicy && { surfacePolicy }),
                },
            }),
            orchestrationStartedAtMs: orchestrationStartedAt,
            plannerTemperament: executionPlan.generation.temperament,
            riskTier: orchestrationRiskTier,
            model: selectedResponseProfile.providerModel,
            provider: selectedResponseProfile.provider,
            capabilities: selectedResponseProfile.capabilities,
            generation: executionPlan.generation,
            toolRequest: toolRequestContext,
            executionContext: {
                // Planner execution metadata is sourced from ChatPlannerResult
                // so traces can distinguish successful planning from fallback.
                planner: {
                    status: plannerExecution.status,
                    ...(plannerExecution.reasonCode !== undefined && {
                        reasonCode: plannerExecution.reasonCode,
                    }),
                    profileId: plannerProfile.id,
                    originalProfileId: plannerProfile.id,
                    effectiveProfileId: plannerProfile.id,
                    provider: plannerProfile.provider,
                    model: plannerProfile.providerModel,
                    durationMs: plannerExecution.durationMs,
                },
                evaluator: evaluatorExecutionContext,
                generation: {
                    // Generation starts as "executed" at orchestration level.
                    // ChatService injects runtime-resolved model + duration.
                    status: 'executed',
                    profileId: selectedResponseProfile.id,
                    originalProfileId: originalSelectedProfileId,
                    effectiveProfileId: effectiveSelectedProfileId,
                    provider: selectedResponseProfile.provider,
                    model: selectedResponseProfile.providerModel,
                },
                ...(toolExecutionContext !== undefined && {
                    tool: toolExecutionContext,
                }),
            },
        });
        // ChatService computes totalDurationMs before metadata assembly and
        // queued trace writes. Avoid mutating metadata here to keep trace
        // persistence race-free.
        const totalDurationMs =
            response.metadata.totalDurationMs ??
            Math.max(0, Date.now() - orchestrationStartedAt);
        emitFallbackRollup(profileSelectionSource);
        const breakerDecision =
            evaluatorExecutionContext?.outcome?.safetyDecision;
        if (
            evaluatorExecutionContext?.status === 'executed' &&
            breakerDecision &&
            breakerDecision.action !== 'allow'
        ) {
            chatOrchestratorLogger.info(
                'chat.orchestration.breaker_action_applied',
                {
                    event: 'chat.orchestration.breaker_action_applied',
                    mode: evaluatorExecutionContext.outcome?.mode,
                    action: breakerDecision.action,
                    ruleId: breakerDecision.ruleId,
                    reasonCode: breakerDecision.reasonCode,
                    reason: breakerDecision.reason,
                    riskTier: breakerDecision.riskTier,
                    enforcement: 'observe_only',
                    responseAction: 'message',
                    responseModality: executionPlan.modality,
                    correlation: buildCorrelationIds(
                        normalizedRequest,
                        response.metadata.responseId
                    ),
                }
            );
        }
        chatOrchestratorLogger.info('chat.orchestration.timing', {
            surface: normalizedRequest.surface,
            plannerStatus: plannerExecution.status,
            plannerReasonCode: plannerExecution.reasonCode,
            plannerDurationMs: plannerExecution.durationMs,
            evaluatorStatus: evaluatorExecutionContext?.status,
            evaluatorReasonCode: evaluatorExecutionContext?.reasonCode,
            evaluatorRiskTier:
                evaluatorExecutionContext?.outcome?.safetyDecision.riskTier,
            evaluatorProvenance: evaluatorExecutionContext?.outcome?.provenance,
            evaluatorMode: evaluatorExecutionContext?.outcome?.mode,
            generationDurationMs: response.generationDurationMs,
            totalDurationMs,
            plannerProfileId: plannerProfile.id,
            responseProfileId: selectedResponseProfile.id,
            originalProfileId: originalSelectedProfileId,
            effectiveProfileId: effectiveSelectedProfileId,
            searchRequested: generationForExecution.search !== undefined,
            toolName: response.finalToolExecutionTelemetry?.toolName,
            toolStatus: response.finalToolExecutionTelemetry?.status,
            toolReasonCode: response.finalToolExecutionTelemetry?.reasonCode,
            toolEligible: response.finalToolExecutionTelemetry?.eligible,
            toolRequestReasonCode:
                response.finalToolExecutionTelemetry?.requestReasonCode,
            rerouteApplied,
            fallbackApplied:
                plannerExecution.status === 'failed' ||
                fallbackReasons.length > 0,
            fallbackReasons,
            responseId: response.metadata.responseId,
            responseAction: 'message',
            responseModality: executionPlan.modality,
            responseProvenance: response.metadata.provenance,
            responseRiskTier: response.metadata.riskTier,
            responseModelVersion: response.metadata.modelVersion,
            responseCitationCount: response.metadata.citations.length,
            responseMessageLength: response.message.length,
            correlation: buildCorrelationIds(
                normalizedRequest,
                response.metadata.responseId
            ),
        });

        // Message action is the only branch that returns provenance metadata.
        return {
            action: 'message',
            message: response.message,
            modality: executionPlan.modality,
            metadata: response.metadata,
        };
    };

    return {
        runChat,
    };
};
