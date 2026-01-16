/**
 * @description: Reads image command configuration with environment overrides and defaults.
 * @arete-scope: utility
 * @arete-module: ImageConfig
 * @arete-risk: moderate - Bad config can spike costs or break image generation.
 * @arete-ethics: moderate - Config affects output style and safety behavior.
 */
import { logger } from '../utils/logger.js';
import type {
    ImageOutputCompression,
    ImageOutputFormat,
    ImageQualityType,
    ImageRenderModel,
    ImageTextModel,
} from '../commands/image/types.js';

/**
 * Hard coded defaults ensure the bot keeps working even when no overrides are
 * supplied. Environment variables can override any of these values at runtime
 * without requiring a redeploy.
 */
const FALLBACK_TEXT_MODEL: ImageTextModel = 'gpt-4.1-mini';
const FALLBACK_IMAGE_MODEL: ImageRenderModel = 'gpt-image-1-mini';
const FALLBACK_IMAGE_QUALITY: ImageQualityType = 'low';
const FALLBACK_OUTPUT_FORMAT: ImageOutputFormat = 'webp';
const FALLBACK_OUTPUT_COMPRESSION: ImageOutputCompression = 80;
const FALLBACK_TOKENS_PER_REFRESH = 10;
const FALLBACK_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Default multipliers reflect the existing pricing balance between the mini and
 * full render models. Operators can override them through environment
 * variables when the balance needs tuning.
 */
const FALLBACK_MODEL_MULTIPLIERS: Record<ImageRenderModel, number> = {
    'gpt-image-1-mini': 1,
    'gpt-image-1.5': 2, // Latest model, 1.5, is cheaper than 1
    'gpt-image-1': 3,
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
