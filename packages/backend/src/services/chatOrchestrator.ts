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
import { assemblePlanGenerationInput } from './chatService/planGenerationInput.js';
import { classifyPlanContinuation } from './chatService/planContinuation.js';
import {
    buildControlObservabilityEnvelope,
    emitControlObservabilityEnvelope,
} from './steerabilityControlObservability.js';
import type {
    PlannerStepExecutor,
    PlannerStepResult,
    PlanContinuationBuilder,
    AppliedPlanState,
} from './plannerWorkflowSeams.js';

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
        const toPlannerStepResult = (
            plannerResult: Awaited<ReturnType<typeof chatPlanner.planChat>>
        ): PlannerStepResult => ({
            plan: plannerResult.plan,
            execution: {
                ...plannerResult.execution,
                profileId: plannerProfile.id,
                provider: plannerProfile.provider,
                model: plannerProfile.providerModel,
            },
            ingestion: {
                outputApplyOutcome:
                    plannerResult.execution.status === 'executed'
                        ? 'accepted'
                        : 'rejected',
                fallbackTier:
                    plannerResult.execution.status === 'executed'
                        ? 'none'
                        : 'safe_default_plan',
                correctionCodes: [],
                outOfContractFields: [],
                authorityFieldAttempts: [],
            },
            diagnostics: plannerResult.diagnostics,
        });
        const plannerStepExecutor: PlannerStepExecutor = async (input) =>
            toPlannerStepResult(
                await chatPlanner.planChat(
                    input.request,
                    input.invocationContext
                )
            );
        const fallbackReasons: PlannerFallbackReason[] = [];
        const fallbackRollupSelectionSourceRef: {
            value: PlannerSelectionSource;
        } = { value: 'default' };
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
        const weatherContextStepExecutor =
            createToolRegistryContextStepExecutor({
                weatherForecastTool,
                onWarn: (message, meta) => {
                    chatOrchestratorLogger.warn(message, meta);
                },
            });
        const buildPlannerSummary = (input: {
            plannerStepResult: PlannerStepResult;
            plannerApplication: ReturnType<typeof plannerResultApplier>;
            executionPlan: ChatPlan;
        }): AppliedPlanState => ({
            executionPlan: input.executionPlan,
            generationForExecution:
                input.plannerApplication.generationForExecution,
            selectedResponseProfile: {
                id: input.plannerApplication.selectedResponseProfile.id,
                provider:
                    input.plannerApplication.selectedResponseProfile.provider,
                providerModel:
                    input.plannerApplication.selectedResponseProfile
                        .providerModel,
                capabilities:
                    input.plannerApplication.selectedResponseProfile
                        .capabilities,
            },
            originalSelectedProfileId:
                input.plannerApplication.originalSelectedProfileId,
            effectiveSelectedProfileId:
                input.plannerApplication.effectiveSelectedProfileId,
            ...(input.plannerApplication.selectedCapabilityProfile !==
                undefined && {
                selectedCapabilityProfile:
                    input.plannerApplication.selectedCapabilityProfile,
            }),
            ...(input.plannerApplication.capabilityReasonCode !== undefined && {
                capabilityReasonCode:
                    input.plannerApplication.capabilityReasonCode,
            }),
            toolRequestContext: input.plannerApplication.toolRequestContext,
            ...(input.plannerApplication.toolExecutionContext !== undefined && {
                toolExecutionContext:
                    input.plannerApplication.toolExecutionContext,
            }),
            plannerDiagnostics: {
                rawToolIntentPresent:
                    input.plannerStepResult.diagnostics.rawToolIntentPresent,
                ...(input.plannerStepResult.diagnostics.rawToolIntentName !==
                    undefined && {
                    rawToolIntentName:
                        input.plannerStepResult.diagnostics.rawToolIntentName,
                }),
                normalizedToolIntentPresent:
                    input.plannerStepResult.diagnostics
                        .normalizedToolIntentPresent,
                ...(input.plannerStepResult.diagnostics
                    .normalizedToolIntentName !== undefined && {
                    normalizedToolIntentName:
                        input.plannerStepResult.diagnostics
                            .normalizedToolIntentName,
                }),
                toolIntentRejected:
                    input.plannerStepResult.diagnostics.toolIntentRejected,
                toolIntentRejectionReasons:
                    input.plannerStepResult.diagnostics
                        .toolIntentRejectionReasons,
            },
            plannerApplyOutcome: input.plannerApplication.plannerApplyOutcome,
            plannerMattered: input.plannerApplication.plannerMattered,
            plannerMatteredControlIds:
                input.plannerApplication.plannerMatteredControlIds,
            fallbackReasons: [...fallbackReasons],
            fallbackRollupSelectionSource:
                input.plannerApplication.fallbackRollupSelectionSource,
            modality: input.executionPlan.modality,
            safetyTier: input.executionPlan.safetyTier,
            searchRequested:
                input.plannerApplication.generationForExecution.search !==
                undefined,
        });
        const plannerStepRequest = {
            workflowId: 'wf_chat_orchestration',
            workflowName: 'chat_orchestration',
            attempt: 1,
            request: normalizedRequest,
            invocationContext: plannerInvocationContext,
            capabilityProfiles: plannerCapabilityOptions,
        };
        // Applies backend policy to planner output and returns the next
        // workflow action (`terminal_action` or `continue_message`).
        const planContinuationBuilder: PlanContinuationBuilder = (input) => {
            if (input.plannerStepResult.execution.status === 'failed') {
                const plannerFailureReason: PlannerFallbackReason =
                    input.plannerStepResult.execution.reasonCode ===
                    'planner_invalid_output'
                        ? 'planner_execution_failed_planner_invalid_output'
                        : input.plannerStepResult.execution.reasonCode ===
                            'planner_runtime_error'
                          ? 'planner_execution_failed_planner_runtime_error'
                          : 'planner_execution_failed_unknown';
                fallbackReasons.push(plannerFailureReason);
            }
            const plannerApplication = plannerResultApplier({
                normalizedRequest,
                plannerStepResult: input.plannerStepResult,
                clarificationContinuation,
                resolvedExecutionPolicy: resolvedExecutionContract,
            });
            fallbackReasons.push(
                ...(plannerApplication.fallbackReasons as PlannerFallbackReason[])
            );
            fallbackRollupSelectionSourceRef.value =
                plannerApplication.fallbackRollupSelectionSource as PlannerSelectionSource;
            const executionPlan: ChatPlan = {
                ...plannerApplication.plan,
                generation: plannerApplication.generationForExecution,
                profileId: plannerApplication.selectedResponseProfile.id,
                ...(plannerApplication.selectedCapabilityProfile !==
                    undefined && {
                    selectedCapabilityProfile:
                        plannerApplication.selectedCapabilityProfile,
                }),
            };
            const plannerActionOutcome = classifyPlanContinuation({
                executionPlan,
                normalizedRequest,
            });
            if (plannerActionOutcome.kind === 'terminal_action') {
                if (plannerActionOutcome.fallbackReason !== undefined) {
                    fallbackReasons.push(plannerActionOutcome.fallbackReason);
                }
                if (plannerActionOutcome.warningMessage !== undefined) {
                    chatOrchestratorLogger.warn(
                        plannerActionOutcome.warningMessage
                    );
                }
                return {
                    continuation: 'terminal_action' as const,
                    terminalAction: plannerActionOutcome.terminalAction,
                    plannerSummary: buildPlannerSummary({
                        plannerStepResult: input.plannerStepResult,
                        plannerApplication,
                        executionPlan,
                    }),
                };
            }
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
            const postPlanAssembly = assemblePlanGenerationInput({
                systemPrompt: promptLayers.systemPrompt,
                personaPrompt,
                normalizedConversation,
                executionPlanForPrompt: executionPlan,
                ...(plannerApplication.surfacePolicy !== undefined && {
                    surfacePolicy: plannerApplication.surfacePolicy,
                }),
                normalizedRequest,
                orchestrationSafetyTier,
                toolIntent:
                    plannerApplication.generationForExecution.toolIntent,
                toolRequestContext: plannerApplication.toolRequestContext,
                executionContract: {
                    policyId: resolvedExecutionContract.policyId,
                    policyVersion: resolvedExecutionContract.policyVersion,
                },
            });
            const plannerPayloadMessage =
                postPlanAssembly.conversationMessages.at(-1);
            const mergedMessagesWithHints =
                plannerPayloadMessage !== undefined &&
                input.baseMessagesWithHints.length > 0
                    ? [...input.baseMessagesWithHints, plannerPayloadMessage]
                    : postPlanAssembly.conversationMessages;
            return {
                continuation: 'continue_message' as const,
                messagesWithHints: mergedMessagesWithHints,
                generationRequest: {
                    ...input.baseGenerationRequest,
                    messages: mergedMessagesWithHints,
                    model: plannerApplication.selectedResponseProfile
                        .providerModel,
                    provider:
                        plannerApplication.selectedResponseProfile.provider,
                    capabilities:
                        plannerApplication.selectedResponseProfile.capabilities,
                    reasoningEffort: executionPlan.generation.reasoningEffort,
                    verbosity: executionPlan.generation.verbosity,
                    search: executionPlan.generation.search,
                },
                plannerTemperament: executionPlan.generation.temperament,
                conversationSnapshot: postPlanAssembly.conversationSnapshot,
                ...(plannerApplication.contextStepRequest !== undefined && {
                    contextStepRequest: plannerApplication.contextStepRequest,
                }),
                plannerSummary: buildPlannerSummary({
                    plannerStepResult: input.plannerStepResult,
                    plannerApplication,
                    executionPlan,
                }),
            };
        };
        const baseConversationMessages = [
            { role: 'system' as const, content: promptLayers.systemPrompt },
            { role: 'system' as const, content: personaPrompt },
            ...normalizedConversation,
        ];
        const baseConversationSnapshot = JSON.stringify({
            request: normalizedRequest,
            executionContract: {
                policyId: resolvedExecutionContract.policyId,
                policyVersion: resolvedExecutionContract.policyVersion,
            },
        });
        const executionContractScopeTuple =
            buildExecutionContractScopeTuple(normalizedRequest);
        const response = await chatService.runChatMessagesWithOutcome({
            messages: baseConversationMessages,
            conversationSnapshot: baseConversationSnapshot,
            orchestrationStartedAtMs: orchestrationStartedAt,
            safetyTier: evaluatorSafetyTierHint,
            model: defaultResponseProfile.providerModel,
            provider: defaultResponseProfile.provider,
            capabilities: defaultResponseProfile.capabilities,
            workflowModeId: workflowModeResolution.modeDecision.modeId,
            plannerStepRequest,
            plannerStepExecutor,
            planContinuationBuilder,
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
                evaluator: evaluatorExecutionContext,
            },
        });
        const plannerSummary =
            response.kind === 'message' ? response.plannerSummary : undefined;
        const plannerStepResult =
            response.kind === 'message'
                ? response.plannerStepResult
                : undefined;
        const finalToolExecutionTelemetry =
            response.kind === 'message'
                ? response.finalToolExecutionTelemetry
                : undefined;
        const executionPlan: ChatPlan = plannerSummary?.executionPlan ?? {
            action: 'message',
            modality: 'text',
            profileId: defaultResponseProfile.id,
            safetyTier: 'Low',
            reasoning: 'Fallback execution plan before planner summary.',
            generation: {
                reasoningEffort: 'low',
                verbosity: 'medium',
            },
        };
        const fallbackRollupSelectionSource =
            (plannerSummary?.fallbackRollupSelectionSource as
                | PlannerSelectionSource
                | undefined) ?? fallbackRollupSelectionSourceRef.value;
        const weatherRouting = {
            weatherLikeRequest: isWeatherLikeRequest(
                normalizedRequest.latestUserInput
            ),
            plannerToolIntentPresent:
                plannerSummary?.plannerDiagnostics
                    .normalizedToolIntentPresent ?? false,
            plannerRawToolIntentPresent:
                plannerSummary?.plannerDiagnostics.rawToolIntentPresent ??
                false,
            plannerRawToolIntentName:
                plannerSummary?.plannerDiagnostics.rawToolIntentName,
            plannerNormalizedToolIntentName:
                plannerSummary?.plannerDiagnostics.normalizedToolIntentName,
            plannerToolIntentRejected:
                plannerSummary?.plannerDiagnostics.toolIntentRejected ?? false,
            plannerToolIntentRejectionReasons:
                plannerSummary?.plannerDiagnostics.toolIntentRejectionReasons ??
                [],
            plannerRequestedWeather:
                plannerSummary?.plannerDiagnostics.normalizedToolIntentName ===
                'weather_forecast',
            toolSelectionRequested:
                plannerSummary?.toolRequestContext.requested ?? false,
            toolSelectionEligible:
                plannerSummary?.toolRequestContext.eligible ?? false,
            toolSelectionToolName: plannerSummary?.toolRequestContext.toolName,
            toolSelectionReasonCode:
                plannerSummary?.toolRequestContext.reasonCode,
            selectedWeather:
                plannerSummary?.toolRequestContext.toolName ===
                'weather_forecast',
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
        const weatherExecutionAttempted =
            finalToolExecutionTelemetry?.toolName === 'weather_forecast' &&
            (finalToolExecutionTelemetry.status === 'executed' ||
                finalToolExecutionTelemetry.status === 'failed');
        const weatherOutcome =
            plannerSummary?.toolRequestContext.toolName ===
                'weather_forecast' &&
            plannerSummary.toolRequestContext.requested
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
                weatherToolStatus:
                    finalToolExecutionTelemetry?.status ??
                    plannerSummary?.toolExecutionContext?.status,
                weatherToolReasonCode:
                    finalToolExecutionTelemetry?.reasonCode ??
                    plannerSummary?.toolExecutionContext?.reasonCode,
                weatherOutcome,
            });
        }
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
                    clarificationShortCircuitHit: false,
                    weatherExecutionAttempted,
                    weatherOutcome,
                }
            );
        }
        const emitControlObservability = (input: {
            responseAction: 'message' | 'ignore' | 'react' | 'image';
            responseModality: ChatPlan['modality'];
        }): void => {
            if (
                plannerSummary === undefined ||
                plannerStepResult === undefined
            ) {
                return;
            }
            const runtimeSteerabilityControls = buildSteerabilityControls({
                workflowMode: workflowModeResolution.modeDecision,
                executionContractResponseMode:
                    resolvedExecutionContract.response.responseMode,
                requestedProfileId: normalizedRequest.profileId,
                plannerSelectedProfileId: executionPlan.profileId,
                selectedProfile: {
                    profileId: plannerSummary.selectedResponseProfile.id,
                    provider: plannerSummary.selectedResponseProfile.provider,
                    model: plannerSummary.selectedResponseProfile.providerModel,
                },
                persona: {
                    personaId: personaProfile.id,
                    overlaySource: personaProfile.promptOverlay.source,
                },
                toolRequest: plannerSummary.toolRequestContext,
            });
            try {
                const observabilityEnvelope = buildControlObservabilityEnvelope(
                    {
                        surface: normalizedRequest.surface,
                        workflowModeId:
                            workflowModeResolution.modeDecision.modeId,
                        executionContractResponseMode:
                            resolvedExecutionContract.response.responseMode,
                        requestedProfileId: normalizedRequest.profileId,
                        plannerSelectedProfileId: executionPlan.profileId,
                        selectedProfileId:
                            plannerSummary.selectedResponseProfile.id,
                        personaOverlaySource:
                            personaProfile.promptOverlay.source,
                        toolRequest: plannerSummary.toolRequestContext,
                        plannerApplyOutcome: plannerSummary.plannerApplyOutcome,
                        plannerMatteredControlIds:
                            plannerSummary.plannerMatteredControlIds,
                        plannerStatus: plannerStepResult.execution.status,
                        plannerReasonCode:
                            plannerStepResult.execution.reasonCode,
                        responseAction: input.responseAction,
                        responseModality: input.responseModality,
                        steerabilityControls: runtimeSteerabilityControls,
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
                        plannerStatus: plannerStepResult.execution.status,
                    }
                );
            }
        };
        const finalizedSteerabilityControls =
            plannerSummary !== undefined && plannerStepResult !== undefined
                ? buildSteerabilityControls({
                      workflowMode: workflowModeResolution.modeDecision,
                      executionContractResponseMode:
                          resolvedExecutionContract.response.responseMode,
                      requestedProfileId: normalizedRequest.profileId,
                      plannerSelectedProfileId: executionPlan.profileId,
                      selectedProfile: {
                          profileId: plannerSummary.selectedResponseProfile.id,
                          provider:
                              plannerSummary.selectedResponseProfile.provider,
                          model: plannerSummary.selectedResponseProfile
                              .providerModel,
                      },
                      persona: {
                          personaId: personaProfile.id,
                          overlaySource: personaProfile.promptOverlay.source,
                      },
                      toolRequest: plannerSummary.toolRequestContext,
                  })
                : undefined;
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
        if (finalizedSteerabilityControls !== undefined) {
            response.metadata.steerabilityControls =
                finalizedSteerabilityControls;
        }
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
            plannerStatus: plannerStepResult?.execution.status,
            plannerReasonCode: plannerStepResult?.execution.reasonCode,
            plannerDurationMs: plannerStepResult?.execution.durationMs,
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
            responseProfileId: plannerSummary?.selectedResponseProfile.id,
            originalProfileId: plannerSummary?.originalSelectedProfileId,
            effectiveProfileId: plannerSummary?.effectiveSelectedProfileId,
            requestedCapabilityProfile:
                plannerSummary?.executionPlan.requestedCapabilityProfile,
            selectedCapabilityProfile:
                plannerSummary?.selectedCapabilityProfile,
            capabilityReasonCode: plannerSummary?.capabilityReasonCode,
            searchRequested: plannerSummary?.searchRequested,
            toolName: finalToolExecutionTelemetry?.toolName,
            toolStatus: finalToolExecutionTelemetry?.status,
            toolReasonCode: finalToolExecutionTelemetry?.reasonCode,
            toolEligible: finalToolExecutionTelemetry?.eligible,
            toolRequestReasonCode:
                finalToolExecutionTelemetry?.requestReasonCode,
            rerouteApplied: undefined,
            fallbackApplied:
                plannerStepResult?.execution.status === 'failed' ||
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
