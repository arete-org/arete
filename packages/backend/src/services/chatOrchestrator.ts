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
import { renderConversationPromptLayers } from './prompts/conversationPromptLayers.js';
import {
    createChatService,
    type CreateChatServiceOptions,
} from './chatService.js';
import { createChatPlanner, type ChatPlan } from './chatPlanner.js';
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

    // Resolve one startup default profile that drives both planner and response
    // generation. This keeps routing deterministic unless a future planner
    // branch chooses profile ids explicitly.
    const modelProfileResolver = createModelProfileResolver({
        catalog: runtimeConfig.modelProfiles.catalog,
        defaultProfileId: runtimeConfig.modelProfiles.defaultProfileId,
        legacyDefaultModel: runtimeConfig.openai.defaultModel,
        warn: chatOrchestratorLogger,
    });
    const defaultGenerationProfile = modelProfileResolver.resolve(defaultModel);
    // One resolved profile is reused for planner + generation so both paths
    // target the same provider/model/capability defaults.

    // ChatService handles final message generation and trace/cost wiring.
    const chatService = createChatService({
        generationRuntime,
        storeTrace,
        buildResponseMetadata,
        defaultModel: defaultGenerationProfile.providerModel,
        defaultProvider: defaultGenerationProfile.provider,
        defaultCapabilities: defaultGenerationProfile.capabilities,
        recordUsage,
    });
    const chatPlanner = createChatPlanner({
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
                provider: defaultGenerationProfile.provider,
                capabilities: defaultGenerationProfile.capabilities,
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
        defaultModel: defaultGenerationProfile.providerModel,
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
        const { plan, surfacePolicy } = coercePlanForSurface(
            normalizedRequest,
            planned,
            chatOrchestratorLogger
        );

        // Non-message actions return early and skip model generation.
        if (plan.action === 'ignore') {
            return {
                action: 'ignore',
                metadata: null,
            };
        }

        if (plan.action === 'react') {
            return {
                action: 'react',
                reaction: plan.reaction ?? '👍',
                metadata: null,
            };
        }

        if (plan.action === 'image' && plan.imageRequest) {
            return {
                action: 'image',
                imageRequest: plan.imageRequest,
                metadata: null,
            };
        }

        if (plan.action === 'image' && !plan.imageRequest) {
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
                    buildPlannerPayload(plan, surfacePolicy),
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
                    action: plan.action,
                    modality: plan.modality,
                    riskTier: plan.riskTier,
                    generation: plan.generation,
                    ...(surfacePolicy && { surfacePolicy }),
                },
            }),
            plannerTemperament: plan.generation.temperament,
            riskTier: plan.riskTier,
            model: defaultGenerationProfile.providerModel,
            provider: defaultGenerationProfile.provider,
            capabilities: defaultGenerationProfile.capabilities,
            generation: plan.generation,
        });

        // Message action is the only branch that returns provenance metadata.
        return {
            action: 'message',
            message: response.message,
            modality: plan.modality,
            metadata: response.metadata,
        };
    };

    return {
        runChat,
    };
};
