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
import { buildProfileOverlaySystemMessage } from './prompts/profilePromptOverlay.js';
import {
    createChatService,
    type CreateChatServiceOptions,
} from './chatService.js';
import { createChatPlanner, type ChatPlan } from './chatPlanner.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';

type CreateChatOrchestratorOptions = CreateChatServiceOptions;

const DEFAULT_BOT_PROFILE_DISPLAY_NAME = 'Footnote';
const DISCORD_CONTEXT_WINDOW_SIZE = 24;

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

/**
 * Chat profile selection is backend-owned. The bot may suggest a profile ID,
 * but the backend only honors the active runtime profile and warns on mismatch.
 */
const resolveActiveProfileOverlayPrompt = (
    request: Pick<PostChatRequest, 'profileId' | 'surface'>
): string | null => {
    const requestedProfileId = request.profileId?.trim();
    const runtimeProfileId = runtimeConfig.profile.id;

    if (requestedProfileId && requestedProfileId !== runtimeProfileId) {
        logger.warn(
            `Chat request profileId "${requestedProfileId}" does not match backend runtime profile "${runtimeProfileId}". Using runtime profile.`,
            {
                surface: request.surface,
            }
        );
    }

    return buildProfileOverlaySystemMessage(runtimeConfig.profile, 'chat');
};

const trimDiscordConversationWindow = (
    conversation: PostChatRequest['conversation']
): PostChatRequest['conversation'] => {
    const retainedReverse: PostChatRequest['conversation'] = [];
    let nonSystemCount = 0;
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
        const message = conversation[index];
        if (!message) {
            continue;
        }
        if (message.role === 'system') {
            retainedReverse.push(message);
            continue;
        }
        if (nonSystemCount >= DISCORD_CONTEXT_WINDOW_SIZE) {
            continue;
        }
        retainedReverse.push(message);
        nonSystemCount += 1;
    }

    return retainedReverse.reverse();
};

const formatTimestampForConversation = (isoTimestamp?: string): string | null => {
    if (!isoTimestamp) {
        return null;
    }
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    const iso = date.toISOString();
    const [datePart, timePart] = iso.split('T');
    if (!datePart || !timePart) {
        return null;
    }

    const wholeTime = timePart.split('.')[0];
    if (!wholeTime) {
        return null;
    }

    const hhmm = wholeTime.slice(0, 5);
    return `${datePart} ${hhmm}`;
};

const formatDiscordConversationMessage = (
    message: PostChatRequest['conversation'][number],
    messageIndex: number
): string => {
    const trimmedContent = message.content.trim();
    const timestamp = formatTimestampForConversation(message.createdAt);
    const authorLabel = (message.authorName ?? message.authorId ?? 'Unknown').trim();

    if (!timestamp || authorLabel.length === 0) {
        return trimmedContent;
    }

    const roleLabel = message.role === 'assistant' ? ' (bot)' : '';
    const preamble = `[${messageIndex}] At ${timestamp} ${authorLabel}${roleLabel} said:`;
    if (message.role === 'assistant') {
        return trimmedContent
            ? `${preamble} ${trimmedContent}`
            : `${preamble} Assistant response contained only non-text content.`;
    }
    return `${preamble} "${trimmedContent}"`;
};

const normalizeDiscordConversation = (
    request: PostChatRequest
): Array<Pick<ChatConversationMessage, 'role' | 'content'>> => {
    const trimmedConversation = trimDiscordConversationWindow(request.conversation);
    let nonSystemIndex = 0;

    const normalized = trimmedConversation.map((message) => {
        if (message.role === 'system') {
            return {
                role: 'system' as const,
                content: message.content,
            };
        }

        const content = formatDiscordConversationMessage(message, nonSystemIndex);
        nonSystemIndex += 1;
        return {
            role: message.role,
            content,
        };
    });

    if (request.conversation.length > trimmedConversation.length) {
        logger.debug(
            `Discord chat conversation was trimmed from ${request.conversation.length} to ${trimmedConversation.length} entries before orchestration.`
        );
    }

    return normalized;
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
        const normalizedConversation =
            request.surface === 'discord'
                ? normalizeDiscordConversation(request)
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

        const botProfileDisplayName = resolveBotProfileDisplayName();
        const planned = await chatPlanner.planChat(normalizedRequest);
        const { plan, surfacePolicy } = coercePlanForSurface(
            normalizedRequest,
            planned
        );

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
                `Chat planner returned image without imageRequest; falling back to ignore. surface=${normalizedRequest.surface} trigger=${normalizedRequest.trigger.kind} latestUserInputLength=${normalizedRequest.latestUserInput.length}`
            );
            return {
                action: 'ignore',
                metadata: null,
            };
        }
        const promptLayers = renderConversationPromptLayers(
            normalizedRequest.surface === 'discord' ? 'discord-chat' : 'web-chat',
            {
                botProfileDisplayName,
            }
        );
        const backendOwnedProfileOverlay =
            normalizedRequest.surface === 'discord'
                ? resolveActiveProfileOverlayPrompt(normalizedRequest)
                : null;
        const personaPrompt =
            backendOwnedProfileOverlay ?? promptLayers.personaPrompt;

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
