/**
 * @description: Core Discord message processing that delegates reflect decisions to the backend and executes the returned action locally.
 * @footnote-scope: core
 * @footnote-module: MessageProcessor
 * @footnote-risk: high - Processing failures can break user interactions or route the wrong action.
 * @footnote-ethics: high - This path controls how Ari responds, when it stays silent, and how provenance is shown.
 */

import fs from 'fs';
import * as path from 'path';
import { Message } from 'discord.js';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type {
    PostReflectRequest,
    ReflectImageRequest,
    ReflectTriggerKind,
} from '@footnote/contracts/web';
import {
    OpenAIService,
    TTS_DEFAULT_OPTIONS,
    TTSOptions,
} from './openaiService.js';
import { logger } from './logger.js';
import { ResponseHandler } from './response/ResponseHandler.js';
import { RateLimiter } from './RateLimiter.js';
import { config } from './env.js';
import { ContextBuilder } from './prompting/ContextBuilder.js';
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
import { buildFooterEmbed } from './response/provenanceFooter.js';
import { botApi } from '../api/botApi.js';
import type { DiscordReflectApiResponse } from '../api/index.js';
import type {
    ImageBackgroundType,
    ImageRenderModel,
    ImageStylePreset,
    ImageTextModel,
    ImageOutputFormat,
} from '../commands/image/types.js';

type MessageProcessorOptions = {
    openaiService: OpenAIService;
    systemPrompt?: string;
};

type ReflectMessageAction = {
    action: 'message';
    message: string;
    modality: 'text' | 'tts';
    metadata: ResponseMetadata;
};

type ReflectReactAction = {
    action: 'react';
    reaction: string;
};

type ReflectImageAction = {
    action: 'image';
    imageRequest: ReflectImageRequest;
};

const RESPONSE_CONTEXT_SIZE = 24;
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

const isReflectMessageAction = (
    value: DiscordReflectApiResponse
): value is ReflectMessageAction =>
    value.action === 'message' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    ((value as { modality?: unknown }).modality === 'text' ||
        (value as { modality?: unknown }).modality === 'tts') &&
    hasResponseMetadata((value as { metadata?: unknown }).metadata);

const isReflectReactAction = (
    value: DiscordReflectApiResponse
): value is ReflectReactAction =>
    value.action === 'react' &&
    typeof (value as { reaction?: unknown }).reaction === 'string';

const isReflectImageAction = (
    value: DiscordReflectApiResponse
): value is ReflectImageAction =>
    value.action === 'image' &&
    Boolean(
        (value as { imageRequest?: ReflectImageRequest }).imageRequest?.prompt
    );

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

export class MessageProcessor {
    private readonly openaiService: OpenAIService;
    private readonly contextBuilder: ContextBuilder;
    private readonly rateLimiters: {
        user?: RateLimiter;
        channel?: RateLimiter;
        guild?: RateLimiter;
    };

    constructor(options: MessageProcessorOptions) {
        this.openaiService = options.openaiService;
        this.contextBuilder = new ContextBuilder(this.openaiService);

        this.rateLimiters = {};
        if (config.rateLimits.user.enabled) {
            this.rateLimiters.user = new RateLimiter({
                limit: config.rateLimits.user.limit,
                window: config.rateLimits.user.windowMs,
                scope: 'user',
            });
        }
        if (config.rateLimits.channel.enabled) {
            this.rateLimiters.channel = new RateLimiter({
                limit: config.rateLimits.channel.limit,
                window: config.rateLimits.channel.windowMs,
                scope: 'channel',
            });
        }
        if (config.rateLimits.guild.enabled) {
            this.rateLimiters.guild = new RateLimiter({
                limit: config.rateLimits.guild.limit,
                window: config.rateLimits.guild.windowMs,
                scope: 'guild',
            });
        }
    }

    /**
     * The bot now acts as a surface adapter:
     * 1. build a reflect request from Discord state
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

        const reflectContext = await this.buildReflectRequestFromMessage(
            message,
            trigger
        );
        if (!reflectContext) {
            return;
        }

        logger.debug(
            `Dispatching backend reflect request for message ${message.id} with trigger=${reflectContext.request.trigger.kind}.`
        );

        await responseHandler.startTyping();
        try {
            const reflectResponse = await botApi.reflectViaApi(
                reflectContext.request
            );
            await this.executeReflectAction(
                message,
                responseHandler,
                reflectResponse,
                directReply,
                reflectContext.recoveredImageContext
            );
        } finally {
            responseHandler.stopTyping();
        }
    }

    /**
     * Builds the transport-neutral request the backend planner needs, while
     * preserving image descriptions and follow-up hints that used to live only
     * inside the local planner path.
     */
    private async buildReflectRequestFromMessage(
        message: Message,
        trigger: string
    ): Promise<{
        request: PostReflectRequest;
        recoveredImageContext: RecoveredImageContext | null;
    } | null> {
        const { context } = await this.contextBuilder.buildMessageContext(
            message,
            RESPONSE_CONTEXT_SIZE
        );
        const imageAttachments = message.attachments.filter((attachment) =>
            attachment.contentType?.startsWith('image/')
        );

        if (imageAttachments.size > 0) {
            logger.debug(
                `Processing image attachment(s) for reflect request on message ${message.id}.`,
                {
                    attachmentCount: imageAttachments.size,
                    contentLength: message.content.length,
                }
            );

            const imageDescriptions = await Promise.all(
                imageAttachments.map(async (attachment) => {
                    try {
                        const response =
                            await this.openaiService.generateImageDescription(
                                attachment.url,
                                message.content,
                                {
                                    channelId: message.channelId,
                                    guildId: message.guildId ?? undefined,
                                }
                            );

                        return (
                            response.message?.content ??
                            `Error generating image description for message ${message.id} attachment ${attachment.id}`
                        );
                    } catch (error) {
                        logger.error(
                            `Error generating image description for reflect attachment on message ${message.id}: ${
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

            context.push({
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
                context.push({
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
                    `Recovered image embed for backend reflect: outputId=${recoveredImageContext.responseId ?? 'n/a'}, inputId=${recoveredImageContext.inputId ?? 'n/a'}, promptLength=${recoveredContext.prompt.length}.`
                );
            }
        } catch (error) {
            logger.debug(
                'Failed to recover image embed context for backend reflect:',
                error
            );
        }

        if (trigger.trim()) {
            context.push({
                role: 'system',
                content: `Trigger context: ${trigger.trim()}`,
            });
        }

        const conversation = context.slice(1).map((entry) => ({
            role: entry.role === 'developer' ? 'system' : entry.role,
            content: entry.content,
        }));
        if (conversation.length === 0) {
            return null;
        }

        return {
            request: {
                surface: 'discord',
                trigger: {
                    kind: this.getReflectTriggerKind(message),
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

    private getReflectTriggerKind(message: Message): ReflectTriggerKind {
        if (message.reference?.messageId) {
            return 'direct';
        }

        const botUserId = message.client.user?.id;
        if (botUserId && message.mentions.users.has(botUserId)) {
            return 'invoked';
        }

        return 'catchup';
    }

    /**
     * Unknown actions intentionally warn and no-op so backend-first action
     * additions do not crash the bot before the executor learns about them.
     */
    private async executeReflectAction(
        message: Message,
        responseHandler: ResponseHandler,
        reflectResponse: DiscordReflectApiResponse,
        directReply: boolean,
        recoveredImageContext: RecoveredImageContext | null
    ): Promise<void> {
        switch (reflectResponse.action) {
            case 'ignore':
                logger.debug(
                    `Backend reflect chose ignore for message ${message.id}.`
                );
                return;
            case 'react':
                if (!isReflectReactAction(reflectResponse)) {
                    logger.warn(
                        'Backend reflect returned a malformed react action; ignoring.'
                    );
                    return;
                }
                await responseHandler.addReaction(reflectResponse.reaction);
                logger.debug(
                    `Backend reflect added reaction(s) for message ${message.id}.`,
                    {
                        reaction: reflectResponse.reaction,
                        contentLength: message.content.length,
                    }
                );
                return;
            case 'image':
                if (!isReflectImageAction(reflectResponse)) {
                    logger.warn(
                        'Backend reflect returned a malformed image action; ignoring.'
                    );
                    return;
                }
                await this.executeReflectImageAction(
                    message,
                    responseHandler,
                    reflectResponse.imageRequest,
                    directReply,
                    recoveredImageContext
                );
                return;
            case 'message':
                if (!isReflectMessageAction(reflectResponse)) {
                    logger.warn(
                        'Backend reflect returned a malformed message action; ignoring.'
                    );
                    return;
                }
                await this.executeReflectMessageAction(
                    message,
                    responseHandler,
                    reflectResponse,
                    directReply
                );
                return;
            default:
                logger.warn(
                    `Backend reflect returned unsupported action "${reflectResponse.action}". Ignoring until the bot adds explicit support.`
                );
                return;
        }
    }

    private async executeReflectMessageAction(
        message: Message,
        responseHandler: ResponseHandler,
        reflectResponse: ReflectMessageAction,
        directReply: boolean
    ): Promise<void> {
        const finalResponseText =
            reflectResponse.message || 'No response generated.';

        let footerPayload: ReturnType<typeof buildFooterEmbed> | null = null;
        try {
            footerPayload = buildFooterEmbed(
                reflectResponse.metadata,
                config.webBaseUrl
            );
        } catch (error) {
            logger.error(
                `Failed to build provenance footer for response ${reflectResponse.metadata.responseId}: ${
                    (error as Error)?.message ?? error
                }`
            );
        }

        let ttsPath: string | null = null;
        if (reflectResponse.modality === 'tts') {
            const ttsOptions: TTSOptions = TTS_DEFAULT_OPTIONS;
            const ttsRequestId = Date.now().toString();
            try {
                ttsPath = await this.openaiService.generateSpeech(
                    finalResponseText,
                    ttsOptions,
                    ttsRequestId,
                    'mp3'
                );
            } catch (error) {
                logger.error(
                    `Reflect TTS generation failed for message ${message.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    {
                        ttsRequestId,
                        responseLength: finalResponseText.length,
                    }
                );
            }
        }

        if (ttsPath) {
            try {
                const fileBuffer = await fs.promises.readFile(ttsPath);
                const cleanResponseText = finalResponseText
                    .replace(/\n/g, ' ')
                    .replace(/`/g, '');
                const sentMessages = await responseHandler.sendMessage(
                    `\`\`\`${cleanResponseText}\`\`\``,
                    [
                        {
                            filename: path.basename(ttsPath),
                            data: fileBuffer,
                        },
                    ],
                    directReply
                );
                const responseMessages = Array.isArray(sentMessages)
                    ? sentMessages
                    : [sentMessages];
                const footerReplyAnchor =
                    responseMessages[responseMessages.length - 1];

                // Intentional: backend reflect already persisted the canonical trace.
                // Skipping postTraces here prevents duplicate trace rows for one reply.
                await this.sendProvenanceFooter(
                    footerReplyAnchor,
                    message,
                    footerPayload
                );
                return;
            } finally {
                await cleanupTTSFile(ttsPath);
            }
        }

        const sentMessages = await responseHandler.sendMessage(
            finalResponseText,
            [],
            directReply,
            true
        );
        const responseMessages = Array.isArray(sentMessages)
            ? sentMessages
            : [sentMessages];
        const footerReplyAnchor = responseMessages[responseMessages.length - 1];

        // Intentional: backend reflect already persisted the canonical trace.
        // Skipping postTraces here prevents duplicate trace rows for one reply.
        await this.sendProvenanceFooter(
            footerReplyAnchor,
            message,
            footerPayload
        );
        logger.debug(
            `Backend reflect sent message response for message ${message.id}.`,
            {
                responseLength: finalResponseText.length,
                contentLength: message.content.length,
                modality: reflectResponse.modality,
            }
        );
    }

    private async sendProvenanceFooter(
        footerReplyAnchor: Message,
        originalMessage: Message,
        footerPayload: ReturnType<typeof buildFooterEmbed> | null
    ): Promise<void> {
        if (!footerPayload) {
            return;
        }

        try {
            const footerHandler = new ResponseHandler(
                footerReplyAnchor,
                footerReplyAnchor.channel,
                originalMessage.author
            );
            await footerHandler.sendMessage(
                '',
                [],
                false,
                false,
                [],
                footerPayload.embeds.map((embed) => embed.build()),
                footerPayload.components
            );
        } catch (error) {
            logger.error(
                `Failed to send provenance footer follow-up: ${
                    (error as Error)?.message ?? error
                }`
            );
        }
    }

    private async executeReflectImageAction(
        message: Message,
        responseHandler: ResponseHandler,
        request: ReflectImageRequest,
        directReply: boolean,
        recoveredImageContext: RecoveredImageContext | null
    ): Promise<void> {
        logger.debug(
            `Backend reflect requested automated image generation for message ${message.id}.`,
            {
                contentLength: message.content.length,
                hasRecoveredImageContext: Boolean(recoveredImageContext),
            }
        );

        const trimmedPrompt = request.prompt.trim();
        if (!trimmedPrompt) {
            logger.warn(
                'Backend reflect image action was missing a prompt; ignoring.'
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
                    `Backend reflect supplied follow-up response ID "${followUpCandidate}" that was not found in cache or recovery; ignoring.`
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
