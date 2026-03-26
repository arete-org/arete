/**
 * @description: Core Discord message processing that delegates chat decisions to the backend and executes the returned action locally.
 * @footnote-scope: core
 * @footnote-module: MessageProcessor
 * @footnote-risk: high - Processing failures can break user interactions or route the wrong action.
 * @footnote-ethics: high - This path controls how Footnote responds, when it stays silent, and how provenance is shown.
 */

import fs from 'fs';
import { Message } from 'discord.js';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type {
    PostChatRequest,
    ChatImageRequest,
    ChatTriggerKind,
} from '@footnote/contracts/web';
import {
    DEFAULT_INTERNAL_TTS_OPTIONS,
    DEFAULT_INTERNAL_TTS_OUTPUT_FORMAT,
} from '@footnote/contracts/voice';
import { logger } from './logger.js';
import { ResponseHandler } from './response/ResponseHandler.js';
import { RateLimiter } from './RateLimiter.js';
import { runtimeConfig } from '../config.js';
import {
    DEFAULT_IMAGE_MODEL,
    DEFAULT_IMAGE_OUTPUT_COMPRESSION,
    DEFAULT_IMAGE_OUTPUT_FORMAT,
    DEFAULT_IMAGE_QUALITY,
    DEFAULT_TEXT_MODEL,
    PROMPT_ADJUSTMENT_MIN_REMAINING_RATIO,
    EMBED_FIELD_VALUE_LIMIT,
} from '../commands/image/constants.js';
import { resolveAspectRatioSettings } from '../commands/image/aspect.js';
import {
    buildImageResultPresentation,
    clampPromptForContext,
    executeImageGeneration,
} from '../commands/image/sessionHelpers.js';
import {
    readFollowUpContext,
    saveFollowUpContext,
    type ImageGenerationContext,
} from '../commands/image/followUpCache.js';
import {
    recoverContextDetailsFromMessage,
    type RecoveredImageContext,
} from '../commands/image/contextResolver.js';
import {
    buildProvenanceActionRow,
    buildTraceCardRequest,
} from './response/provenanceCgi.js';
import { botApi, isDiscordApiClientError } from '../api/botApi.js';
import type { DiscordChatApiResponse } from '../api/index.js';
import type {
    ImageBackgroundType,
    ImageRenderModel,
    ImageStylePreset,
    ImageTextModel,
    ImageOutputFormat,
} from '../commands/image/types.js';

type MessageProcessorOptions = {
    systemPrompt?: string;
};

type ChatMessageAction = {
    action: 'message';
    message: string;
    modality: 'text' | 'tts';
    metadata: ResponseMetadata;
};

type ChatReactAction = {
    action: 'react';
    reaction: string;
};

type ChatImageAction = {
    action: 'image';
    imageRequest: ChatImageRequest;
};

/**
 * Provenance assets prepared for either a combined response send or a later
 * follow-up send. Keeping this payload serializable makes the "wait briefly,
 * then fall through" logic easier to reason about and test.
 */
type PreparedProvenancePayload = {
    files: Array<{ filename: string; data: Buffer }>;
    components: [ReturnType<typeof buildProvenanceActionRow>];
};

const RESPONSE_CONTEXT_SIZE = 24;
const RAW_CHAT_HISTORY_LIMIT = 63;
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
// Give provenance a short head start so we can usually send one combined
// response, but still fall back before the user waits indefinitely.
const PROVENANCE_FOOTER_WAIT_MS = 5000;
const REFLECT_ERROR_BLOCK_PREFIX = '```ansi\n';
const REFLECT_ERROR_BLOCK_SUFFIX = '\n```';
const REFLECT_ERROR_TRUNCATION_SUFFIX = '... (truncated)';
const ANSI_RED = '\u001b[31m';
const ANSI_RESET = '\u001b[0m';
const VALID_IMAGE_BACKGROUNDS: ImageBackgroundType[] = [
    'auto',
    'transparent',
    'opaque',
];
const VALID_IMAGE_STYLES = new Set<ImageStylePreset>([
    'natural',
    'vivid',
    'photorealistic',
    'cinematic',
    'oil_painting',
    'watercolor',
    'digital_painting',
    'line_art',
    'sketch',
    'cartoon',
    'anime',
    'comic',
    'pixel_art',
    'cyberpunk',
    'fantasy_art',
    'surrealist',
    'minimalist',
    'vintage',
    'noir',
    '3d_render',
    'steampunk',
    'abstract',
    'pop_art',
    'dreamcore',
    'isometric',
    'unspecified',
]);
// Use shared defaults so the bot and backend remain aligned on voice style.
const DEFAULT_TTS_OUTPUT_FORMAT = DEFAULT_INTERNAL_TTS_OUTPUT_FORMAT;
const DEFAULT_TTS_OPTIONS = DEFAULT_INTERNAL_TTS_OPTIONS;

const clampOutputCompression = (value: number | undefined | null): number => {
    if (!Number.isFinite(value)) {
        return DEFAULT_IMAGE_OUTPUT_COMPRESSION;
    }
    return Math.min(100, Math.max(1, Math.round(value as number)));
};

const hasResponseMetadata = (value: unknown): value is ResponseMetadata =>
    Boolean(
        value &&
        typeof value === 'object' &&
        typeof (value as { responseId?: unknown }).responseId === 'string'
    );

const isChatMessageAction = (
    value: DiscordChatApiResponse
): value is ChatMessageAction =>
    value.action === 'message' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    ((value as { modality?: unknown }).modality === 'text' ||
        (value as { modality?: unknown }).modality === 'tts') &&
    hasResponseMetadata((value as { metadata?: unknown }).metadata);

const isChatReactAction = (
    value: DiscordChatApiResponse
): value is ChatReactAction =>
    value.action === 'react' &&
    typeof (value as { reaction?: unknown }).reaction === 'string';

const isChatImageAction = (
    value: DiscordChatApiResponse
): value is ChatImageAction => {
    const prompt = (value as { imageRequest?: ChatImageRequest })
        .imageRequest?.prompt;
    return (
        value.action === 'image' &&
        typeof prompt === 'string' &&
        prompt.trim().length > 0
    );
};

const hasImageAttachments = (message: Message): boolean =>
    message.attachments.some((attachment) =>
        attachment.contentType?.startsWith('image/')
    );

const hasImageEmbeds = (message: Message): boolean =>
    message.embeds.some(
        (embed) =>
            embed.data.type === 'image' ||
            Boolean(embed.image?.url) ||
            Boolean(embed.thumbnail?.url)
    );

const buildEmbedSummary = (message: Message): string | null => {
    if (!message.embeds?.length) {
        return null;
    }

    const lines: string[] = [];
    let embedIndex = 1;

    for (const embed of message.embeds) {
        lines.push(`[Embed ${embedIndex}]`);
        if (embed.title) lines.push(`Title: ${embed.title}`);
        if (embed.description) lines.push(`Description: ${embed.description}`);
        if (embed.author?.name) lines.push(`Author: ${embed.author.name}`);
        if (embed.url) lines.push(`URL: ${embed.url}`);
        if (embed.image?.url) lines.push(`Image: ${embed.image.url}`);
        if (embed.thumbnail?.url)
            lines.push(`Thumbnail: ${embed.thumbnail.url}`);
        if (embed.footer?.text) lines.push(`Footer: ${embed.footer.text}`);
        if (embed.provider?.name) lines.push(`Provider: ${embed.provider.name}`);
        if (embed.fields?.length) {
            for (const field of embed.fields) {
                lines.push(`${field.name}: ${field.value ?? ''}`);
            }
        }
        embedIndex += 1;
    }

    return lines.join('\n');
};

const sanitizeForDiscordCodeBlock = (value: string): string =>
    value.replace(/```/g, '` ` `').trim();

const toChatFailureReason = (error: unknown): string => {
    const apiError = isDiscordApiClientError(error) ? error : null;
    if (apiError) {
        switch (apiError.code) {
            case 'timeout_error':
                return `Timed out while waiting for backend chat response (${runtimeConfig.api.backendRequestTimeoutMs}ms budget).`;
            case 'aborted_error':
                return 'The chat request was aborted before completion.';
            case 'network_error':
                return `Network error while calling backend chat: ${apiError.message}`;
            case 'server_error':
                return `Backend chat returned a server error${apiError.status ? ` (${apiError.status})` : ''}.`;
            default:
                return `Backend chat request failed (${apiError.code}): ${apiError.message}`;
        }
    }

    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message.trim();
    }

    return 'Unknown error while calling backend chat.';
};

const formatChatFailureForDiscord = (error: unknown): string => {
    const baseMessage = sanitizeForDiscordCodeBlock(
        `Chat request failed: ${toChatFailureReason(error)}`
    );
    const wrapped = `${ANSI_RED}${baseMessage}${ANSI_RESET}`;
    const maxContentLength =
        DISCORD_MAX_MESSAGE_LENGTH -
        REFLECT_ERROR_BLOCK_PREFIX.length -
        REFLECT_ERROR_BLOCK_SUFFIX.length;

    const safeContent =
        wrapped.length <= maxContentLength
            ? wrapped
            : `${wrapped.slice(0, Math.max(0, maxContentLength - REFLECT_ERROR_TRUNCATION_SUFFIX.length))}${REFLECT_ERROR_TRUNCATION_SUFFIX}`;

    return `${REFLECT_ERROR_BLOCK_PREFIX}${safeContent}${REFLECT_ERROR_BLOCK_SUFFIX}`;
};

/**
 * Discord-side executor for backend chat decisions.
 */
export class MessageProcessor {
    private readonly rateLimiters: {
        user?: RateLimiter;
        channel?: RateLimiter;
        guild?: RateLimiter;
    };

    constructor(_options: MessageProcessorOptions = {}) {
        this.rateLimiters = {};
        if (runtimeConfig.rateLimits.user.enabled) {
            this.rateLimiters.user = new RateLimiter({
                limit: runtimeConfig.rateLimits.user.limit,
                window: runtimeConfig.rateLimits.user.windowMs,
                scope: 'user',
            });
        }
        if (runtimeConfig.rateLimits.channel.enabled) {
            this.rateLimiters.channel = new RateLimiter({
                limit: runtimeConfig.rateLimits.channel.limit,
                window: runtimeConfig.rateLimits.channel.windowMs,
                scope: 'channel',
            });
        }
        if (runtimeConfig.rateLimits.guild.enabled) {
            this.rateLimiters.guild = new RateLimiter({
                limit: runtimeConfig.rateLimits.guild.limit,
                window: runtimeConfig.rateLimits.guild.windowMs,
                scope: 'guild',
            });
        }
    }

    /**
     * The bot now acts as a surface adapter:
     * 1. build a chat request from Discord state
     * 2. ask the backend what action to take
     * 3. execute that action locally in Discord
     */
    public async processMessage(
        message: Message,
        directReply: boolean = true,
        trigger: string = ''
    ): Promise<void> {
        const responseHandler = new ResponseHandler(
            message,
            message.channel,
            message.author
        );

        if (
            !message.content.trim() &&
            !hasImageAttachments(message) &&
            !hasImageEmbeds(message)
        ) {
            return;
        }

        const rateLimitResult = await this.checkRateLimits(message);
        if (!rateLimitResult.allowed && rateLimitResult.error) {
            await responseHandler.sendMessage(rateLimitResult.error);
            return;
        }

        const chatContext = await this.buildChatRequestFromMessage(
            message,
            trigger
        );
        if (!chatContext) {
            return;
        }

        logger.debug(
            `Dispatching backend chat request for message ${message.id} with trigger=${chatContext.request.trigger.kind}.`
        );

        await responseHandler.startTyping();
        try {
            let chatResponse: DiscordChatApiResponse = {
                action: 'ignore',
                metadata: null,
            };
            try {
                chatResponse = await botApi.chatViaApi(
                    chatContext.request
                );
            } catch (error) {
                logger.error(
                    `Backend chat request failed for message ${message.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    {
                        triggerKind: chatContext.request.trigger.kind,
                        contentLength:
                            chatContext.request.latestUserInput.length,
                        conversationLength:
                            chatContext.request.conversation.length,
                    }
                );
                try {
                    await responseHandler.sendMessage(
                        formatChatFailureForDiscord(error),
                        [],
                        directReply
                    );
                } catch (replyError) {
                    logger.error(
                        `Failed to send chat failure reply for message ${message.id}: ${
                            replyError instanceof Error
                                ? replyError.message
                                : String(replyError)
                        }`
                    );
                }
                return;
            }
            await this.executeChatAction(
                message,
                responseHandler,
                chatResponse,
                directReply,
                chatContext.recoveredImageContext
            );
        } finally {
            responseHandler.stopTyping();
        }
    }

    /**
     * Builds the transport-neutral request the backend planner needs, while
     * preserving attachment grounding and follow-up hints from the Discord
     * surface.
     */
    private async buildChatRequestFromMessage(
        message: Message,
        trigger: string
    ): Promise<{
        request: PostChatRequest;
        recoveredImageContext: RecoveredImageContext | null;
    } | null> {
        const conversation = await this.buildRawConversationHistory(
            message,
            RESPONSE_CONTEXT_SIZE
        );
        const imageAttachments = message.attachments.filter((attachment) =>
            attachment.contentType?.startsWith('image/')
        );

        if (imageAttachments.size > 0) {
            logger.debug(
                `Processing image attachment(s) for chat request on message ${message.id}.`,
                {
                    attachmentCount: imageAttachments.size,
                    contentLength: message.content.length,
                }
            );
            const trimmedAttachmentContext = message.content.trim();

            const imageDescriptions = await Promise.all(
                imageAttachments.map(async (attachment) => {
                    try {
                        const response =
                            await botApi.runImageDescriptionTaskViaApi({
                                task: 'image_description',
                                imageUrl: attachment.url,
                                ...(trimmedAttachmentContext.length > 0
                                    ? {
                                          context: trimmedAttachmentContext,
                                      }
                                    : {}),
                                channelContext: {
                                    channelId: message.channelId,
                                    guildId: message.guildId ?? undefined,
                                },
                            });

                        return (
                            response.result.description ??
                            `Error generating image description for message ${message.id} attachment ${attachment.id}`
                        );
                    } catch (error) {
                        logger.error(
                            `Error generating image description for chat attachment on message ${message.id}: ${
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            }`,
                            {
                                attachmentId: attachment.id,
                                attachmentCount: imageAttachments.size,
                            }
                        );
                        return `Error generating image description for message ${message.id} attachment ${attachment.id}`;
                    }
                })
            );

            conversation.push({
                role: 'system',
                content: [
                    '// ==========',
                    '// BEGIN Image Descriptions',
                    '// The user uploaded images; use these auto-generated descriptions for grounding.',
                    '// ==========',
                    imageDescriptions
                        .map(
                            (description, index) =>
                                `[Image ${index + 1}]: ${description}`
                        )
                        .join('\n'),
                    '// ==========',
                    '// END Image Descriptions',
                    '// ==========',
                ].join('\n'),
            });
        }

        let recoveredImageContext: RecoveredImageContext | null = null;
        try {
            recoveredImageContext =
                await recoverContextDetailsFromMessage(message);
            if (recoveredImageContext) {
                const recoveredContext = recoveredImageContext.context;
                conversation.push({
                    role: 'system',
                    content:
                        `Recovered image embed context for follow-ups:\n` +
                        `prompt="${recoveredContext.prompt}"\n` +
                        `textModel=${recoveredContext.textModel} imageModel=${recoveredContext.imageModel}\n` +
                        `aspect=${recoveredContext.aspectRatio} size=${recoveredContext.size} background=${recoveredContext.background} style=${recoveredContext.style}\n` +
                        `outputFormat=${recoveredContext.outputFormat} compression=${recoveredContext.outputCompression} allowPromptAdjustment=${recoveredContext.allowPromptAdjustment}\n` +
                        `outputId=${recoveredImageContext.responseId ?? 'n/a'} inputId=${recoveredImageContext.inputId ?? 'n/a'}`,
                });
                logger.debug(
                    `Recovered image embed for backend chat: outputId=${recoveredImageContext.responseId ?? 'n/a'}, inputId=${recoveredImageContext.inputId ?? 'n/a'}, promptLength=${recoveredContext.prompt.length}.`
                );
            }
        } catch (error) {
            logger.debug(
                'Failed to recover image embed context for backend chat:',
                error
            );
        }

        if (trigger.trim()) {
            conversation.push({
                role: 'system',
                content: `Trigger context: ${trigger.trim()}`,
            });
        }
        if (conversation.length === 0) {
            return null;
        }

        return {
            request: {
                surface: 'discord',
                profileId: runtimeConfig.profile.id,
                trigger: {
                    kind: this.getChatTriggerKind(message, trigger),
                    messageId: message.id,
                },
                latestUserInput: message.content.trim(),
                conversation,
                attachments: imageAttachments.map((attachment) => ({
                    kind: 'image' as const,
                    url: attachment.url,
                    contentType: attachment.contentType ?? undefined,
                })),
                capabilities: {
                    canReact: true,
                    canGenerateImages: true,
                    canUseTts: true,
                },
                surfaceContext: {
                    channelId: message.channelId,
                    guildId: message.guildId ?? undefined,
                    userId: message.author.id,
                },
            },
            recoveredImageContext,
        };
    }

    /**
     * Collects raw Discord chat history (including author/timestamp metadata)
     * and leaves window trimming plus final text formatting to the backend.
     */
    private async buildRawConversationHistory(
        message: Message,
        maxContextMessages: number
    ): Promise<PostChatRequest['conversation']> {
        const repliedMessage = message.reference?.messageId
            ? await message.channel.messages
                  .fetch(message.reference.messageId)
                  .catch((error) => {
                      logger.debug(
                          `Failed to fetch replied message ${message.reference?.messageId}: ${error.message}`
                      );
                      return null;
                  })
            : null;

        const historyLimit = Math.max(
            0,
            Math.min(maxContextMessages, RAW_CHAT_HISTORY_LIMIT)
        );
        const recentMessages = await message.channel.messages.fetch({
            limit: repliedMessage ? Math.floor(historyLimit / 2) : historyLimit,
            before: message.id,
        });

        const contextMessages = new Map(recentMessages);
        if (repliedMessage) {
            const messagesBeforeReply = await message.channel.messages.fetch({
                limit: historyLimit,
                before: repliedMessage.id,
            });
            messagesBeforeReply.forEach((contextMessage, id) => {
                if (!contextMessages.has(id)) {
                    contextMessages.set(id, contextMessage);
                }
            });

            if (!contextMessages.has(repliedMessage.id)) {
                contextMessages.set(repliedMessage.id, repliedMessage);
            }
        }

        const sortedMessages = Array.from(contextMessages.values()).sort(
            (left, right) => left.createdTimestamp - right.createdTimestamp
        );

        const historyConversation = sortedMessages.map((contextMessage) => {
            const isBotMessage =
                contextMessage.author.id === message.client.user?.id;
            const content =
                contextMessage.content.trim() ||
                buildEmbedSummary(contextMessage) ||
                (isBotMessage
                    ? 'Assistant response contained only non-text content.'
                    : 'User message contained only non-text content.');

            return {
                role: isBotMessage ? ('assistant' as const) : ('user' as const),
                content,
                authorName:
                    contextMessage.member?.displayName ??
                    contextMessage.author.username,
                authorId: contextMessage.author.id,
                messageId: contextMessage.id,
                createdAt: new Date(
                    contextMessage.createdTimestamp
                ).toISOString(),
            };
        });

        const currentMessageContent =
            message.content.trim() ||
            buildEmbedSummary(message) ||
            (hasImageAttachments(message)
                ? '[User uploaded one or more images.]'
                : 'User sent a non-text message.');
        historyConversation.push({
            role: 'user',
            content: currentMessageContent,
            authorName: message.member?.displayName ?? message.author.username,
            authorId: message.author.id,
            messageId: message.id,
            createdAt: new Date(message.createdTimestamp).toISOString(),
        });

        return historyConversation;
    }

    private getChatTriggerKind(
        message: Message,
        trigger?: string
    ): ChatTriggerKind {
        if (message.reference?.messageId) {
            return 'direct';
        }

        const botUserId = message.client.user?.id;
        if (botUserId && message.mentions.users.has(botUserId)) {
            return 'invoked';
        }

        if (trigger?.startsWith('Mentioned by plaintext alias:')) {
            return 'invoked';
        }

        return 'catchup';
    }

    /**
     * Unknown actions intentionally warn and no-op so backend-first action
     * additions do not crash the bot before the executor learns about them.
     */
    private async executeChatAction(
        message: Message,
        responseHandler: ResponseHandler,
        chatResponse: DiscordChatApiResponse,
        directReply: boolean,
        recoveredImageContext: RecoveredImageContext | null
    ): Promise<void> {
        switch (chatResponse.action) {
            case 'ignore':
                logger.debug(
                    `Backend chat chose ignore for message ${message.id}.`
                );
                return;
            case 'react':
                if (!isChatReactAction(chatResponse)) {
                    logger.warn(
                        'Backend chat returned a malformed react action; ignoring.'
                    );
                    return;
                }
                try {
                    await responseHandler.addReaction(chatResponse.reaction);
                    logger.debug(
                        `Backend chat added reaction(s) for message ${message.id}.`,
                        {
                            reaction: chatResponse.reaction,
                            contentLength: message.content.length,
                        }
                    );
                } catch (error) {
                    logger.warn(
                        `Backend chat reaction failed for message ${message.id}.`,
                        {
                            reaction: chatResponse.reaction,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        }
                    );
                }
                return;
            case 'image':
                if (!isChatImageAction(chatResponse)) {
                    logger.warn(
                        'Backend chat returned a malformed image action; ignoring.'
                    );
                    return;
                }
                await this.executeChatImageAction(
                    message,
                    responseHandler,
                    chatResponse.imageRequest,
                    directReply,
                    recoveredImageContext
                );
                return;
            case 'message':
                if (!isChatMessageAction(chatResponse)) {
                    logger.warn(
                        'Backend chat returned a malformed message action; ignoring.'
                    );
                    return;
                }
                await this.executeChatMessageAction(
                    message,
                    responseHandler,
                    chatResponse,
                    directReply
                );
                return;
            default:
                logger.warn(
                    `Backend chat returned unsupported action "${chatResponse.action}". Ignoring until the bot adds explicit support.`
                );
                return;
        }
    }

    private async executeChatMessageAction(
        message: Message,
        responseHandler: ResponseHandler,
        chatResponse: ChatMessageAction,
        directReply: boolean
    ): Promise<void> {
        if (!chatResponse.message.trim()) {
            logger.error(
                `Backend chat returned an empty message payload for message ${message.id}.`
            );
            try {
                await responseHandler.sendMessage(
                    formatChatFailureForDiscord(
                        new Error(
                            'Backend chat returned an empty message payload.'
                        )
                    ),
                    [],
                    directReply
                );
            } catch (error) {
                logger.error(
                    `Failed to send empty-chat-payload reply for message ${message.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
            return;
        }

        const finalResponseText = chatResponse.message;
        // Start provenance work immediately so the trace card can race the main
        // response generation instead of always happening strictly afterward.
        const provenancePayloadPromise = this.prepareProvenanceCgiPayload(
            chatResponse.metadata
        );

        let ttsResult:
            | Awaited<ReturnType<typeof botApi.runVoiceTtsViaApi>>['result']
            | null = null;
        if (chatResponse.modality === 'tts') {
            const ttsRequestId = Date.now().toString();
            try {
                const response = await botApi.runVoiceTtsViaApi({
                    task: 'synthesize',
                    text: finalResponseText,
                    options: DEFAULT_TTS_OPTIONS,
                    outputFormat: DEFAULT_TTS_OUTPUT_FORMAT,
                    channelContext: {
                        channelId: message.channelId,
                        guildId: message.guildId ?? undefined,
                    },
                });
                ttsResult = response.result;
            } catch (error) {
                logger.error(
                    `Chat TTS generation failed for message ${message.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    {
                        ttsRequestId,
                        responseLength: finalResponseText.length,
                    }
                );
            }
        }

        if (ttsResult) {
            try {
                const fileBuffer = Buffer.from(
                    ttsResult.audioBase64,
                    'base64'
                );
                const cleanResponseText = finalResponseText
                    .replace(/\n/g, ' ')
                    .replace(/`/g, '');
                const preparedProvenance = await this.awaitProvenancePayload(
                    provenancePayloadPromise,
                    chatResponse.metadata.responseId
                );
                const sentMessages = await responseHandler.sendMessage(
                    `\`\`\`${cleanResponseText}\`\`\``,
                    [
                        {
                            filename: `tts-${message.id}.${ttsResult.outputFormat}`,
                            data: fileBuffer,
                        },
                        ...(preparedProvenance?.files ?? []),
                    ],
                    directReply,
                    true,
                    preparedProvenance?.components ?? []
                );
                const responseMessages = Array.isArray(sentMessages)
                    ? sentMessages
                    : [sentMessages];
                if (!preparedProvenance) {
                    // The user already has the main reply. Finish provenance in
                    // a follow-up so the footer still lands at the end.
                    const provenanceReplyAnchor =
                        responseMessages[responseMessages.length - 1];

                    // Intentional: backend chat already persisted the canonical trace.
                    // Skipping postTraces here prevents duplicate trace rows for one reply.
                    await this.sendPreparedProvenanceCgi(
                        provenanceReplyAnchor,
                        message,
                        await provenancePayloadPromise,
                        chatResponse.metadata.responseId
                    );
                }
                return;
            } catch (error) {
                logger.error(
                    `Chat TTS delivery failed for message ${message.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    {
                        responseLength: finalResponseText.length,
                    }
                );
            }
        }

        const preparedProvenance = await this.awaitProvenancePayload(
            provenancePayloadPromise,
            chatResponse.metadata.responseId
        );
        const sentMessages = await responseHandler.sendMessage(
            finalResponseText,
            preparedProvenance?.files ?? [],
            directReply,
            true,
            preparedProvenance?.components ?? []
        );
        if (!preparedProvenance) {
            // We missed the combined-send window, so attach provenance as the
            // last follow-up message instead of blocking longer.
            const responseMessages = Array.isArray(sentMessages)
                ? sentMessages
                : [sentMessages];
            const provenanceReplyAnchor =
                responseMessages[responseMessages.length - 1];

            // Intentional: backend chat already persisted the canonical trace.
            // Skipping postTraces here prevents duplicate trace rows for one reply.
            await this.sendPreparedProvenanceCgi(
                provenanceReplyAnchor,
                message,
                await provenancePayloadPromise,
                chatResponse.metadata.responseId
            );
        }
        logger.debug(
            `Backend chat sent message response for message ${message.id}.`,
            {
                responseLength: finalResponseText.length,
                contentLength: message.content.length,
                modality: chatResponse.modality,
            }
        );
    }

    /**
     * Prepares the provenance footer payload ahead of sending the response.
     * If trace-card generation fails, we still return the action buttons so
     * the user keeps provenance controls instead of losing the footer entirely.
     */
    private async prepareProvenanceCgiPayload(
        metadata: ResponseMetadata
    ): Promise<PreparedProvenancePayload> {
        const actionRow = buildProvenanceActionRow(metadata.responseId);
        const files: Array<{ filename: string; data: Buffer }> = [];

        try {
            const traceCard = await botApi.postTraceCard(
                buildTraceCardRequest(metadata)
            );
            files.push({
                filename: 'trace-card.png',
                data: Buffer.from(traceCard.pngBase64, 'base64'),
            });
        } catch (error) {
            logger.warn(
                `Failed to generate provenance trace-card for response ${metadata.responseId}; sending controls only: ${
                    (error as Error)?.message ?? error
                }`
            );
        }

        return {
            files,
            components: [actionRow],
        };
    }

    /**
     * Waits briefly for provenance so we can usually send one combined message.
     * When the timeout wins, the caller should send the body immediately and
     * reuse the same payload promise for a later provenance follow-up.
     */
    private async awaitProvenancePayload(
        payloadPromise: Promise<PreparedProvenancePayload>,
        responseId: string
    ): Promise<PreparedProvenancePayload | null> {
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutToken = Symbol('provenance-timeout');

        try {
            const result = await Promise.race<
                PreparedProvenancePayload | typeof timeoutToken
            >([
                payloadPromise,
                new Promise<typeof timeoutToken>((resolve) => {
                    timeoutHandle = setTimeout(
                        () => resolve(timeoutToken),
                        PROVENANCE_FOOTER_WAIT_MS
                    );
                }),
            ]);

            if (result === timeoutToken) {
                logger.debug(
                    `Provenance payload for response ${responseId} exceeded ${PROVENANCE_FOOTER_WAIT_MS}ms; sending body first and footer later.`
                );
                return null;
            }

            return result;
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    /**
     * Sends a prepared provenance footer as its own follow-up message.
     * This is the fallback path when provenance missed the combined-send window
     * or when another caller explicitly wants a separate footer message.
     */
    private async sendPreparedProvenanceCgi(
        provenanceReplyAnchor: Message,
        originalMessage: Message,
        preparedPayload: PreparedProvenancePayload,
        responseId: string
    ): Promise<void> {
        try {
            const provenanceHandler = new ResponseHandler(
                provenanceReplyAnchor,
                provenanceReplyAnchor.channel,
                originalMessage.author
            );
            await provenanceHandler.sendMessage(
                '',
                preparedPayload.files,
                false,
                false,
                preparedPayload.components
            );
        } catch (error) {
            logger.error(
                `Failed to send provenance CGI follow-up for response ${responseId}: ${
                    (error as Error)?.message ?? error
                }`
            );
        }
    }

    private async executeChatImageAction(
        message: Message,
        responseHandler: ResponseHandler,
        request: ChatImageRequest,
        directReply: boolean,
        recoveredImageContext: RecoveredImageContext | null
    ): Promise<void> {
        logger.debug(
            `Backend chat requested automated image generation for message ${message.id}.`,
            {
                contentLength: message.content.length,
                hasRecoveredImageContext: Boolean(recoveredImageContext),
            }
        );

        const trimmedPrompt = request.prompt.trim();
        if (!trimmedPrompt) {
            logger.warn(
                'Backend chat image action was missing a prompt; ignoring.'
            );
            return;
        }

        const normalizedPrompt = clampPromptForContext(trimmedPrompt);
        let { size, aspectRatio, aspectRatioLabel } =
            resolveAspectRatioSettings(
                (request.aspectRatio ??
                    'auto') as ImageGenerationContext['aspectRatio']
            );

        const requestedBackground = request.background?.toLowerCase() ?? 'auto';
        let background = VALID_IMAGE_BACKGROUNDS.includes(
            requestedBackground as ImageBackgroundType
        )
            ? (requestedBackground as ImageBackgroundType)
            : 'auto';

        let referencedContext: ImageGenerationContext | null =
            recoveredImageContext?.context ?? null;
        let followUpResponseId: string | null =
            recoveredImageContext?.responseId ??
            recoveredImageContext?.inputId ??
            null;
        if (recoveredImageContext) {
            logger.debug(
                `Using recovered image context for follow-up: outputId=${recoveredImageContext.responseId ?? 'n/a'}, inputId=${recoveredImageContext.inputId ?? 'n/a'}.`
            );
        }

        const normalizedStyle = request.style
            ? request.style.toLowerCase().replace(/[^a-z0-9]+/g, '_')
            : 'unspecified';
        let style = VALID_IMAGE_STYLES.has(normalizedStyle as ImageStylePreset)
            ? (normalizedStyle as ImageStylePreset)
            : 'unspecified';

        const followUpCandidate = request.followUpResponseId?.trim();
        if (followUpCandidate) {
            const cached = readFollowUpContext(followUpCandidate);
            const matchesRecovered =
                recoveredImageContext &&
                (recoveredImageContext.responseId === followUpCandidate ||
                    recoveredImageContext.inputId === followUpCandidate);

            if (cached || matchesRecovered) {
                referencedContext =
                    referencedContext ??
                    cached ??
                    recoveredImageContext?.context ??
                    null;
                followUpResponseId = followUpCandidate;
            } else {
                logger.warn(
                    `Backend chat supplied follow-up response ID "${followUpCandidate}" that was not found in cache or recovery; ignoring.`
                );
            }
        }

        if (!referencedContext && message.reference?.messageId) {
            try {
                const referencedMessage = await message.fetchReference();
                const recovered =
                    await recoverContextDetailsFromMessage(referencedMessage);

                if (recovered) {
                    referencedContext = recovered.context;
                    followUpResponseId =
                        recovered.responseId ?? recovered.inputId ?? null;

                    if (!followUpResponseId) {
                        logger.warn(
                            'Recovered image context lacked response identifiers; running without follow-up linkage.'
                        );
                    }

                    if ((request.aspectRatio ?? 'auto') === 'auto') {
                        size = referencedContext.size;
                        aspectRatio = referencedContext.aspectRatio;
                        aspectRatioLabel = referencedContext.aspectRatioLabel;
                    }

                    if (!request.background || requestedBackground === 'auto') {
                        background = referencedContext.background;
                    }

                    if (!request.style || normalizedStyle === 'unspecified') {
                        style = referencedContext.style;
                    }
                }
            } catch (error) {
                logger.debug(
                    'Unable to recover referenced image context for reply-driven image request:',
                    error
                );
            }
        }

        const outputFormat: ImageOutputFormat =
            (request.outputFormat as ImageOutputFormat | undefined) ??
            referencedContext?.outputFormat ??
            DEFAULT_IMAGE_OUTPUT_FORMAT;
        const outputCompression = clampOutputCompression(
            request.outputCompression ??
                referencedContext?.outputCompression ??
                DEFAULT_IMAGE_OUTPUT_COMPRESSION
        );

        if (trimmedPrompt.length > normalizedPrompt.length) {
            logger.warn(
                'Automated image prompt exceeded embed limits; truncating to preserve follow-up usability.'
            );
        }

        const remainingRatio = Math.max(
            0,
            (EMBED_FIELD_VALUE_LIMIT - normalizedPrompt.length) /
                EMBED_FIELD_VALUE_LIMIT
        );
        const hasRoomForAdjustment =
            remainingRatio > PROMPT_ADJUSTMENT_MIN_REMAINING_RATIO;
        const allowPromptAdjustment = hasRoomForAdjustment
            ? (request.allowPromptAdjustment ??
              referencedContext?.allowPromptAdjustment ??
              false)
            : false;

        const textModel: ImageTextModel =
            referencedContext?.textModel ?? DEFAULT_TEXT_MODEL;
        const imageModel: ImageRenderModel =
            referencedContext?.imageModel ?? DEFAULT_IMAGE_MODEL;

        const context: ImageGenerationContext = {
            prompt: normalizedPrompt,
            originalPrompt: normalizedPrompt,
            refinedPrompt: null,
            textModel,
            imageModel,
            size,
            aspectRatio,
            aspectRatioLabel,
            quality:
                request.quality ??
                referencedContext?.quality ??
                DEFAULT_IMAGE_QUALITY,
            background,
            style,
            allowPromptAdjustment,
            outputFormat,
            outputCompression,
        };

        try {
            const artifacts = await executeImageGeneration(context, {
                user: {
                    username: message.author.username,
                    nickname:
                        message.member?.displayName ?? message.author.username,
                    guildName: message.guild?.name ?? 'Direct message channel',
                },
                followUpResponseId,
                channelContext: {
                    channelId: message.channelId,
                    guildId: message.guildId ?? undefined,
                },
                stream: false,
            });

            const presentation = buildImageResultPresentation(
                context,
                artifacts
            );

            if (artifacts.responseId) {
                saveFollowUpContext(
                    artifacts.responseId,
                    presentation.followUpContext
                );
            }

            const files = presentation.attachments.map((attachment) => ({
                filename: attachment.name ?? 'daneel-attachment.dat',
                data: attachment.attachment as Buffer,
            }));

            await responseHandler.sendEmbedMessage(presentation.embed, {
                content: presentation.content,
                files,
                directReply,
                components: presentation.components,
            });
            logger.debug(
                `Automated image response sent for message: ${message.id}`
            );
        } catch (error) {
            logger.error('Automated image generation failed:', error);
            await responseHandler.sendMessage(
                '⚠️ I tried to create an image but something went wrong.',
                [],
                directReply
            );
        }
    }

    private async checkRateLimits(
        message: Message
    ): Promise<{ allowed: boolean; error?: string }> {
        const results: Array<{ allowed: boolean; error?: string }> = [];

        if (this.rateLimiters.user) {
            results.push(
                await this.rateLimiters.user.check(
                    message.author.id,
                    message.channel.id,
                    message.guild?.id
                )
            );
        }
        if (this.rateLimiters.channel) {
            results.push(
                await this.rateLimiters.channel.check(
                    message.author.id,
                    message.channel.id,
                    message.guild?.id
                )
            );
        }
        if (this.rateLimiters.guild && message.guild) {
            results.push(
                await this.rateLimiters.guild.check(
                    message.author.id,
                    message.channel.id,
                    message.guild.id
                )
            );
        }

        return results.find((result) => !result.allowed) ?? { allowed: true };
    }
}

/**
 * Best-effort cleanup for legacy TTS temp files.
 * Most voice synthesis now streams through the backend, but this helper stays
 * available for any remaining disk-backed callers or tests.
 */
export async function cleanupTTSFile(ttsPath: string): Promise<void> {
    if (!ttsPath) return;

    try {
        await fs.promises.unlink(ttsPath);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
            return;
        }

        logger.debug(
            `Failed to delete TTS file ${ttsPath}: ${err?.message ?? err}`
        );
    }
}
