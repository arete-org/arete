/**
 * @description: Uploads generated images to Cloudinary and formats metadata for embeds.
 * @footnote-scope: utility
 * @footnote-module: ImageCloudinary
 * @footnote-risk: medium - Upload failures or metadata drift can break image delivery.
 * @footnote-ethics: medium - Handles user-generated images and related metadata.
 */
import { v2 as cloudinary } from 'cloudinary';
import { logger } from '../../utils/logger.js';
import { formatUsd } from '../../utils/pricing.js';
import { clampForCloudinary, chunkString, sanitizeForEmbed } from './embed.js';
import { CLOUDINARY_CONTEXT_VALUE_LIMIT } from './constants.js';
import type { UploadMetadata } from './types.js';

const formatToMime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
};

const cloudinaryConfig = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
};

export const isCloudinaryConfigured = Boolean(
    cloudinaryConfig.cloud_name &&
    cloudinaryConfig.api_key &&
    cloudinaryConfig.api_secret
);

if (isCloudinaryConfigured) {
    cloudinary.config(cloudinaryConfig);
} else {
    logger.warn(
        'Cloudinary credentials are missing. Image uploads are disabled.'
    );
}

export class CloudinaryConfigurationError extends Error {
    constructor(message = 'Cloudinary configuration is missing.') {
        super(message);
        this.name = 'CloudinaryConfigurationError';
    }
}

function addChunkedContext(
    context: Record<string, string>,
    keyPrefix: string,
    value: string | null | undefined,
    options: { fallback?: string } = {}
) {
    if (!value) {
        if (options.fallback) {
            context[keyPrefix] = sanitizeForEmbed(options.fallback);
        }
        return;
    }

    const chunks = chunkString(value, CLOUDINARY_CONTEXT_VALUE_LIMIT);
    if (chunks.length === 0) {
        context[keyPrefix] = clampForCloudinary(value);
        return;
    }

    chunks.forEach((chunk, index) => {
        const suffix = chunks.length === 1 ? '' : `_part_${index + 1}`;
        context[`${keyPrefix}${suffix}`] = clampForCloudinary(chunk);
    });
}

export async function uploadToCloudinary(
    imageBuffer: Buffer,
    metadata: UploadMetadata
): Promise<string> {
    if (!isCloudinaryConfigured) {
        throw new CloudinaryConfigurationError();
    }

    try {
        logger.debug(
            `Uploading image to Cloudinary with estimated cost ${formatUsd(metadata.cost.total)} and ${metadata.usage.totalTokens} tokens...`
        );

        const nowIso = new Date().toISOString();
        const context: Record<string, string> = {
            model: metadata.imageModel,
            text_model: metadata.textModel,
            image_model: metadata.imageModel,
            quality: metadata.quality,
            size: metadata.size,
            background: metadata.background,
            style_preset: metadata.style,
            generated_at: nowIso,
            generation_time: `${(Date.now() - metadata.startTime) / 1000}s`,
            text_input_tokens: metadata.usage.inputTokens.toString(),
            text_output_tokens: metadata.usage.outputTokens.toString(),
            text_total_tokens: metadata.usage.totalTokens.toString(),
            combined_input_tokens:
                metadata.usage.combinedInputTokens.toString(),
            combined_output_tokens:
                metadata.usage.combinedOutputTokens.toString(),
            combined_total_tokens:
                metadata.usage.combinedTotalTokens.toString(),
            image_count: metadata.usage.imageCount.toString(),
            cost_text_usd: formatUsd(metadata.cost.text),
            cost_image_usd: formatUsd(metadata.cost.image),
            cost_total_usd: formatUsd(metadata.cost.total),
            cost_per_image_usd: formatUsd(metadata.cost.perImage),
        };

        if (metadata.title) {
            context.image_title = clampForCloudinary(metadata.title);
        }

        if (metadata.description) {
            context.image_description = clampForCloudinary(
                metadata.description
            );
        }

        addChunkedContext(
            context,
            'annotation_note',
            metadata.noteMessage ?? undefined
        );
        addChunkedContext(context, 'original_prompt', metadata.originalPrompt);
        addChunkedContext(
            context,
            'adjusted_prompt',
            metadata.revisedPrompt ?? undefined,
            {
                fallback: 'Model reused the original prompt.',
            }
        );

        const mimeType = formatToMime[metadata.outputFormat] ?? 'image/png';

        const uploadResult = await cloudinary.uploader.upload(
            `data:${mimeType};base64,${imageBuffer.toString('base64')}`,
            {
                resource_type: 'image',
                public_id: `ai-image-${Date.now()}`,
                context,
                tags: [
                    'ai-generated',
                    'discord-bot',
                    metadata.textModel,
                    metadata.imageModel,
                    metadata.quality,
                    metadata.style,
                ],
            }
        );

        logger.debug(
            `Image uploaded to Cloudinary: ${uploadResult.secure_url}`
        );
        return uploadResult.secure_url;
    } catch (error) {
        logger.error(`Cloudinary upload error: ${error}`);
        throw error;
    }
}

