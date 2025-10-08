import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type APIEmbedField } from 'discord.js';
import { OpenAI } from 'openai';
import { logger } from '../../utils/logger.js';
import {
    estimateImageGenerationCost,
    estimateTextCost,
    formatUsd,
    type TextModelPricingKey
} from '../../utils/pricing.js';
import {
    EMBED_FIELD_VALUE_LIMIT,
    EMBED_MAX_FIELDS,
    EMBED_TOTAL_FIELD_CHAR_LIMIT,
    EMBED_TITLE_LIMIT,
    IMAGE_RETRY_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_CUSTOM_ID_PREFIX,
    REFLECTION_MESSAGE_LIMIT
} from './constants.js';
import { isCloudinaryConfigured, uploadToCloudinary } from './cloudinary.js';
import { generateImageWithReflection } from './openai.js';
import type {
    ImageGenerationCallWithPrompt,
    ImageRenderModel,
    ImageStylePreset,
    ImageTextModel,
    PartialImagePayload,
    ReflectionFields
} from './types.js';
import type { ImageGenerationContext } from './followUpCache.js';
import { sanitizeForEmbed, setEmbedDescription, setEmbedFooterText, truncateForEmbed } from './embed.js';

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
    reflection: ReflectionFields;
    reflectionMessage: string;
    finalImageBuffer: Buffer;
    finalImageFileName: string;
    imageUrl: string | null;
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
    user: {
        username: string;
        nickname: string;
        guildName: string;
    };
}

/**
 * Runs the OpenAI image pipeline, uploads the final asset, and returns a
 * normalized payload describing the generation. The caller is responsible for
 * presenting the result (embed, plain message, etc.) and for caching follow-up
 * context entries.
 */
export async function executeImageGeneration(
    context: ImageGenerationContext,
    options: ExecuteImageGenerationOptions
): Promise<ImageGenerationArtifacts> {
    const start = Date.now();
    const openai = new OpenAI();

    const generation = await generateImageWithReflection({
        openai,
        prompt: context.prompt,
        textModel: context.textModel,
        imageModel: context.imageModel,
        quality: context.quality,
        size: context.size,
        background: context.background,
        style: context.style,
        allowPromptAdjustment: context.allowPromptAdjustment,
        followUpResponseId: options.followUpResponseId,
        username: options.user.username,
        nickname: options.user.nickname,
        guildName: options.user.guildName,
        onPartialImage: options.onPartialImage
    });

    const { response, imageCall, finalImageBase64, reflection } = generation;
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? (inputTokens + outputTokens);

    const imageCallOutputs = response.output.filter(
        (output): output is ImageGenerationCallWithPrompt => output.type === 'image_generation_call' && Boolean(output.result)
    );
    const successfulImageCount = imageCallOutputs.length || 1;
    const finalStyle = imageCall.style_preset ?? context.style;

    const textCostEstimate = estimateTextCost(
        context.textModel as TextModelPricingKey,
        inputTokens,
        outputTokens
    );
    const imageCostEstimate = estimateImageGenerationCost({
        quality: context.quality,
        size: context.size,
        imageCount: successfulImageCount,
        model: context.imageModel
    });
    const totalCost = textCostEstimate.totalCost + imageCostEstimate.totalCost;

    const finalImageBuffer = Buffer.from(finalImageBase64, 'base64');
    const finalImageFileName = `daneel-image-${Date.now()}.png`;
    let imageUrl: string | null = null;

    if (isCloudinaryConfigured) {
        try {
            imageUrl = await uploadToCloudinary(finalImageBuffer, {
                originalPrompt: context.originalPrompt ?? context.prompt,
                revisedPrompt: reflection.adjustedPrompt ?? imageCall.revised_prompt ?? null,
                title: reflection.title,
                description: reflection.description,
                reflectionMessage: reflection.reflection,
                textModel: context.textModel,
                imageModel: context.imageModel,
                quality: context.quality,
                size: context.size,
                background: context.background,
                style: finalStyle,
                startTime: start,
                usage: {
                    inputTokens,
                    outputTokens,
                    totalTokens,
                    imageCount: successfulImageCount,
                    combinedInputTokens: inputTokens,
                    combinedOutputTokens: outputTokens,
                    combinedTotalTokens: totalTokens
                },
                cost: {
                    text: textCostEstimate.totalCost,
                    image: imageCostEstimate.totalCost,
                    total: totalCost,
                    perImage: imageCostEstimate.perImageCost
                }
            });
        } catch (error) {
            logger.error('Error uploading to Cloudinary:', error);
        }
    } else {
        logger.warn('Cloudinary credentials missing; using local attachment for image delivery.');
    }

    const generationTimeMs = Date.now() - start;
    const revisedPrompt = reflection.adjustedPrompt ?? imageCall.revised_prompt ?? null;
    const reflectionMessage = reflection.reflection
        ? truncateForEmbed(reflection.reflection, REFLECTION_MESSAGE_LIMIT, { includeTruncationNote: true })
        : '';

    return {
        responseId: response.id ?? null,
        textModel: context.textModel,
        imageModel: context.imageModel,
        revisedPrompt,
        finalStyle,
        reflection,
        reflectionMessage,
        finalImageBuffer,
        finalImageFileName,
        imageUrl,
        usage: {
            inputTokens,
            outputTokens,
            totalTokens,
            imageCount: successfulImageCount
        },
        costs: {
            text: textCostEstimate.totalCost,
            image: imageCostEstimate.totalCost,
            total: totalCost,
            perImage: imageCostEstimate.perImageCost
        },
        generationTimeMs
    };
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
    followUpContext: ImageGenerationContext;
}

/**
 * Builds the embed, attachments, and follow-up controls that should be sent
 * when an image generation task finishes. The resulting embed always embeds
 * machine-readable fields (model, prompt sections, etc.) to make reboot
 * recovery possible via Discord's native message history.
 */
export function buildImageResultPresentation(
    context: ImageGenerationContext,
    artifacts: ImageGenerationArtifacts,
    {
        followUpResponseId
    }: { followUpResponseId?: string | null } = {}
): ImageResultPresentation {
    const originalPrompt = context.originalPrompt ?? context.prompt;
    const candidateRefinedPrompt = artifacts.revisedPrompt ?? context.refinedPrompt ?? null;
    const refinedPrompt = candidateRefinedPrompt && candidateRefinedPrompt !== originalPrompt
        ? candidateRefinedPrompt
        : null;
    const activePrompt = refinedPrompt ?? context.prompt;

    const normalizedOriginalPrompt = clampPromptForContext(originalPrompt);
    const normalizedRefinedCandidate = refinedPrompt ? clampPromptForContext(refinedPrompt) : null;
    const normalizedActivePrompt = clampPromptForContext(activePrompt);
    const normalizedRefinedPrompt = normalizedRefinedCandidate && normalizedRefinedCandidate !== normalizedOriginalPrompt
        ? normalizedRefinedCandidate
        : null;

    const followUpContext: ImageGenerationContext = {
        ...context,
        textModel: artifacts.textModel,
        imageModel: artifacts.imageModel,
        prompt: normalizedActivePrompt,
        originalPrompt: normalizedOriginalPrompt,
        refinedPrompt: normalizedRefinedPrompt,
        style: artifacts.finalStyle,
        allowPromptAdjustment: context.allowPromptAdjustment ?? true
    };

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTimestamp();

    const title = artifacts.reflection.title ? `🎨 ${artifacts.reflection.title}` : '🎨 Image Generation';
    embed.setTitle(truncateForEmbed(title, EMBED_TITLE_LIMIT));

    if (artifacts.reflection.description) {
        setEmbedDescription(embed, artifacts.reflection.description);
    }

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
        options: { inline?: boolean; includeTruncationNote?: boolean; maxLength?: number } = {}
    ): boolean => {
        const formattedValue = truncateForEmbed(rawValue, options.maxLength ?? EMBED_FIELD_VALUE_LIMIT, {
            includeTruncationNote: options.includeTruncationNote ?? false
        });
        const charCost = name.length + formattedValue.length;

        if (fields.length >= EMBED_MAX_FIELDS || fieldCharacterBudget + charCost > EMBED_TOTAL_FIELD_CHAR_LIMIT) {
            return false;
        }

        fields.push({ name, value: formattedValue, inline: options.inline ?? false });
        fieldCharacterBudget += charCost;
        return true;
    };

    const assertField = (
        name: string,
        value: string,
        options?: { inline?: boolean; includeTruncationNote?: boolean; maxLength?: number },
        { trackAsMetadata = true }: { trackAsMetadata?: boolean } = {}
    ) => {
        if (!tryAddField(name, value, options)) {
            if (trackAsMetadata) {
                metadataTruncated = true;
            }
            logger.warn(`Image embed field "${name}" could not be added due to Discord limits.`);
        }
    };

    assertField('Prompt Adjustment', followUpContext.allowPromptAdjustment ? 'Enabled' : 'Disabled', { inline: true });
    // Persist both model selections so variations and reboot recovery retain the exact text/image pairing that produced the artwork.
    assertField('Text Model', followUpContext.textModel, { inline: true });
    assertField('Image Model', followUpContext.imageModel, { inline: true });
    assertField('Quality', `${toTitleCase(followUpContext.quality)} (${followUpContext.imageModel})`, { inline: true });
    assertField('Size', followUpContext.size === 'auto' ? 'Auto' : followUpContext.size, { inline: true });
    assertField('Aspect Ratio', followUpContext.aspectRatioLabel, { inline: true });
    assertField('Background', toTitleCase(followUpContext.background), { inline: true });
    assertField('Style', formatStylePreset(followUpContext.style), { inline: true });
    if (followUpResponseId) {
        assertField('Input ID', `\`${followUpResponseId}\``, { inline: true });
    }
    assertField('Output ID', artifacts.responseId ? `\`${artifacts.responseId}\`` : 'n/a', { inline: true });

    const recordPrompt = (label: string, value: string | null | undefined): boolean => {
        if (!value) {
            return false;
        }

        const sanitized = sanitizeForEmbed(value);
        const truncated = sanitized.length > EMBED_FIELD_VALUE_LIMIT;
        assertField(label, sanitized, { includeTruncationNote: truncated });
        return truncated;
    };

    // Surface the active model directly within the prompt label so we do not
    // need a dedicated metadata field while still retaining recovery context
    // after restarts.
    const refinedLabel = followUpContext.textModel && refinedPrompt
        ? `Refined Prompt (${followUpContext.textModel})`
        : 'Refined Prompt';
    const originalLabel = !refinedPrompt && followUpContext.textModel
        ? `Original Prompt (${followUpContext.textModel})`
        : 'Original Prompt';

    const originalTruncated = recordPrompt(originalLabel, originalPrompt);
    let refinedTruncated = false;
    if (refinedPrompt) {
        refinedTruncated = recordPrompt(refinedLabel, refinedPrompt);
    }

    const activeTruncated = refinedPrompt ? refinedTruncated : originalTruncated;

    embed.addFields(fields);

    const generationSeconds = Math.max(1, Math.round(artifacts.generationTimeMs / 1000));
    const minutes = Math.floor(generationSeconds / 60);
    const seconds = generationSeconds % 60;
    const formattedDuration = minutes > 0
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
        `📝${textPercent}%`
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

    const components = artifacts.responseId ? [createVariationButtonRow(artifacts.responseId)] : [];

    return {
        content: artifacts.reflectionMessage.trim() || undefined,
        embed,
        attachments,
        components,
        followUpContext
    };
}

/**
 * Clamps prompts so they always fit within a single embed field. This keeps the
 * presentation compact while ensuring reboot recovery keeps working because the
 * embed never spills into continuation fields that might get pruned.
 */
export function clampPromptForContext(rawPrompt: string): string {
    const sanitized = sanitizeForEmbed(rawPrompt).trim();

    if (sanitized.length <= EMBED_FIELD_VALUE_LIMIT) {
        return sanitized;
    }

    logger.warn(`Prompt exceeded embed field limit; truncating to ${EMBED_FIELD_VALUE_LIMIT} characters to preserve layout.`);
    return sanitized.slice(0, EMBED_FIELD_VALUE_LIMIT);
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
        const cents = Math.max(0, Math.round(amount * 100));
        return `${cents}¢`;
    }

    return formatUsd(amount, 2);
}

/**
 * Converts the raw image/text cost components into rounded percentages that
 * always add up to 100. This keeps the footer lightweight while still giving
 * users an intuitive sense of where their credits were spent.
 */
function calculateCostPercentages(imageCost: number, textCost: number): { imagePercent: number; textPercent: number } {
    const safeImageCost = Number.isFinite(imageCost) && imageCost > 0 ? imageCost : 0;
    const safeTextCost = Number.isFinite(textCost) && textCost > 0 ? textCost : 0;
    const combined = safeImageCost + safeTextCost;

    if (combined <= 0) {
        return { imagePercent: 100, textPercent: 0 };
    }

    const rawImageShare = safeImageCost / combined * 100;
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
    return value.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
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
export function createVariationButtonRow(responseId: string): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
        .setCustomId(`${IMAGE_VARIATION_CUSTOM_ID_PREFIX}${responseId}`)
        .setLabel('Generate variation')
        .setStyle(ButtonStyle.Secondary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/**
 * Creates a "Retry image generation" button row with a countdown label.
 */
export function createRetryButtonRow(retryKey: string, countdown: string): ActionRowBuilder<ButtonBuilder> {
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
export function createImageAttachment(artifacts: ImageGenerationArtifacts): AttachmentBuilder {
    return new AttachmentBuilder(artifacts.finalImageBuffer, { name: artifacts.finalImageFileName });
}

export type { ImageGenerationContext };
