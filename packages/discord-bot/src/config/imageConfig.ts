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

/**
 * Hard coded defaults ensure the bot keeps working even when no overrides are
 * supplied. Defaults are conservative to minimize costs and avoid surprises.
 */
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

/**
 * Default multipliers reflect the pricing balance between models in easy-to-understand ratios for better user experience.
 * Updated: 2026-03-03
 */
const FALLBACK_MODEL_MULTIPLIERS: Record<ImageRenderModel, number> = {
    ...envDefaultValues.IMAGE_MODEL_MULTIPLIERS,
};

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

        overrides[modelName as ImageRenderModel] = parsedValue;
    }

    return overrides;
}

function parseOutputFormat(raw: string | undefined): ImageOutputFormat | null {
    if (!raw) {
        return null;
    }

    const normalized = raw.toLowerCase();
    if (
        normalized === 'png' ||
        normalized === 'webp' ||
        normalized === 'jpeg'
    ) {
        return normalized;
    }

    logger.warn(
        `Ignoring invalid IMAGE_DEFAULT_OUTPUT_FORMAT "${raw}". Expected png, webp, or jpeg.`
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
            (process.env.IMAGE_DEFAULT_TEXT_MODEL as
                | ImageTextModel
                | undefined) ?? FALLBACK_TEXT_MODEL,
        imageModel:
            (process.env.IMAGE_DEFAULT_IMAGE_MODEL as
                | ImageRenderModel
                | undefined) ?? FALLBACK_IMAGE_MODEL,
        quality:
            (process.env.IMAGE_DEFAULT_QUALITY as
                | ImageQualityType
                | undefined) ?? FALLBACK_IMAGE_QUALITY,
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

/**
 * Helper that resolves the multiplier for the provided model while gracefully
 * falling back to a neutral multiplier when the model is unknown.
 */
export function getImageModelTokenMultiplier(model: ImageRenderModel): number {
    return imageConfig.tokens.modelTokenMultipliers[model] ?? 1;
}
