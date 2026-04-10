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
import type { SafetyTier } from '@footnote/contracts/ethics-core';
import { renderConversationPromptLayers } from './prompts/conversationPromptLayers.js';
import {
    createChatService,
    type CreateChatServiceOptions,
} from './chatService.js';
import { createChatPlanner, type ChatPlan } from './chatPlanner.js';
import { createOpenAiChatPlannerStructuredExecutor } from './chatPlannerStructuredOpenAi.js';
import type { ChatGenerationPlan } from './chatGenerationTypes.js';
import {
    resolveActiveProfileOverlayPrompt,
    resolveBotProfileDisplayName,
    resolveChatPersonaProfile,
} from './chatProfileOverlay.js';
import { coercePlanForSurface } from './chatSurfacePolicy.js';
import { createModelProfileResolver } from './modelProfileResolver.js';
import { listCapabilityProfileOptionsForStep } from './modelCapabilityPolicy.js';
import {
    createPlannerFallbackTelemetryRollup,
    type PlannerFallbackReason,
    type PlannerSelectionSource,
} from './plannerFallbackTelemetryRollup.js';
import { resolveExecutionContract } from './executionContractResolver.js';
import { resolveWorkflowModeDecision } from './workflowProfileRegistry.js';
import type { WeatherForecastTool } from './weatherGovForecastTool.js';
import { applySingleToolPolicy } from './tools/toolPolicy.js';
import {
    executeSelectedTool,
    resolveToolSelection,
} from './tools/toolRegistry.js';
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
import { resolveExecutionProfile } from './chatOrchestrator/profileResolution.js';
import { resolveNonMessagePlannerAction } from './chatOrchestrator/actionResolution.js';
import {
    buildPlannerPayload,
    type PlannerGenerationForPrompt,
    type PlannerPayloadChatPlan,
} from './chatOrchestrator/plannerPayload.js';

type CreateChatOrchestratorOptions = CreateChatServiceOptions & {
    weatherForecastTool?: WeatherForecastTool;
    alertRouter?: IncidentAlertRouter;
};

const plannerFallbackTelemetryRollup = createPlannerFallbackTelemetryRollup({
    logger,
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
        const { normalizedConversation, normalizedRequest } = normalizeRequest(
            request,
            chatOrchestratorLogger
        );
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
            const enforcement: 'observe_only' | 'enforced' =
                evaluatorExecutionContext.outcome?.mode === 'observe_only'
                    ? 'observe_only'
                    : 'enforced';
            chatOrchestratorLogger.info(
                'chat.orchestration.breaker_action_applied',
                {
                    event: 'chat.orchestration.breaker_action_applied',
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
        // - `/chat` style submit requests may explicitly override via
        //   request.profileId.
        // - Non-submit requests defer to planner-selected capability profile.
        // - Startup default profile remains final fail-open fallback.
        // Fallback ownership:
        // - workflow profile fallback: workflowProfileRegistry
        // - model selector/default fallback: modelProfileResolver
        // - planner output fallback: chatPlanner
        // Keep each fallback policy in its owner; do not duplicate here.
        // Runtime resolution stays authoritative and fail-open:
        // unknown/disabled selections never hard-fail the request.
        // Request-level generation overrides are advisory knobs from callers
        // like `/chat` that want quick side-by-side runs without changing
        // planner prompt semantics.
        const requestGeneration = normalizedRequest.generation;
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
        const workflowModeResolution = resolveWorkflowModeDecision({
            modeId: runtimeConfig.chatWorkflow.modeId,
            executionContractResponseMode:
                generationForExecution.responseIntentHint?.responseMode,
        });
        const resolvedExecutionContract = resolveExecutionContract({
            presetId:
                workflowModeResolution.modeDecision.behavior
                    .executionContractPresetId,
        }).policyContract;
        const profileResolution = resolveExecutionProfile(
            {
                normalizedRequest,
                plan,
                enabledProfiles,
                searchCapableProfiles,
                enabledProfilesById,
                defaultResponseProfile,
                generationForExecution,
                resolvedExecutionPolicy: resolvedExecutionContract,
            },
            chatOrchestratorLogger
        );
        generationForExecution = profileResolution.generationForExecution;
        fallbackReasons.push(...profileResolution.fallbackReasons);
        const selectedResponseProfile =
            profileResolution.selectedResponseProfile;
        const fallbackRollupSelectionSource =
            profileResolution.fallbackRollupSelectionSource;
        const originalSelectedProfileId =
            profileResolution.originalSelectedProfileId;
        const effectiveSelectedProfileId =
            profileResolution.effectiveSelectedProfileId;
        const rerouteApplied = profileResolution.rerouteApplied;
        const webSearchToolRequestContextOverride =
            profileResolution.webSearchToolRequestContextOverride;
        let toolExecutionContext = profileResolution.toolExecutionContext;
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
            selectedCapabilityProfile:
                profileResolution.selectedCapabilityProfile,
        };

        const nonMessageResponse = resolveNonMessagePlannerAction(
            {
                executionPlan,
                normalizedRequest,
                fallbackRollupSelectionSource,
            },
            {
                fallbackReasons,
                emitFallbackRollup,
                notifyBreakerEvent,
                warn: (message, meta) => {
                    chatOrchestratorLogger.warn(message, meta);
                },
            }
        );
        if (nonMessageResponse) {
            return nonMessageResponse;
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
                    safetyTier: orchestrationSafetyTier,
                    generation: plannerGenerationForPrompt,
                    toolIntent,
                    toolRequest: toolRequestContext,
                    ...(surfacePolicy && { surfacePolicy }),
                },
                executionContract: {
                    policyId: resolvedExecutionContract.policyId,
                    policyVersion: resolvedExecutionContract.policyVersion,
                },
            }),
            orchestrationStartedAtMs: orchestrationStartedAt,
            plannerTemperament: executionPlan.generation.temperament,
            safetyTier: orchestrationSafetyTier,
            model: selectedResponseProfile.providerModel,
            provider: selectedResponseProfile.provider,
            capabilities: selectedResponseProfile.capabilities,
            generation: executionPlan.generation,
            workflowModeId: workflowModeResolution.modeDecision.modeId,
            toolRequest: toolRequestContext,
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
        emitFallbackRollup(fallbackRollupSelectionSource);
        notifyBreakerEvent({
            responseId: response.metadata.responseId,
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
                profileResolution.selectedCapabilityProfile,
            capabilityReasonCode: profileResolution.capabilityReasonCode,
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
