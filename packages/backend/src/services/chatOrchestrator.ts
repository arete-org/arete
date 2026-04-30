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
} from '@footnote/contracts/web';
import type { SafetyTier } from '@footnote/contracts/ethics-core';
import { renderConversationPromptLayers } from './prompts/conversationPromptLayers.js';
import {
    createChatService,
    type CreateChatServiceOptions,
} from './chatService.js';
import {
    createChatPlanner,
    type ChatPlan,
    type ChatPlannerInvocationContext,
} from './chatPlanner.js';
import { createOpenAiChatPlannerStructuredExecutor } from './chatPlannerStructuredOpenAi.js';
import {
    resolveActiveProfileOverlayPrompt,
    resolveBotProfileDisplayName,
    resolveChatPersonaProfile,
} from './chatProfileOverlay.js';
import { createModelProfileResolver } from './modelProfileResolver.js';
import { listCapabilityProfileOptionsForStep } from './modelCapabilityPolicy.js';
import {
    createPlannerFallbackTelemetryRollup,
    type PlannerFallbackReason,
    type PlannerSelectionSource,
} from './plannerFallbackTelemetryRollup.js';
import { resolveExecutionContract } from './executionContractResolver.js';
import { resolveWorkflowModeDecision } from './workflowProfileRegistry.js';
import { buildSteerabilityControls } from './steerabilityControls.js';
import type { WeatherForecastTool } from './openMeteoForecastTool.js';
import { buildToolClarificationResponse } from './tools/toolClarificationResponse.js';
import { resolveWeatherClarificationContinuation } from './tools/weatherClarificationContinuation.js';
import { createToolRegistryContextStepExecutor } from './contextIntegrations/toolRegistryContextStepAdapter.js';
import { createPlannerResultApplier } from './chatOrchestrator/plannerResultApplier.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import type { IncidentAlertRouter } from './incidentAlerts.js';
import {
    buildExecutionContractScopeTuple,
    buildCorrelationIds,
    normalizeRequest,
} from './chatOrchestrator/requestNormalization.js';
import {
    runDeterministicEvaluator,
    type EvaluatorExecutionContext,
} from './chatOrchestrator/evaluatorCoordination.js';
import { type PlannerPayloadChatPlan } from './chatOrchestrator/plannerPayload.js';
import { assemblePostPlanGenerationInput } from './chatService/postPlanAssembly.js';
import {
    resolvePlannerActionOutcome,
    plannerTerminalActionToResponse,
} from './chatService/plannerActionOutcome.js';
import {
    buildControlObservabilityEnvelope,
    emitControlObservabilityEnvelope,
} from './steerabilityControlObservability.js';
import { resolveInternalSteerabilityControlConflicts } from './steerabilityControlPrecedence.js';

type CreateChatOrchestratorOptions = CreateChatServiceOptions & {
    weatherForecastTool?: WeatherForecastTool;
    alertRouter?: IncidentAlertRouter;
};

const plannerFallbackTelemetryRollup = createPlannerFallbackTelemetryRollup({
    logger,
});

/**
 * Entry point for chat requests from web and Discord.
 *
 * Most of the work here is deciding what kind of response we are about to
 * produce. Once that is settled, ChatService handles the actual text
 * generation.
 */
export const createChatOrchestrator = ({
    generationRuntime,
    storeTrace,
    buildResponseMetadata,
    defaultModel = runtimeConfig.modelProfiles.defaultProfileId,
    recordUsage,
    executionContractTrustGraph,
    weatherForecastTool,
    alertRouter,
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
    // Planner may request a capability profile that resolves to one catalog profile.
    const defaultResponseProfile = modelProfileResolver.resolve(defaultModel);

    const plannerCapabilityOptions =
        listCapabilityProfileOptionsForStep('generation');
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
        executionContractTrustGraph,
    });
    const chatPlanner = createChatPlanner({
        availableCapabilityProfiles: plannerCapabilityOptions,
        ...(runtimeConfig.openai.plannerStructuredOutputEnabled &&
            plannerProfile.provider === 'openai' &&
            runtimeConfig.openai.apiKey &&
            generationRuntime.kind !== 'test-runtime' && {
                executePlannerStructured:
                    createOpenAiChatPlannerStructuredExecutor({
                        apiKey: runtimeConfig.openai.apiKey,
                    }),
            }),
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
        allowTextJsonCompatibilityFallback:
            runtimeConfig.openai.plannerAllowTextJsonCompatibilityFallback,
        defaultModel: plannerProfile.providerModel,
        recordUsage,
    });

    /**
     * Runs one chat request end-to-end.
     *
     * The order is easy to miss: normalize the request, run the evaluator,
     * ask the planner, narrow the profile and tool choices, then generate if
     * we still owe the caller a message.
     */
    const runChat = async (
        request: PostChatRequest
    ): Promise<PostChatResponse> => {
        const isWeatherLikeRequest = (input: string): boolean => {
            const normalized = input.trim().toLowerCase();
            if (normalized.length === 0) {
                return false;
            }
            return (
                /\b(weather|forecast|temperature|temp|rain|snow|wind)\b/.test(
                    normalized
                ) && /\b(in|at|for|near)\b/.test(normalized)
            );
        };
        // Total wall-clock budget for this request from planner entry to
        // final response payload. This is exposed as telemetry only.
        const orchestrationStartedAt = Date.now();
        const { normalizedConversation, normalizedRequest } = normalizeRequest(
            request,
            chatOrchestratorLogger
        );
        const clarificationContinuation =
            resolveWeatherClarificationContinuation(normalizedRequest);
        let evaluatorExecutionContext: EvaluatorExecutionContext | undefined;
        const notifyBreakerEvent = (input: {
            responseId: string | null;
            responseAction: 'message' | 'ignore' | 'react' | 'image';
            responseModality: ChatPlan['modality'];
        }): void => {
            const breakerDecision =
                evaluatorExecutionContext?.outcome?.safetyDecision;
            if (
                evaluatorExecutionContext?.status !== 'executed' ||
                !breakerDecision ||
                breakerDecision.action === 'allow'
            ) {
                return;
            }

            const correlation = buildCorrelationIds(
                normalizedRequest,
                input.responseId
            );
            const authorityLevel =
                evaluatorExecutionContext.outcome?.authorityLevel ??
                (evaluatorExecutionContext.outcome?.mode === 'enforced'
                    ? 'enforce'
                    : 'influence');
            const enforcement: 'observe_only' | 'enforced' =
                authorityLevel === 'enforce' ? 'enforced' : 'observe_only';
            chatOrchestratorLogger.info(
                'chat.orchestration.breaker_action_applied',
                {
                    event: 'chat.orchestration.breaker_action_applied',
                    authorityLevel,
                    mode: evaluatorExecutionContext.outcome?.mode,
                    action: breakerDecision.action,
                    ruleId: breakerDecision.ruleId,
                    reasonCode: breakerDecision.reasonCode,
                    reason: breakerDecision.reason,
                    safetyTier: breakerDecision.safetyTier,
                    enforcement,
                    responseAction: input.responseAction,
                    responseModality: input.responseModality,
                    correlation,
                }
            );
            if (alertRouter) {
                void alertRouter.notify({
                    type: 'breaker',
                    action: 'chat.orchestration.breaker_action_applied',
                    surface: normalizedRequest.surface,
                    authorityLevel: authorityLevel ?? 'observe',
                    enforcement,
                    breakerAction: breakerDecision.action,
                    ruleId: breakerDecision.ruleId,
                    reasonCode: breakerDecision.reasonCode,
                    reason: breakerDecision.reason,
                    safetyTier: breakerDecision.safetyTier,
                    responseAction: input.responseAction,
                    responseModality: input.responseModality,
                    responseId: input.responseId,
                    correlation,
                });
            }
        };
        const evaluatorStartedAt = Date.now();
        const evaluatorResult = runDeterministicEvaluator(
            {
                normalizedConversation,
                normalizedRequest,
                startedAtMs: evaluatorStartedAt,
            },
            chatOrchestratorLogger
        );
        evaluatorExecutionContext = evaluatorResult.evaluatorExecutionContext;
        const evaluatorSafetyTierHint = evaluatorResult.evaluatorSafetyTierHint;

        const personaProfile = resolveChatPersonaProfile(
            normalizedRequest,
            chatOrchestratorLogger
        );
        const botProfileDisplayName = resolveBotProfileDisplayName(
            normalizedRequest,
            chatOrchestratorLogger
        );
        // Planner is a bounded, execution-relevant helper. It can suggest
        // action-selection details, but it is not policy authority, contract
        // authority, runtime ownership, or a second orchestrator.
        const plannerInvocationContext: ChatPlannerInvocationContext = {
            owner: 'workflow',
            workflowName: 'chat_orchestration',
            stepKind: 'plan',
            purpose: 'chat_orchestrator_action_selection',
        };
        const planned = await chatPlanner.planChat(
            normalizedRequest,
            plannerInvocationContext
        );
        const plannerExecution = planned.execution;
        const plannerDiagnostics = planned.diagnostics;
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
        // Contract-governed routing boundary:
        // 1) resolve initial high-level workflow mode (fixed for this run in v1)
        // 2) derive Execution Contract preset from mode
        // 3) execute orchestration within that contract
        const workflowModeResolution = resolveWorkflowModeDecision({
            modeId: runtimeConfig.chatWorkflow.modeId,
        });
        // Pick the run mode first, then derive the contract from it. That keeps
        // later branches from inventing their own policy rules.
        // TODO(workflow-mode-escalation): Add optional runtime mode transitions
        // (for example fast -> grounded) when later retrieval/sufficiency
        // signals justify escalation. This is future behavior only, and should
        // stay attached to centralized mode routing policy.
        const resolvedExecutionContract = resolveExecutionContract({
            presetId:
                workflowModeResolution.modeDecision.behavior
                    .executionContractPresetId,
        }).policyContract;
        const plannerResultApplier = createPlannerResultApplier({
            enabledProfiles,
            searchCapableProfiles,
            enabledProfilesById,
            defaultResponseProfile,
            weatherForecastTool,
            logger: chatOrchestratorLogger,
        });
        const plannerApplication = plannerResultApplier({
            normalizedRequest,
            plannerStepResult: {
                plan: planned.plan,
                execution: planned.execution,
                ingestion: {
                    outputApplyOutcome:
                        planned.execution.status === 'executed'
                            ? 'accepted'
                            : 'rejected',
                    fallbackTier:
                        planned.execution.status === 'executed'
                            ? 'none'
                            : 'safe_default_plan',
                    correctionCodes: [],
                    outOfContractFields: [],
                    authorityFieldAttempts: [],
                },
                diagnostics: planned.diagnostics,
            },
            clarificationContinuation,
            resolvedExecutionPolicy: resolvedExecutionContract,
        });
        fallbackReasons.push(
            ...(plannerApplication.fallbackReasons as PlannerFallbackReason[])
        );
        const plan = plannerApplication.plan;
        const surfacePolicy = plannerApplication.surfacePolicy;
        const generationForExecution =
            plannerApplication.generationForExecution;
        const selectedResponseProfile =
            plannerApplication.selectedResponseProfile;
        const fallbackRollupSelectionSource =
            plannerApplication.fallbackRollupSelectionSource as PlannerSelectionSource;
        const originalSelectedProfileId =
            plannerApplication.originalSelectedProfileId;
        const effectiveSelectedProfileId =
            plannerApplication.effectiveSelectedProfileId;
        const rerouteApplied = plannerApplication.rerouteApplied;
        const toolRequestContext = plannerApplication.toolRequestContext;
        const toolIntent = generationForExecution.toolIntent;
        const toolExecutionContext = plannerApplication.toolExecutionContext;
        const weatherContextStepRequest = plannerApplication.contextStepRequest;
        const weatherContextStepExecutor =
            weatherContextStepRequest !== undefined
                ? createToolRegistryContextStepExecutor({
                      weatherForecastTool,
                      onWarn: (message, meta) => {
                          chatOrchestratorLogger.warn(message, meta);
                      },
                  })
                : undefined;
        const weatherRouting = {
            weatherLikeRequest: isWeatherLikeRequest(
                normalizedRequest.latestUserInput
            ),
            plannerToolIntentPresent:
                plannerDiagnostics.normalizedToolIntentPresent,
            plannerRawToolIntentPresent:
                plannerDiagnostics.rawToolIntentPresent,
            plannerRawToolIntentName: plannerDiagnostics.rawToolIntentName,
            plannerNormalizedToolIntentName:
                plannerDiagnostics.normalizedToolIntentName,
            plannerToolIntentRejected: plannerDiagnostics.toolIntentRejected,
            plannerToolIntentRejectionReasons:
                plannerDiagnostics.toolIntentRejectionReasons,
            plannerRequestedWeather:
                plannerDiagnostics.normalizedToolIntentName ===
                'weather_forecast',
            toolSelectionRequested: toolRequestContext.requested,
            toolSelectionEligible: toolRequestContext.eligible,
            toolSelectionToolName: toolRequestContext.toolName,
            toolSelectionReasonCode: toolRequestContext.reasonCode,
            selectedWeather: toolRequestContext.toolName === 'weather_forecast',
        };
        if (
            weatherRouting.weatherLikeRequest ||
            weatherRouting.selectedWeather
        ) {
            chatOrchestratorLogger.info('chat.weather.routing', {
                event: 'chat.weather.routing',
                stage: 'selection',
                surface: normalizedRequest.surface,
                ...weatherRouting,
            });
        }
        const steerabilityControls = buildSteerabilityControls({
            workflowMode: workflowModeResolution.modeDecision,
            executionContractResponseMode:
                resolvedExecutionContract.response.responseMode,
            requestedProfileId: normalizedRequest.profileId,
            plannerSelectedProfileId: plan.profileId,
            selectedProfile: {
                profileId: selectedResponseProfile.id,
                provider: selectedResponseProfile.provider,
                model: selectedResponseProfile.providerModel,
            },
            persona: {
                personaId: personaProfile.id,
                overlaySource: personaProfile.promptOverlay.source,
            },
            toolRequest: toolRequestContext,
        });
        const steerabilityConflictResolution =
            resolveInternalSteerabilityControlConflicts({
                requestedProfileId: normalizedRequest.profileId,
                plannerSelectedProfileId: plan.profileId,
                selectedProfileId: selectedResponseProfile.id,
                personaOverlaySource: personaProfile.promptOverlay.source,
            });
        const plannerMatteredControlIds =
            plannerExecution.status === 'executed'
                ? steerabilityControls.controls
                      .filter(
                          (control) =>
                              (control.source === 'planner_output' ||
                                  control.source === 'tool_policy' ||
                                  control.source === 'capability_policy') &&
                              control.mattered
                      )
                      .map((control) => control.controlId)
                : [];
        const providerPreferencePolicyAdjusted =
            steerabilityConflictResolution.providerPreference
                .wasOverriddenByExecutionPolicy;
        // Planner influence is emitted on execution[] planner fields.
        // Control influence is emitted separately via steerabilityControls.
        // `mattered` remains an observed-material-effect signal, not full causal proof.
        const plannerMattered = plannerMatteredControlIds.length > 0;
        // TODO(planner-adjustment-taxonomy): Split this top-level
        // `adjusted_by_policy` bucket only after materially distinct classes
        // appear in practice. Keep one stable top-level outcome and add detail
        // alongside it, rather than overloading enum semantics.
        const plannerApplyOutcome =
            plannerExecution.status !== 'executed'
                ? 'not_applied'
                : surfacePolicy !== undefined ||
                    providerPreferencePolicyAdjusted ||
                    rerouteApplied ||
                    plannerApplication.plannerApplyOutcome ===
                        'adjusted_by_policy'
                  ? 'adjusted_by_policy'
                  : 'applied';
        const emitControlObservability = (input: {
            responseAction: 'message' | 'ignore' | 'react' | 'image';
            responseModality: ChatPlan['modality'];
        }): void => {
            try {
                const observabilityEnvelope = buildControlObservabilityEnvelope(
                    {
                        surface: normalizedRequest.surface,
                        workflowModeId:
                            workflowModeResolution.modeDecision.modeId,
                        executionContractResponseMode:
                            resolvedExecutionContract.response.responseMode,
                        requestedProfileId: normalizedRequest.profileId,
                        plannerSelectedProfileId: plan.profileId,
                        selectedProfileId: selectedResponseProfile.id,
                        personaOverlaySource:
                            personaProfile.promptOverlay.source,
                        toolRequest: toolRequestContext,
                        plannerApplyOutcome,
                        plannerMatteredControlIds,
                        plannerStatus: plannerExecution.status,
                        plannerReasonCode: plannerExecution.reasonCode,
                        responseAction: input.responseAction,
                        responseModality: input.responseModality,
                        steerabilityControls,
                    }
                );
                emitControlObservabilityEnvelope(
                    chatOrchestratorLogger,
                    observabilityEnvelope
                );
            } catch (error) {
                chatOrchestratorLogger.warn(
                    'chat.steerability.control_observability_failed_open',
                    {
                        event: 'chat.steerability.control_observability_failed_open',
                        reason:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        surface: normalizedRequest.surface,
                        plannerStatus: plannerExecution.status,
                    }
                );
            }
        };
        // TODO(planner-correlation-id): If chat orchestration ever runs
        // multiple planner passes/retries per response, add explicit correlation
        // fields while preserving workflow-owned planner boundaries.
        // Persist the effective profile id in planner payload/snapshot so traces
        // reflect what was actually executed.
        const executionPlan: ChatPlan = {
            ...plan,
            generation: generationForExecution,
            profileId: selectedResponseProfile.id,
            ...(plannerApplication.selectedCapabilityProfile !== undefined && {
                selectedCapabilityProfile:
                    plannerApplication.selectedCapabilityProfile,
            }),
        };

        const plannerActionOutcome = resolvePlannerActionOutcome({
            executionPlan,
            normalizedRequest,
        });
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
        const weatherExecutionAttempted =
            toolExecutionContext?.toolName === 'weather_forecast' &&
            (toolExecutionContext.status === 'executed' ||
                toolExecutionContext.status === 'failed');
        const weatherOutcome =
            toolRequestContext.toolName === 'weather_forecast' &&
            toolRequestContext.requested
                ? 'not_executed'
                : 'not_selected';
        if (
            weatherRouting.weatherLikeRequest ||
            weatherRouting.selectedWeather
        ) {
            chatOrchestratorLogger.info('chat.weather.routing', {
                event: 'chat.weather.routing',
                stage: 'execution',
                surface: normalizedRequest.surface,
                ...weatherRouting,
                weatherExecutionAttempted,
                weatherToolStatus: toolExecutionContext?.status,
                weatherToolReasonCode: toolExecutionContext?.reasonCode,
                weatherOutcome,
            });
        }

        if (
            clarificationContinuation.kind === 'unresolved' &&
            clarificationContinuation.pending.options.length > 0
        ) {
            return buildToolClarificationResponse({
                toolContext: {
                    toolName: 'weather_forecast',
                    status: 'executed',
                    clarification: {
                        reasonCode: 'ambiguous_location',
                        question: clarificationContinuation.pending.question,
                        options: clarificationContinuation.pending.options.map(
                            (option) => ({
                                id: option.id,
                                label: option.label,
                                value: {
                                    toolName: 'weather_forecast',
                                    input: option.input,
                                },
                            })
                        ),
                    },
                },
                metadataContext: {
                    modelVersion: selectedResponseProfile.providerModel,
                    conversationSnapshot: JSON.stringify({
                        request: normalizedRequest,
                        planner: {
                            action: executionPlan.action,
                            modality: executionPlan.modality,
                            profileId: executionPlan.profileId,
                            safetyTier: executionPlan.safetyTier,
                            generation: executionPlan.generation,
                            toolIntent,
                            toolRequest: toolRequestContext,
                            ...(surfacePolicy && { surfacePolicy }),
                        },
                        executionContract: {
                            policyId: resolvedExecutionContract.policyId,
                            policyVersion:
                                resolvedExecutionContract.policyVersion,
                        },
                        clarification: {
                            toolName: 'weather_forecast',
                            reasonCode: 'ambiguous_location',
                        },
                    }),
                    executionContext: {
                        planner: {
                            status: plannerExecution.status,
                            reasonCode: plannerExecution.reasonCode,
                            purpose: plannerExecution.purpose,
                            contractType: plannerExecution.contractType,
                            applyOutcome: plannerApplyOutcome,
                            mattered: plannerMattered,
                            matteredControlIds: plannerMatteredControlIds,
                            profileId: plannerProfile.id,
                            originalProfileId: plannerProfile.id,
                            effectiveProfileId: plannerProfile.id,
                            provider: plannerProfile.provider,
                            model: plannerProfile.providerModel,
                            durationMs: plannerExecution.durationMs,
                        },
                        evaluator: evaluatorExecutionContext,
                        generation: {
                            status: 'executed',
                            profileId: selectedResponseProfile.id,
                            originalProfileId: originalSelectedProfileId,
                            effectiveProfileId: effectiveSelectedProfileId,
                            provider: selectedResponseProfile.provider,
                            model: selectedResponseProfile.providerModel,
                        },
                    },
                },
                buildResponseMetadata,
            });
        }

        const clarificationShortCircuitHit = false;
        if (
            (weatherRouting.weatherLikeRequest ||
                weatherRouting.selectedWeather) &&
            !weatherExecutionAttempted
        ) {
            chatOrchestratorLogger.warn(
                'chat.weather.routing.normal_generation_without_weather_tool',
                {
                    event: 'chat.weather.routing',
                    stage: 'normal_generation_without_weather_tool',
                    surface: normalizedRequest.surface,
                    ...weatherRouting,
                    clarificationShortCircuitHit,
                    weatherExecutionAttempted,
                    weatherOutcome,
                }
            );
        }

        const executionPlanForPrompt: PlannerPayloadChatPlan = {
            ...executionPlan,
            generation: executionPlan.generation,
        };

        const safetyTierRank: Record<SafetyTier, number> = {
            Low: 1,
            Medium: 2,
            High: 3,
        };
        const orchestrationSafetyTier =
            evaluatorSafetyTierHint &&
            safetyTierRank[evaluatorSafetyTierHint] >
                safetyTierRank[executionPlan.safetyTier]
                ? evaluatorSafetyTierHint
                : executionPlan.safetyTier;
        const executionContractScopeTuple =
            buildExecutionContractScopeTuple(normalizedRequest);

        if (plannerActionOutcome.kind === 'terminal_action') {
            if (plannerActionOutcome.fallbackReason !== undefined) {
                fallbackReasons.push(plannerActionOutcome.fallbackReason);
            }
            if (plannerActionOutcome.warningMessage !== undefined) {
                chatOrchestratorLogger.warn(
                    plannerActionOutcome.warningMessage
                );
            }
            const terminalResponse = plannerTerminalActionToResponse(
                plannerActionOutcome.terminalAction
            );
            return terminalResponse;
        }

        const postPlanAssembly = assemblePostPlanGenerationInput({
            systemPrompt: promptLayers.systemPrompt,
            personaPrompt,
            normalizedConversation,
            executionPlanForPrompt,
            surfacePolicy,
            normalizedRequest,
            orchestrationSafetyTier,
            toolIntent,
            toolRequestContext,
            executionContract: {
                policyId: resolvedExecutionContract.policyId,
                policyVersion: resolvedExecutionContract.policyVersion,
            },
        });

        // By the time we call ChatService, planner output and request overrides
        // have already been folded into one concrete profile and generation
        // plan.
        const response = await chatService.runChatMessagesWithOutcome({
            messages: postPlanAssembly.conversationMessages,
            conversationSnapshot: postPlanAssembly.conversationSnapshot,
            orchestrationStartedAtMs: orchestrationStartedAt,
            plannerTemperament: executionPlan.generation.temperament,
            safetyTier: orchestrationSafetyTier,
            model: selectedResponseProfile.providerModel,
            provider: selectedResponseProfile.provider,
            capabilities: selectedResponseProfile.capabilities,
            generation: executionPlan.generation,
            workflowModeId: workflowModeResolution.modeDecision.modeId,
            toolRequest: toolRequestContext,
            plannerActionOutcome,
            contextStepRequest: weatherContextStepRequest,
            contextStepExecutor: weatherContextStepExecutor,
            latestUserInput: normalizedRequest.latestUserInput,
            ExecutionContract: resolvedExecutionContract,
            ...(executionContractScopeTuple !== undefined && {
                executionContractTrustGraphContext: {
                    queryIntent: normalizedRequest.latestUserInput,
                    scopeTuple: executionContractScopeTuple,
                },
            }),
            executionContext: {
                // Planner execution metadata is sourced from ChatPlannerResult
                // so traces can distinguish successful planning from fallback.
                // This metadata reports planner influence; it does not delegate
                // orchestration ownership or policy authority to planner.
                planner: {
                    status: plannerExecution.status,
                    ...(plannerExecution.reasonCode !== undefined && {
                        reasonCode: plannerExecution.reasonCode,
                    }),
                    purpose: plannerExecution.purpose,
                    contractType: plannerExecution.contractType,
                    applyOutcome: plannerApplyOutcome,
                    mattered: plannerMattered,
                    matteredControlIds: plannerMatteredControlIds,
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
            steerabilityControls,
        });
        if (response.kind === 'terminal_action') {
            const terminalResponse =
                response.response ??
                ({
                    action: 'ignore',
                    metadata: null,
                } as const);
            emitFallbackRollup(fallbackRollupSelectionSource);
            notifyBreakerEvent({
                responseId: null,
                responseAction: terminalResponse.action,
                responseModality: executionPlan.modality,
            });
            emitControlObservability({
                responseAction: terminalResponse.action,
                responseModality: executionPlan.modality,
            });
            return terminalResponse;
        }
        if (response.metadata === undefined || response.message === undefined) {
            chatOrchestratorLogger.warn(
                'ChatService returned message outcome without message metadata; failing open to ignore.'
            );
            emitFallbackRollup(fallbackRollupSelectionSource);
            notifyBreakerEvent({
                responseId: null,
                responseAction: 'ignore',
                responseModality: executionPlan.modality,
            });
            emitControlObservability({
                responseAction: 'ignore',
                responseModality: executionPlan.modality,
            });
            return {
                action: 'ignore',
                metadata: null,
            };
        }
        // ChatService computes totalDurationMs before metadata assembly and
        // queued trace writes. Avoid mutating metadata here to keep trace
        // persistence race-free.
        const totalDurationMs =
            response.metadata.totalDurationMs ??
            Math.max(0, Date.now() - orchestrationStartedAt);
        emitFallbackRollup(fallbackRollupSelectionSource);
        notifyBreakerEvent({
            responseId: response.metadata.responseId,
            responseAction: 'message',
            responseModality: executionPlan.modality,
        });
        emitControlObservability({
            responseAction: 'message',
            responseModality: executionPlan.modality,
        });
        chatOrchestratorLogger.info({
            event: 'chat.orchestration.timing',
            surface: normalizedRequest.surface,
            plannerStatus: plannerExecution.status,
            plannerReasonCode: plannerExecution.reasonCode,
            plannerDurationMs: plannerExecution.durationMs,
            evaluatorStatus: evaluatorExecutionContext?.status,
            evaluatorReasonCode: evaluatorExecutionContext?.reasonCode,
            evaluatorSafetyTier:
                evaluatorExecutionContext?.outcome?.safetyDecision.safetyTier,
            evaluatorProvenance: evaluatorExecutionContext?.outcome?.provenance,
            evaluatorMode: evaluatorExecutionContext?.outcome?.mode,
            evaluatorAuthorityLevel:
                evaluatorExecutionContext?.outcome?.authorityLevel,
            generationDurationMs: response.generationDurationMs,
            totalDurationMs,
            plannerProfileId: plannerProfile.id,
            incomingBotPersonaId:
                normalizedRequest.botPersonaId?.trim() || null,
            personaProfileId: personaProfile.id,
            personaDisplayName: personaProfile.displayName,
            personaOverlaySource: personaProfile.promptOverlay.source,
            personaOverlayLength: personaProfile.promptOverlay.length,
            responseProfileId: selectedResponseProfile.id,
            originalProfileId: originalSelectedProfileId,
            effectiveProfileId: effectiveSelectedProfileId,
            requestedCapabilityProfile: plan.requestedCapabilityProfile,
            selectedCapabilityProfile:
                plannerApplication.selectedCapabilityProfile,
            capabilityReasonCode: plannerApplication.capabilityReasonCode,
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
            executionContractId: resolvedExecutionContract.policyId,
            executionContractVersion: resolvedExecutionContract.policyVersion,
            routingStrategy: resolvedExecutionContract.routing.strategy,
            workflowModeId: workflowModeResolution.modeDecision.modeId,
            workflowModeSelectedBy:
                workflowModeResolution.modeDecision.selectedBy,
            responseId: response.metadata.responseId,
            responseAction: 'message',
            responseModality: executionPlan.modality,
            responseProvenance: response.metadata.provenance,
            responseSafetyTier: response.metadata.safetyTier,
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
