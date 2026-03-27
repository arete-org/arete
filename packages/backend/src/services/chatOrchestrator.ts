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
    ExecutionReasonCode,
    ExecutionStatus,
} from '@footnote/contracts/ethics-core';
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
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type CreateChatOrchestratorOptions = CreateChatServiceOptions;

/**
 * Packs the normalized planner decision into one structured system payload.
 *
 * JSON keeps this payload machine-stable so generation can treat planner output
 * as data, not as ambiguous free-form text.
 */
const buildPlannerPayload = (
    plan: ChatPlan,
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
}: CreateChatOrchestratorOptions) => {
    const chatOrchestratorLogger =
        typeof logger.child === 'function'
            ? logger.child({ module: 'chatOrchestrator' })
            : logger;
    const catalogProfiles = runtimeConfig.modelProfiles.catalog;
    const enabledProfiles = catalogProfiles.filter(
        (profile) => profile.enabled
    );
    const searchCapableFallbackProfiles = enabledProfiles.filter(
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

        const botProfileDisplayName = resolveBotProfileDisplayName();
        const planned = await chatPlanner.planChat(normalizedRequest);
        const plannerExecution = planned.execution;
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
        let profileSelectionSource: 'request' | 'planner' | 'default' =
            'default';
        const requestedProfileId = normalizedRequest.profileId?.trim();
        if (requestedProfileId) {
            const selectedProfile = enabledProfilesById.get(requestedProfileId);
            if (selectedProfile) {
                selectedResponseProfile = selectedProfile;
                profileSelectionSource = 'request';
                if (plan.profileId && plan.profileId !== selectedProfile.id) {
                    chatOrchestratorLogger.warn(
                        'request profile override superseded planner profile selection',
                        {
                            requestedProfileId: selectedProfile.id,
                            plannerProfileId: plan.profileId,
                            surface: normalizedRequest.surface,
                        }
                    );
                }
            } else {
                chatOrchestratorLogger.warn(
                    'request selected invalid or disabled profile id; falling back to planner/default profile',
                    {
                        selectedProfileId: requestedProfileId,
                        defaultProfileId: defaultResponseProfile.id,
                        surface: normalizedRequest.surface,
                    }
                );
            }
        } else if (plan.profileId) {
            const selectedProfile = enabledProfilesById.get(plan.profileId);
            if (selectedProfile) {
                selectedResponseProfile = selectedProfile;
                profileSelectionSource = 'planner';
            } else {
                chatOrchestratorLogger.warn(
                    'planner selected invalid or disabled profile id; falling back to default profile',
                    {
                        selectedProfileId: plan.profileId,
                        defaultProfileId: defaultResponseProfile.id,
                        surface: normalizedRequest.surface,
                    }
                );
            }
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
        let toolExecutionContext:
            | {
                  toolName: 'web_search';
                  status: ExecutionStatus;
                  reasonCode?: ExecutionReasonCode;
              }
            | undefined;
        if (
            generationForExecution.search &&
            !selectedResponseProfile.capabilities.canUseSearch
        ) {
            const shouldRerouteToSearchCapableFallback =
                profileSelectionSource === 'planner';
            const fallbackProfile = shouldRerouteToSearchCapableFallback
                ? searchCapableFallbackProfiles.find(
                      (profile) => profile.id !== selectedResponseProfile.id
                  )
                : undefined;

            if (fallbackProfile) {
                rerouteApplied = true;
                selectedResponseProfile = fallbackProfile;
                effectiveSelectedProfileId = fallbackProfile.id;
                chatOrchestratorLogger.warn(
                    'planner selected a non-search-capable profile; rerouting search to first enabled search-capable fallback profile',
                    {
                        originalProfileId: originalSelectedProfileId,
                        effectiveProfileId: effectiveSelectedProfileId,
                        surface: normalizedRequest.surface,
                    }
                );
            } else {
                generationForExecution = {
                    ...generationForExecution,
                    search: undefined,
                };
                toolExecutionContext = {
                    toolName: 'web_search',
                    status: 'skipped',
                    reasonCode: 'search_not_supported_by_selected_profile',
                };
                chatOrchestratorLogger.warn(
                    'search requested but selected profile does not support search; running without search',
                    {
                        originalProfileId: originalSelectedProfileId,
                        effectiveProfileId: effectiveSelectedProfileId,
                        rerouteApplied,
                        selectionSource: profileSelectionSource,
                        surface: normalizedRequest.surface,
                    }
                );
            }
        }
        // Persist the effective profile id in planner payload/snapshot so traces
        // reflect what was actually executed.
        const executionPlan: ChatPlan = {
            ...plan,
            generation: generationForExecution,
            profileId: selectedResponseProfile.id,
        };

        // Non-message actions return early and skip model generation.
        if (executionPlan.action === 'ignore') {
            return {
                action: 'ignore',
                metadata: null,
            };
        }

        if (executionPlan.action === 'react') {
            return {
                action: 'react',
                reaction: executionPlan.reaction ?? '👍',
                metadata: null,
            };
        }

        if (executionPlan.action === 'image' && executionPlan.imageRequest) {
            return {
                action: 'image',
                imageRequest: executionPlan.imageRequest,
                metadata: null,
            };
        }

        if (executionPlan.action === 'image' && !executionPlan.imageRequest) {
            // Invalid image action should not block response flow.
            chatOrchestratorLogger.warn(
                `Chat planner returned image without imageRequest; falling back to ignore. surface=${normalizedRequest.surface} trigger=${normalizedRequest.trigger.kind} latestUserInputLength=${normalizedRequest.latestUserInput.length}`
            );
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
            {
                role: 'system',
                content: [
                    '// ==========',
                    '// BEGIN Planner Output',
                    '// This planner decision was made by the backend and should be treated as authoritative for this response.',
                    '// ==========',
                    buildPlannerPayload(executionPlan, surfacePolicy),
                    '// ==========',
                    '// END Planner Output',
                    '// ==========',
                ].join('\n'),
            },
        ];

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
                    generation: executionPlan.generation,
                    ...(surfacePolicy && { surfacePolicy }),
                },
            }),
            orchestrationStartedAtMs: orchestrationStartedAt,
            plannerTemperament: executionPlan.generation.temperament,
            riskTier: executionPlan.riskTier,
            model: selectedResponseProfile.providerModel,
            provider: selectedResponseProfile.provider,
            capabilities: selectedResponseProfile.capabilities,
            generation: executionPlan.generation,
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
        chatOrchestratorLogger.info('chat.orchestration.timing', {
            surface: normalizedRequest.surface,
            plannerStatus: plannerExecution.status,
            plannerReasonCode: plannerExecution.reasonCode,
            plannerDurationMs: plannerExecution.durationMs,
            generationDurationMs: response.generationDurationMs,
            totalDurationMs,
            plannerProfileId: plannerProfile.id,
            responseProfileId: selectedResponseProfile.id,
            originalProfileId: originalSelectedProfileId,
            effectiveProfileId: effectiveSelectedProfileId,
            searchRequested: generationForExecution.search !== undefined,
            toolStatus: toolExecutionContext?.status,
            rerouteApplied,
            fallbackApplied: plannerExecution.status === 'failed',
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
