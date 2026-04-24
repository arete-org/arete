/**
 * @description: Coordinates image generation flows, retries, and embed formatting helpers.
 * @footnote-scope: utility
 * @footnote-module: ImageSessionHelpers
 * @footnote-risk: medium - Workflow errors can create duplicate charges or invalid responses.
 * @footnote-ethics: medium - Session behavior affects user expectations and transparency.
 */
import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    type APIEmbedField,
} from 'discord.js';
import { botApi } from '../../api/botApi.js';
import { logger } from '../../utils/logger.js';
import { formatUsd } from '../../utils/pricing.js';
import {
    EMBED_FIELD_VALUE_LIMIT,
    EMBED_MAX_FIELDS,
    EMBED_TOTAL_FIELD_CHAR_LIMIT,
    EMBED_TITLE_LIMIT,
    IMAGE_PROMPT_MAX_INPUT_CHARS,
    IMAGE_RETRY_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_CUSTOM_ID_PREFIX,
} from './constants.js';
import { isCloudinaryConfigured, uploadToCloudinary } from './cloudinary.js';
import type {
    ImageRenderModel,
    ImageStylePreset,
    ImageTextModel,
    PartialImagePayload,
    AnnotationFields,
    ImageOutputFormat,
    ImageOutputCompression,
} from './types.js';
import type { ImageGenerationContext } from './followUpCache.js';
import {
    sanitizeForEmbed,
    setEmbedFooterText,
    truncateForEmbed,
} from './embed.js';
import { runtimeConfig } from '../../config.js';

/**
 * Provides structured metadata about a generated image so that different
 * presentation layers (slash commands, automated responses, button retries)
 * can render consistent messages without duplicating the cost/upload logic.
 */
export interface ImageGenerationArtifacts {
    responseId: string | null;
    textModel: ImageTextModel;
    imageModel: ImageRenderModel;
    revisedPrompt: string | null;
    finalStyle: ImageStylePreset;
    annotations: AnnotationFields;
    finalImageBuffer: Buffer;
    finalImageFileName: string;
    imageUrl: string | null;
    outputFormat: ImageOutputFormat;
    outputCompression: ImageOutputCompression;
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        imageCount: number;
    };
    costs: {
        text: number;
        image: number;
        total: number;
        perImage: number;
    };
    generationTimeMs: number;
}

interface ExecuteImageGenerationOptions {
    followUpResponseId?: string | null;
    onPartialImage?: (payload: PartialImagePayload) => Promise<void> | void;
    stream?: boolean;
    user: {
        username: string;
        nickname: string;
        guildName: string;
    };
    channelContext?: {
        channelId?: string;
        guildId?: string;
    };
}

export interface PromptPolicyResult {
    prompt: string;
    maxInputChars: number;
    policyTruncated: boolean;
}

function buildTraceViewerUrl(responseId: string | null): string | null {
    if (!responseId || responseId.trim().length === 0) {
        return null;
    }
    const baseUrl = runtimeConfig.webBaseUrl.trim().replace(/\/+$/, '');
    return `${baseUrl}/traces/${encodeURIComponent(responseId.trim())}`;
}

const buildImageTaskRequest = (
    context: ImageGenerationContext,
    options: ExecuteImageGenerationOptions
) => {
    const shouldStream = options.stream ?? Boolean(options.onPartialImage);

    return {
        task: 'generate' as const,
        prompt: context.prompt,
        textModel: context.textModel,
        imageModel: context.imageModel,
        size: context.size,
        aspectRatio: context.aspectRatio,
        quality: context.quality,
        background: context.background,
        style: context.style,
        allowPromptAdjustment: context.allowPromptAdjustment,
        outputFormat: context.outputFormat,
        outputCompression: context.outputCompression,
        promptPolicy: {
            originalPrompt: context.originalPrompt,
            maxInputChars:
                Number.isFinite(context.promptPolicyMaxInputChars) &&
                context.promptPolicyMaxInputChars > 0
                    ? context.promptPolicyMaxInputChars
                    : IMAGE_PROMPT_MAX_INPUT_CHARS,
            policyTruncated: context.promptPolicyTruncated,
        },
        user: options.user,
        followUpResponseId: options.followUpResponseId ?? undefined,
        channelContext: options.channelContext,
        stream: shouldStream || undefined,
    };
};

/**
 * Runs the backend-owned image pipeline, uploads the final asset, and returns
 * a normalized payload describing the generation. The caller is responsible
 * for presenting the result (embed, plain message, etc.) and for storing
 * short-lived retry context when needed.
 */
export async function executeImageGeneration(
    context: ImageGenerationContext,
    options: ExecuteImageGenerationOptions
): Promise<ImageGenerationArtifacts> {
    const start = Date.now();
    const request = buildImageTaskRequest(context, options);
    const generation = request.stream
        ? await botApi.runImageTaskStreamViaApi(request, {
              onPartialImage: options.onPartialImage,
          })
        : await botApi.runImageTaskViaApi(request);

    const finalImageBuffer = Buffer.from(
        generation.result.finalImageBase64,
        'base64'
    );
    const extension = generation.result.outputFormat ?? 'png';
    const finalImageFileName = `footnote-image-${Date.now()}.${extension}`;
    let imageUrl: string | null = null;
    const revisedPrompt = generation.result.revisedPrompt ?? null;
    const finalStyle =
        (generation.result.finalStyle as ImageStylePreset) ?? context.style;

    if (isCloudinaryConfigured) {
        try {
            imageUrl = await uploadToCloudinary(finalImageBuffer, {
                originalPrompt: context.originalPrompt ?? context.prompt,
                revisedPrompt,
                title: generation.result.annotations.title,
                description: generation.result.annotations.description,
                noteMessage: generation.result.annotations.note,
                textModel: generation.result.textModel,
                imageModel: generation.result.imageModel,
                outputFormat: generation.result.outputFormat,
                outputCompression: generation.result.outputCompression,
                quality: context.quality,
                size: context.size,
                background: context.background,
                style: finalStyle,
                startTime: start,
                usage: {
                    inputTokens: generation.result.usage.inputTokens,
                    outputTokens: generation.result.usage.outputTokens,
                    totalTokens: generation.result.usage.totalTokens,
                    imageCount: generation.result.usage.imageCount,
                    combinedInputTokens: generation.result.usage.inputTokens,
                    combinedOutputTokens: generation.result.usage.outputTokens,
                    combinedTotalTokens: generation.result.usage.totalTokens,
                },
                cost: {
                    text: generation.result.costs.text,
                    image: generation.result.costs.image,
                    total: generation.result.costs.total,
                    perImage: generation.result.costs.perImage,
                },
            });
        } catch (error) {
            logger.error('Error uploading to Cloudinary:', error);
        }
    } else {
        logger.warn(
            'Cloudinary credentials missing; using local attachment for image delivery.'
        );
    }

    const artifacts: ImageGenerationArtifacts = {
        responseId: generation.result.responseId,
        textModel: generation.result.textModel as ImageTextModel,
        imageModel: generation.result.imageModel as ImageRenderModel,
        revisedPrompt,
        finalStyle,
        annotations: generation.result.annotations,
        finalImageBuffer,
        finalImageFileName,
        imageUrl,
        outputFormat: generation.result.outputFormat,
        outputCompression: generation.result.outputCompression,
        usage: {
            inputTokens: generation.result.usage.inputTokens,
            outputTokens: generation.result.usage.outputTokens,
            totalTokens: generation.result.usage.totalTokens,
            imageCount: generation.result.usage.imageCount,
        },
        costs: {
            text: generation.result.costs.text,
            image: generation.result.costs.image,
            total: generation.result.costs.total,
            perImage: generation.result.costs.perImage,
        },
        generationTimeMs:
            generation.result.generationTimeMs || Date.now() - start,
    };

    return artifacts;
}

/**
 * Represents the Discord message payload that should be sent once image
 * generation completes. Centralising the layout keeps slash-command,
 * automated, and retry flows perfectly in sync while making it easy to
 * recover metadata from embeds if the process restarts.
 */
export interface ImageResultPresentation {
    content?: string;
    embed: EmbedBuilder;
    attachments: AttachmentBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
    retryContext: ImageGenerationContext;
}

/**
 * Build a Discord-ready presentation (embed, attachments, components) and retry context for a completed image generation.
 *
 * Produces an embed containing machine-readable metadata and visible fields, any required image attachments, optional variation/retry components, and a retry context that captures the normalized prompts, selected models/style, and prompt-adjustment setting for retry flows.
 *
 * `@param` context - The original image generation context (user-visible settings and flags).
 * `@param` artifacts - Normalized results from the image generation pipeline (final image buffer/URL, models, prompts, annotations, costs, timing, and IDs).
 * `@param` options - Optional presentation options.
 * `@param` options.followUpResponseId - Optional upstream response ID to include as the Input ID field in embed metadata.
 * `@returns` An ImageResultPresentation containing the prepared embed, attachments, component rows, and retry context suitable for Discord responses.
 */
export function buildImageResultPresentation(
    context: ImageGenerationContext,
    artifacts: ImageGenerationArtifacts,
    { followUpResponseId }: { followUpResponseId?: string | null } = {}
): ImageResultPresentation {
    const originalPrompt = context.originalPrompt ?? context.prompt;
    // Only surface a refined/adjusted prompt when callers allow adjustments.
    const candidateRefinedPrompt = context.allowPromptAdjustment
        ? (artifacts.revisedPrompt ?? context.refinedPrompt ?? null)
        : null;
    const refinedPrompt =
        candidateRefinedPrompt && candidateRefinedPrompt !== originalPrompt
            ? candidateRefinedPrompt
            : null;
    const activePrompt = refinedPrompt ?? context.prompt;

    const normalizedOriginal = applyPromptPolicy(originalPrompt);
    const normalizedRefinedCandidate = refinedPrompt
        ? applyPromptPolicy(refinedPrompt)
        : null;
    const normalizedActive = applyPromptPolicy(activePrompt);
    const normalizedOriginalPrompt = normalizedOriginal.prompt;
    const normalizedActivePrompt = normalizedActive.prompt;
    const normalizedRefinedPrompt =
        normalizedRefinedCandidate &&
        normalizedRefinedCandidate.prompt !== normalizedOriginalPrompt
            ? normalizedRefinedCandidate.prompt
            : null;
    const policyTruncated =
        context.promptPolicyTruncated ||
        normalizedOriginal.policyTruncated ||
        normalizedActive.policyTruncated ||
        Boolean(normalizedRefinedCandidate?.policyTruncated);
    const contextPromptPolicyMax =
        Number.isFinite(context.promptPolicyMaxInputChars) &&
        context.promptPolicyMaxInputChars > 0
            ? context.promptPolicyMaxInputChars
            : IMAGE_PROMPT_MAX_INPUT_CHARS;
    const promptPolicyMaxInputChars = Math.max(
        contextPromptPolicyMax,
        normalizedOriginal.maxInputChars,
        normalizedActive.maxInputChars,
        normalizedRefinedCandidate?.maxInputChars ?? 0
    );

    const resolvedContext: ImageGenerationContext = {
        ...context,
        textModel: artifacts.textModel,
        imageModel: artifacts.imageModel,
        prompt: normalizedActivePrompt,
        originalPrompt: normalizedOriginalPrompt,
        refinedPrompt: normalizedRefinedPrompt,
        promptPolicyMaxInputChars,
        promptPolicyTruncated: policyTruncated,
        style: artifacts.finalStyle,
        allowPromptAdjustment: Boolean(context.allowPromptAdjustment),
    };

    const embed = new EmbedBuilder().setColor(0x5865f2).setTimestamp();

    const title = artifacts.annotations.title
        ? `🎨 ${artifacts.annotations.title}`
        : '🎨 Image Generation';
    embed.setTitle(truncateForEmbed(title, EMBED_TITLE_LIMIT));

    if (artifacts.imageUrl) {
        embed.setImage(artifacts.imageUrl);
    }

    // We build the field list manually so we can enforce Discord's 25-field and
    // 6,000-character limits. Exceeding these limits causes message edits to
    // fail, which would strand users without a usable follow-up button.
    const fields: APIEmbedField[] = [];
    let fieldCharacterBudget = 0;
    let metadataTruncated = false;

    const tryAddField = (
        name: string,
        rawValue: string,
        options: {
            inline?: boolean;
            includeTruncationNote?: boolean;
            maxLength?: number;
        } = {}
    ): boolean => {
        const formattedValue = truncateForEmbed(
            rawValue,
            options.maxLength ?? EMBED_FIELD_VALUE_LIMIT,
            {
                includeTruncationNote: options.includeTruncationNote ?? false,
            }
        );
        const charCost = name.length + formattedValue.length;

        if (
            fields.length >= EMBED_MAX_FIELDS ||
            fieldCharacterBudget + charCost > EMBED_TOTAL_FIELD_CHAR_LIMIT
        ) {
            return false;
        }

        fields.push({
            name,
            value: formattedValue,
            inline: options.inline ?? false,
        });
        fieldCharacterBudget += charCost;
        return true;
    };

    const assertField = (
        name: string,
        value: string,
        options?: {
            inline?: boolean;
            includeTruncationNote?: boolean;
            maxLength?: number;
        },
        { trackAsMetadata = true }: { trackAsMetadata?: boolean } = {}
    ) => {
        if (!tryAddField(name, value, options)) {
            if (trackAsMetadata) {
                metadataTruncated = true;
            }
            logger.warn(
                `Image embed field "${name}" could not be added due to Discord limits.`
            );
        }
    };

    const recordPrompt = (
        label: string,
        value: string | null | undefined
    ): boolean => {
        if (!value) {
            return false;
        }

        const sanitized = sanitizeForEmbed(value);
        const truncated = sanitized.length > EMBED_FIELD_VALUE_LIMIT;
        assertField(label, sanitized, { includeTruncationNote: truncated });
        return truncated;
    };

    let promptTruncated: boolean;
    let originalTruncated = false;

    const originalLabel = resolvedContext.allowPromptAdjustment
        ? 'Original prompt'
        : 'Prompt';

    if (normalizedRefinedPrompt) {
        promptTruncated = recordPrompt('Prompt', normalizedActivePrompt);
        originalTruncated = recordPrompt(
            originalLabel,
            normalizedOriginalPrompt
        );
    } else {
        promptTruncated = recordPrompt(originalLabel, normalizedOriginalPrompt);
    }

    assertField('Image model', resolvedContext.imageModel, { inline: true });
    assertField('Text model', resolvedContext.textModel, { inline: true });
    assertField('Quality', toTitleCase(resolvedContext.quality), {
        inline: true,
    });
    assertField('Aspect ratio', resolvedContext.aspectRatioLabel, {
        inline: true,
    });
    assertField(
        'Resolution',
        resolvedContext.size === 'auto' ? 'Auto' : resolvedContext.size,
        { inline: true }
    );
    assertField('Background', toTitleCase(resolvedContext.background), {
        inline: true,
    });
    assertField(
        'Prompt adjustment',
        resolvedContext.allowPromptAdjustment ? 'Enabled' : 'Disabled',
        { inline: true }
    );
    assertField('Output format', resolvedContext.outputFormat.toUpperCase(), {
        inline: true,
    });
    assertField('Compression', `${resolvedContext.outputCompression}%`, {
        inline: true,
    });
    assertField('Style', formatStylePreset(resolvedContext.style), {
        inline: true,
    });
    if (followUpResponseId) {
        assertField('Input ID', `\`${followUpResponseId}\``, { inline: true });
    }
    assertField(
        'Output ID',
        artifacts.responseId ? `\`${artifacts.responseId}\`` : 'n/a',
        { inline: true }
    );
    const traceUrl = buildTraceViewerUrl(artifacts.responseId);
    if (traceUrl) {
        assertField('Trace', `[Open trace](${traceUrl})`);
    }

    const refinedTruncated = normalizedRefinedPrompt ? promptTruncated : false;
    const activeTruncated = promptTruncated;

    embed.addFields(fields);

    const generationSeconds = Math.max(
        1,
        Math.round(artifacts.generationTimeMs / 1000)
    );
    const minutes = Math.floor(generationSeconds / 60);
    const seconds = generationSeconds % 60;
    const formattedDuration =
        minutes > 0
            ? `${minutes}m${seconds.toString().padStart(2, '0')}s`
            : `${seconds}s`;

    const { imagePercent, textPercent } = calculateCostPercentages(
        artifacts.costs.image,
        artifacts.costs.text
    );

    const footerParts = [
        `⏱️ ${formattedDuration}`,
        `💰${formatCostForFooter(artifacts.costs.total)}`,
        `🖼️${imagePercent}%`,
        `📝${textPercent}%`,
    ];

    if (originalTruncated || refinedTruncated || activeTruncated) {
        footerParts.push('Prompt truncated');
    }

    if (metadataTruncated) {
        footerParts.push('Metadata truncated');
    }

    setEmbedFooterText(embed, footerParts.join(' • '));

    const attachments: AttachmentBuilder[] = [];
    if (!artifacts.imageUrl) {
        attachments.push(createImageAttachment(artifacts));
    }

    const components = artifacts.responseId
        ? [createVariationButtonRow(artifacts.responseId)]
        : [];

    return {
        embed,
        attachments,
        components,
        retryContext: resolvedContext,
    };
}

/**
 * Applies the configured image prompt input policy before requests are sent to
 * backend image generation. Embed rendering still applies its own display caps.
 */
export function applyPromptPolicy(rawPrompt: string): PromptPolicyResult {
    const sanitized = sanitizeForEmbed(rawPrompt).trim();
    if (sanitized.length <= IMAGE_PROMPT_MAX_INPUT_CHARS) {
        return {
            prompt: sanitized,
            maxInputChars: IMAGE_PROMPT_MAX_INPUT_CHARS,
            policyTruncated: false,
        };
    }

    logger.warn(
        `Prompt exceeded input policy limit; truncating to ${IMAGE_PROMPT_MAX_INPUT_CHARS} characters.`
    );
    return {
        prompt: sanitized.slice(0, IMAGE_PROMPT_MAX_INPUT_CHARS),
        maxInputChars: IMAGE_PROMPT_MAX_INPUT_CHARS,
        policyTruncated: true,
    };
}

export function clampPromptForContext(rawPrompt: string): string {
    return applyPromptPolicy(rawPrompt).prompt;
}

/**
 * Formats a short human-readable countdown string (e.g., "2m30s") for rate
 * limit messaging and button labels.
 */
function formatCostForFooter(amount: number): string {
    if (!Number.isFinite(amount) || amount <= 0) {
        return '0¢';
    }

    if (amount < 1) {
        const tenthsOfCent = Math.max(0, Math.round(amount * 1000));
        return `${(tenthsOfCent / 10).toFixed(1)}¢`;
    }

    return formatUsd(amount, 2);
}

/**
 * Converts the raw image/text cost components into rounded percentages that
 * always add up to 100. This keeps the footer lightweight while still giving
 * users an intuitive sense of where their credits were spent.
 */
function calculateCostPercentages(
    imageCost: number,
    textCost: number
): { imagePercent: number; textPercent: number } {
    const safeImageCost =
        Number.isFinite(imageCost) && imageCost > 0 ? imageCost : 0;
    const safeTextCost =
        Number.isFinite(textCost) && textCost > 0 ? textCost : 0;
    const combined = safeImageCost + safeTextCost;

    if (combined <= 0) {
        return { imagePercent: 100, textPercent: 0 };
    }

    const rawImageShare = (safeImageCost / combined) * 100;
    let imagePercent = Math.round(rawImageShare);
    imagePercent = Math.min(100, Math.max(0, imagePercent));
    let textPercent = 100 - imagePercent;

    if (textPercent < 0) {
        textPercent = 0;
        imagePercent = 100;
    }

    return { imagePercent, textPercent };
}

export function formatRetryCountdown(seconds: number): string {
    if (seconds <= 0) {
        return 'now';
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0 && remainingSeconds > 0) {
        return `${minutes}m${remainingSeconds}s`;
    }

    if (minutes > 0) {
        return `${minutes}m`;
    }

    return `${remainingSeconds}s`;
}

/**
 * Converts snake_case choices returned by the planner or stored in context
 * into a human-friendly string for logs and user-facing content.
 */
export function toTitleCase(value: string): string {
    return value
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatStylePreset(value: ImageStylePreset): string {
    if (!value || value === 'unspecified') {
        return 'Auto';
    }

    return toTitleCase(value);
}

/**
 * Creates the reusable "Generate variation" button row used by both slash
 * command responses and automated message flows.
 */
export function createVariationButtonRow(
    responseId: string
): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
        .setCustomId(`${IMAGE_VARIATION_CUSTOM_ID_PREFIX}${responseId}`)
        .setLabel('Generate variation')
        .setStyle(ButtonStyle.Secondary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/**
 * Creates a "Retry image generation" button row with a countdown label.
 */
export function createRetryButtonRow(
    retryKey: string,
    countdown: string
): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
        .setCustomId(`${IMAGE_RETRY_CUSTOM_ID_PREFIX}${retryKey}`)
        .setLabel(`Retry image generation (${countdown})`)
        .setStyle(ButtonStyle.Secondary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/**
 * Converts the raw image buffer into an AttachmentBuilder for interaction-based
 * flows that expect Discord.js attachment instances.
 */
export function createImageAttachment(
    artifacts: ImageGenerationArtifacts
): AttachmentBuilder {
    return new AttachmentBuilder(artifacts.finalImageBuffer, {
        name: artifacts.finalImageFileName,
    });
}

export type { ImageGenerationContext };
