/**
 * @description: Reads image command configuration with environment overrides and defaults.
 * @footnote-scope: utility
 * @footnote-module: ImageConfig
 * @footnote-risk: medium - Bad config can spike costs or break image generation.
 * @footnote-ethics: medium - Config affects output style and safety behavior.
 */
import { logger } from '../utils/logger.js';
import { envDefaultValues } from '@footnote/config-spec';
import type {
    ImageOutputCompression,
    ImageOutputFormat,
    ImageQualityType,
    ImageRenderModel,
    ImageTextModel,
} from '../commands/image/types.js';
import {
    imageOutputFormats,
    imageQualities,
    imageRenderModels,
    imageTextModels,
} from '../commands/image/types.js';

const VALID_TEXT_MODELS = new Set<ImageTextModel>(imageTextModels);
const VALID_IMAGE_MODELS = new Set<ImageRenderModel>(imageRenderModels);
const VALID_IMAGE_QUALITIES = new Set<ImageQualityType>(imageQualities);
const VALID_OUTPUT_FORMATS = new Set<ImageOutputFormat>(imageOutputFormats);
const FALLBACK_TEXT_MODEL =
    envDefaultValues.IMAGE_DEFAULT_TEXT_MODEL as ImageTextModel;
const FALLBACK_IMAGE_MODEL =
    envDefaultValues.IMAGE_DEFAULT_IMAGE_MODEL as ImageRenderModel;
const FALLBACK_IMAGE_QUALITY =
    envDefaultValues.IMAGE_DEFAULT_QUALITY as ImageQualityType;
const FALLBACK_OUTPUT_FORMAT =
    envDefaultValues.IMAGE_DEFAULT_OUTPUT_FORMAT as ImageOutputFormat;
const FALLBACK_OUTPUT_COMPRESSION =
    envDefaultValues.IMAGE_DEFAULT_OUTPUT_COMPRESSION as ImageOutputCompression;
const FALLBACK_TOKENS_PER_REFRESH = envDefaultValues.IMAGE_TOKENS_PER_REFRESH;
const FALLBACK_REFRESH_INTERVAL_MS =
    envDefaultValues.IMAGE_TOKEN_REFRESH_INTERVAL_MS;
const FALLBACK_MODEL_MULTIPLIERS =
    envDefaultValues.IMAGE_MODEL_MULTIPLIERS as Record<
        ImageRenderModel,
        number
    >;

/**
 * Safely parses numeric environment variables while logging invalid values so
 * operators know why their overrides were ignored.
 */
function readNumberEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined) {
        return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        logger.warn(
            `Ignoring invalid numeric override for ${key}: "${raw}" (expected a positive number).`
        );
        return fallback;
    }

    return parsed;
}

/**
 * Parses the optional JSON map stored in IMAGE_MODEL_MULTIPLIERS. This allows a
 * single variable to override multiple models when desired.
 */
function parseMultiplierMapFromJson(): Partial<
    Record<ImageRenderModel, number>
> {
    const raw = process.env.IMAGE_MODEL_MULTIPLIERS;
    if (!raw) {
        return {};
    }

    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const overrides: Partial<Record<ImageRenderModel, number>> = {};

        for (const [model, value] of Object.entries(parsed)) {
            if (!VALID_IMAGE_MODELS.has(model as ImageRenderModel)) {
                logger.warn(
                    `Skipping unsupported model key "${model}" in IMAGE_MODEL_MULTIPLIERS.`
                );
                continue;
            }

            const numericValue =
                typeof value === 'string' ? Number(value) : (value as number);
            if (!Number.isFinite(numericValue) || numericValue <= 0) {
                logger.warn(
                    `Skipping invalid multiplier for model ${model} in IMAGE_MODEL_MULTIPLIERS: ${String(value)}`
                );
                continue;
            }

            overrides[model as ImageRenderModel] = numericValue;
        }

        return overrides;
    } catch (error) {
        logger.warn('Failed to parse IMAGE_MODEL_MULTIPLIERS as JSON.', error);
        return {};
    }
}

/**
 * Reads model-specific overrides from environment variables that follow the
 * IMAGE_MODEL_MULTIPLIER_<MODEL_NAME> convention. Hyphens are replaced with
 * underscores in the environment suffix so standard shell syntax works.
 */
function parseMultiplierOverrides(): Record<ImageRenderModel, number> {
    const overrides: Record<ImageRenderModel, number> = {
        ...FALLBACK_MODEL_MULTIPLIERS,
    };
    const jsonOverrides = parseMultiplierMapFromJson();

    for (const [model, multiplier] of Object.entries(jsonOverrides)) {
        overrides[model as ImageRenderModel] = multiplier as number;
    }

    const prefix = 'IMAGE_MODEL_MULTIPLIER_';
    for (const [envKey, rawValue] of Object.entries(process.env)) {
        if (!envKey.startsWith(prefix) || rawValue === undefined) {
            continue;
        }

        const normalized = envKey.substring(prefix.length).toLowerCase();
        // Support dot-separated model names (e.g., gpt-image-1.5) via double underscores
        // while retaining underscore-to-hyphen mapping for the rest.
        const modelName = normalized.replace(/__/g, '.').replace(/_/g, '-');
        const parsedValue = Number(rawValue);
        if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
            logger.warn(
                `Skipping invalid image model multiplier ${rawValue} for ${envKey}; expected a positive number.`
            );
            continue;
        }

        if (!VALID_IMAGE_MODELS.has(modelName as ImageRenderModel)) {
            logger.warn(
                `Skipping unsupported image model multiplier override key ${envKey}; "${modelName}" is not a known image model.`
            );
            continue;
        }

        overrides[modelName as ImageRenderModel] = parsedValue;
    }

    return overrides;
}

function parseOutputFormat(raw: string | undefined): ImageOutputFormat | null {
    if (!raw) {
        return null;
    }

    const normalized = raw.trim().toLowerCase();
    if (VALID_OUTPUT_FORMATS.has(normalized as ImageOutputFormat)) {
        return normalized as ImageOutputFormat;
    }

    logger.warn(
        `Ignoring invalid IMAGE_DEFAULT_OUTPUT_FORMAT "${raw}". Expected png, webp, or jpeg.`
    );
    return null;
}

function parseTextModel(raw: string | undefined): ImageTextModel | null {
    if (!raw) {
        return null;
    }

    const normalized = raw.trim().toLowerCase();
    if (VALID_TEXT_MODELS.has(normalized as ImageTextModel)) {
        return normalized as ImageTextModel;
    }

    logger.warn(`Ignoring invalid IMAGE_DEFAULT_TEXT_MODEL "${raw}".`);
    return null;
}

function parseImageModel(raw: string | undefined): ImageRenderModel | null {
    if (!raw) {
        return null;
    }

    const normalized = raw.trim().toLowerCase();
    if (VALID_IMAGE_MODELS.has(normalized as ImageRenderModel)) {
        return normalized as ImageRenderModel;
    }

    logger.warn(`Ignoring invalid IMAGE_DEFAULT_IMAGE_MODEL "${raw}".`);
    return null;
}

function parseImageQuality(raw: string | undefined): ImageQualityType | null {
    if (!raw) {
        return null;
    }

    const normalized = raw.trim().toLowerCase();
    if (VALID_IMAGE_QUALITIES.has(normalized as ImageQualityType)) {
        return normalized as ImageQualityType;
    }

    logger.warn(
        `Ignoring invalid IMAGE_DEFAULT_QUALITY "${raw}". Expected low, medium, high, or auto.`
    );
    return null;
}

function parseOutputCompression(
    raw: string | undefined
): ImageOutputCompression | null {
    if (!raw) {
        return null;
    }

    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1 && value <= 100) {
        return value;
    }

    logger.warn(
        `Ignoring invalid IMAGE_DEFAULT_OUTPUT_COMPRESSION "${raw}". Expected a number between 1 and 100.`
    );
    return null;
}

/**
 * Public shape of the image command configuration consumed by generation,
 * uploads, and token accounting.
 */
export interface ImageConfiguration {
    defaults: {
        textModel: ImageTextModel;
        imageModel: ImageRenderModel;
        quality: ImageQualityType;
        outputFormat: ImageOutputFormat;
        outputCompression: ImageOutputCompression;
    };
    cloudinary: {
        cloudName: string | undefined;
        apiKey: string | undefined;
        apiSecret: string | undefined;
    };
    tokens: {
        tokensPerRefresh: number;
        refreshIntervalMs: number;
        modelTokenMultipliers: Record<ImageRenderModel, number>;
    };
}

/**
 * Centralised configuration for the image command. Keeping all defaults in one
 * module ensures the slash command, planner, and token accounting always stay
 * aligned, even when operators customise behaviour through environment
 * variables.
 */
export const imageConfig: ImageConfiguration = {
    defaults: {
        textModel:
            parseTextModel(process.env.IMAGE_DEFAULT_TEXT_MODEL) ??
            FALLBACK_TEXT_MODEL,
        imageModel:
            parseImageModel(process.env.IMAGE_DEFAULT_IMAGE_MODEL) ??
            FALLBACK_IMAGE_MODEL,
        quality:
            parseImageQuality(process.env.IMAGE_DEFAULT_QUALITY) ??
            FALLBACK_IMAGE_QUALITY,
        outputFormat:
            parseOutputFormat(process.env.IMAGE_DEFAULT_OUTPUT_FORMAT) ??
            FALLBACK_OUTPUT_FORMAT,
        outputCompression:
            parseOutputCompression(
                process.env.IMAGE_DEFAULT_OUTPUT_COMPRESSION
            ) ?? FALLBACK_OUTPUT_COMPRESSION,
    },
    cloudinary: {
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        apiSecret: process.env.CLOUDINARY_API_SECRET,
    },
    tokens: {
        tokensPerRefresh: readNumberEnv(
            'IMAGE_TOKENS_PER_REFRESH',
            FALLBACK_TOKENS_PER_REFRESH
        ),
        refreshIntervalMs: readNumberEnv(
            'IMAGE_TOKEN_REFRESH_INTERVAL_MS',
            FALLBACK_REFRESH_INTERVAL_MS
        ),
        modelTokenMultipliers: parseMultiplierOverrides(),
    },
};

const cloudinaryValues = Object.values(imageConfig.cloudinary).filter(Boolean);
if (
    cloudinaryValues.length > 0 &&
    cloudinaryValues.length < Object.keys(imageConfig.cloudinary).length
) {
    logger.warn(
        'Cloudinary credentials are only partially configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET together or leave all three unset.'
    );
}

/**
 * Helper that resolves the multiplier for the provided model while gracefully
 * falling back to a neutral multiplier when the model is unknown.
 */
export function getImageModelTokenMultiplier(model: ImageRenderModel): number {
    return imageConfig.tokens.modelTokenMultipliers[model] ?? 1;
}
