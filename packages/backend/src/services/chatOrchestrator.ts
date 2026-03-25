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
import {
    renderConversationPromptLayers,
} from './prompts/conversationPromptLayers.js';
import {
    createChatService,
    type CreateChatServiceOptions,
} from './chatService.js';
import { createChatPlanner, type ChatPlan } from './chatPlanner.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type CreateChatOrchestratorOptions = CreateChatServiceOptions;

const DEFAULT_BOT_PROFILE_DISPLAY_NAME = 'Footnote';

/**
 * Uses the shared profile display-name env so non-overlay persona templates
 * resolve to the same name operators configured for the deployment.
 */
const resolveBotProfileDisplayName = (): string => {
    const envValue = process.env.BOT_PROFILE_DISPLAY_NAME;
    if (typeof envValue === 'string' && envValue.trim().length > 0) {
        return envValue.trim();
    }

    return DEFAULT_BOT_PROFILE_DISPLAY_NAME;
};

/**
 * Packs the normalized planner decision into one structured system payload.
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
 * Enforces surface policy constraints after planning.
 * Web currently accepts message responses only.
 */
const coercePlanForSurface = (
    request: PostChatRequest,
    plan: ChatPlan
): {
    plan: ChatPlan;
    surfacePolicy?: { coercedFrom: ChatPlan['action'] };
} => {
    if (request.surface !== 'web') {
        return { plan };
    }

    if (plan.action === 'message') {
        return { plan };
    }

    const normalizedReasoning = plan.reasoning.trim();
    const coercedPlan: ChatPlan = {
        ...plan,
        action: 'message',
        modality: 'text',
        reaction: undefined,
        imageRequest: undefined,
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
        },
        reasoning:
            `${normalizedReasoning ? `${normalizedReasoning} ` : ''}Web surface requires a message response, so the planner output was coerced to a text message.`.trim(),
    };

    logger.debug(
        `Chat surface policy coerced action ${plan.action} -> message for web request.`
    );

    return {
        plan: coercedPlan,
        surfacePolicy: { coercedFrom: plan.action },
    };
};

const DISCORD_PROFILE_OVERLAY_HEADER = 'BEGIN Bot Profile Overlay';

/**
 * Detects a Discord vendor overlay system message injected by the bot runtime.
 */
const isDiscordOverlaySystemMessage = (
    message: Pick<ChatConversationMessage, 'role' | 'content'>
): boolean =>
    message.role === 'system' &&
    message.content.includes(DISCORD_PROFILE_OVERLAY_HEADER);

/**
 * Extracts one overlay message and returns the remaining conversation.
 * The extracted overlay becomes the active persona layer for the request.
 */
const extractDiscordPersonaOverlay = (
    conversation: Array<Pick<ChatConversationMessage, 'role' | 'content'>>
): {
    personaPrompt: string | null;
    conversation: Array<Pick<ChatConversationMessage, 'role' | 'content'>>;
} => {
    const firstOverlay = conversation.find(isDiscordOverlaySystemMessage);
    if (!firstOverlay) {
        return {
            personaPrompt: null,
            conversation,
        };
    }

    return {
        personaPrompt: firstOverlay.content,
        conversation: conversation.filter(
            (message) => !isDiscordOverlaySystemMessage(message)
        ),
    };
};

/**
 * The orchestrator keeps surface-specific policy in one place while reusing the
 * shared message-generation service for any branch that ends in text output.
 */
export const createChatOrchestrator = ({
    generationRuntime,
    storeTrace,
    buildResponseMetadata,
    defaultModel = runtimeConfig.openai.defaultModel,
    recordUsage,
}: CreateChatOrchestratorOptions) => {
    const chatService = createChatService({
        generationRuntime,
        storeTrace,
        buildResponseMetadata,
        defaultModel,
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
            const plannerResult = await generationRuntime.generate({
                messages,
                model,
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
        defaultModel,
        recordUsage,
    });

    const runChat = async (
        request: PostChatRequest
    ): Promise<PostChatResponse> => {
        const botProfileDisplayName = resolveBotProfileDisplayName();
        const planned = await chatPlanner.planChat(request);
        const { plan, surfacePolicy } = coercePlanForSurface(request, planned);

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
            logger.warn(
                `Chat planner returned image without imageRequest; falling back to ignore. surface=${request.surface} trigger=${request.trigger.kind} latestUserInputLength=${request.latestUserInput.length}`
            );
            return {
                action: 'ignore',
                metadata: null,
            };
        }

        const normalizedConversation: Array<
            Pick<ChatConversationMessage, 'role' | 'content'>
        > = request.conversation.map(
            (message: PostChatRequest['conversation'][number]) => ({
                role: message.role,
                content: message.content,
            })
        );
        const extractedPersona =
            request.surface === 'discord'
                ? extractDiscordPersonaOverlay(normalizedConversation)
                : {
                      personaPrompt: null,
                      conversation: normalizedConversation,
                  };
        if (request.surface === 'discord' && extractedPersona.personaPrompt) {
            logger.debug(
                'Chat orchestrator applied Discord profile overlay as the active persona layer.'
            );
        }
        const promptLayers = renderConversationPromptLayers(
            request.surface === 'discord' ? 'discord-chat' : 'web-chat',
            {
                botProfileDisplayName,
            }
        );
        const personaPrompt =
            extractedPersona.personaPrompt ?? promptLayers.personaPrompt;

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
            ...extractedPersona.conversation,
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

        const response = await chatService.runChatMessages({
            messages: conversationMessages,
            conversationSnapshot: JSON.stringify({
                request,
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
            generation: plan.generation,
        });

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
