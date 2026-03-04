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

const VALID_TEXT_MODELS = new Set<ImageTextModel>([
    'gpt-5.2',
    'gpt-5.1',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
]);
const VALID_IMAGE_MODELS = new Set<ImageRenderModel>([
    'gpt-image-1.5',
    'gpt-image-1',
    'gpt-image-1-mini',
]);
const VALID_IMAGE_QUALITIES = new Set<ImageQualityType>([
    'low',
    'medium',
    'high',
    'auto',
]);
const VALID_OUTPUT_FORMATS = new Set<ImageOutputFormat>([
    'png',
    'webp',
    'jpeg',
]);

const SAFE_TEXT_MODEL: ImageTextModel = 'gpt-4.1-mini';
const SAFE_IMAGE_MODEL: ImageRenderModel = 'gpt-image-1-mini';
const SAFE_IMAGE_QUALITY: ImageQualityType = 'low';
const SAFE_OUTPUT_FORMAT: ImageOutputFormat = 'png';
const SAFE_OUTPUT_COMPRESSION: ImageOutputCompression = 100;
const SAFE_TOKENS_PER_REFRESH = 10;
const SAFE_REFRESH_INTERVAL_MS = 86_400_000;
const SAFE_MODEL_MULTIPLIERS: Record<ImageRenderModel, number> = {
    'gpt-image-1-mini': 1,
    'gpt-image-1': 2,
    'gpt-image-1.5': 2,
};

/**
 * Hard coded defaults ensure the bot keeps working even when no overrides are
 * supplied. Defaults are conservative to minimize costs and avoid surprises.
 */
function validateTextModelDefault(
    value: string,
    key: string,
    fallback: ImageTextModel
): ImageTextModel {
    if (VALID_TEXT_MODELS.has(value as ImageTextModel)) {
        return value as ImageTextModel;
    }

    logger.error(
        `Shared config default for ${key} is invalid: "${value}". Falling back to "${fallback}".`
    );
    return fallback;
}

function validateImageModelDefault(
    value: string,
    key: string,
    fallback: ImageRenderModel
): ImageRenderModel {
    if (VALID_IMAGE_MODELS.has(value as ImageRenderModel)) {
        return value as ImageRenderModel;
    }

    logger.error(
        `Shared config default for ${key} is invalid: "${value}". Falling back to "${fallback}".`
    );
    return fallback;
}

function validateImageQualityDefault(
    value: string,
    key: string,
    fallback: ImageQualityType
): ImageQualityType {
    if (VALID_IMAGE_QUALITIES.has(value as ImageQualityType)) {
        return value as ImageQualityType;
    }

    logger.error(
        `Shared config default for ${key} is invalid: "${value}". Falling back to "${fallback}".`
    );
    return fallback;
}

function validateOutputFormatDefault(
    value: string,
    key: string,
    fallback: ImageOutputFormat
): ImageOutputFormat {
    if (VALID_OUTPUT_FORMATS.has(value as ImageOutputFormat)) {
        return value as ImageOutputFormat;
    }

    logger.error(
        `Shared config default for ${key} is invalid: "${value}". Falling back to "${fallback}".`
    );
    return fallback;
}

function validatePositiveNumberDefault(
    value: unknown,
    key: string,
    fallback: number
): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
    }

    logger.error(
        `Shared config default for ${key} is invalid: "${String(value)}". Falling back to "${fallback}".`
    );
    return fallback;
}

function validateCompressionDefault(
    value: unknown,
    key: string,
    fallback: ImageOutputCompression
): ImageOutputCompression {
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value >= 1 && value <= 100) {
            return value;
        }

        logger.error(
            `Shared config default for ${key} is out of range: "${value}". Falling back to "${fallback}".`
        );
        return fallback;
    }

    logger.error(
        `Shared config default for ${key} is invalid: "${String(value)}". Falling back to "${fallback}".`
    );
    return fallback;
}

function validateModelMultipliersDefault(
    value: unknown
): Record<ImageRenderModel, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        logger.error(
            'Shared config default for IMAGE_MODEL_MULTIPLIERS is invalid. Falling back to safe defaults.'
        );
        return { ...SAFE_MODEL_MULTIPLIERS };
    }

    const multipliers: Partial<Record<ImageRenderModel, number>> = {};

    for (const [model, multiplier] of Object.entries(value)) {
        if (!VALID_IMAGE_MODELS.has(model as ImageRenderModel)) {
            logger.error(
                `Shared config default for IMAGE_MODEL_MULTIPLIERS has an unsupported model key: "${model}". Falling back to safe defaults.`
            );
            return { ...SAFE_MODEL_MULTIPLIERS };
        }

        if (
            typeof multiplier !== 'number' ||
            !Number.isFinite(multiplier) ||
            multiplier <= 0
        ) {
            logger.error(
                `Shared config default for IMAGE_MODEL_MULTIPLIERS has an invalid multiplier for "${model}": "${String(multiplier)}". Falling back to safe defaults.`
            );
            return { ...SAFE_MODEL_MULTIPLIERS };
        }

        multipliers[model as ImageRenderModel] = multiplier;
    }

    return {
        ...SAFE_MODEL_MULTIPLIERS,
        ...multipliers,
    };
}

const FALLBACK_TEXT_MODEL = validateTextModelDefault(
    envDefaultValues.IMAGE_DEFAULT_TEXT_MODEL,
    'IMAGE_DEFAULT_TEXT_MODEL',
    SAFE_TEXT_MODEL
);
const FALLBACK_IMAGE_MODEL = validateImageModelDefault(
    envDefaultValues.IMAGE_DEFAULT_IMAGE_MODEL,
    'IMAGE_DEFAULT_IMAGE_MODEL',
    SAFE_IMAGE_MODEL
);
const FALLBACK_IMAGE_QUALITY = validateImageQualityDefault(
    envDefaultValues.IMAGE_DEFAULT_QUALITY,
    'IMAGE_DEFAULT_QUALITY',
    SAFE_IMAGE_QUALITY
);
const FALLBACK_OUTPUT_FORMAT = validateOutputFormatDefault(
    envDefaultValues.IMAGE_DEFAULT_OUTPUT_FORMAT,
    'IMAGE_DEFAULT_OUTPUT_FORMAT',
    SAFE_OUTPUT_FORMAT
);
const FALLBACK_OUTPUT_COMPRESSION = validateCompressionDefault(
    envDefaultValues.IMAGE_DEFAULT_OUTPUT_COMPRESSION,
    'IMAGE_DEFAULT_OUTPUT_COMPRESSION',
    SAFE_OUTPUT_COMPRESSION
);
const FALLBACK_TOKENS_PER_REFRESH = validatePositiveNumberDefault(
    envDefaultValues.IMAGE_TOKENS_PER_REFRESH,
    'IMAGE_TOKENS_PER_REFRESH',
    SAFE_TOKENS_PER_REFRESH
);
const FALLBACK_REFRESH_INTERVAL_MS = validatePositiveNumberDefault(
    envDefaultValues.IMAGE_TOKEN_REFRESH_INTERVAL_MS,
    'IMAGE_TOKEN_REFRESH_INTERVAL_MS',
    SAFE_REFRESH_INTERVAL_MS
);

/**
 * Default multipliers reflect the pricing balance between models in easy-to-understand ratios for better user experience.
 * Updated: 2026-03-03
 */
const FALLBACK_MODEL_MULTIPLIERS = validateModelMultipliersDefault(
    envDefaultValues.IMAGE_MODEL_MULTIPLIERS
);

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

function parseTextModel(raw: string | undefined): ImageTextModel | null {
    if (!raw) {
        return null;
    }

    if (VALID_TEXT_MODELS.has(raw as ImageTextModel)) {
        return raw as ImageTextModel;
    }

    logger.warn(`Ignoring invalid IMAGE_DEFAULT_TEXT_MODEL "${raw}".`);
    return null;
}

function parseImageModel(raw: string | undefined): ImageRenderModel | null {
    if (!raw) {
        return null;
    }

    if (VALID_IMAGE_MODELS.has(raw as ImageRenderModel)) {
        return raw as ImageRenderModel;
    }

    logger.warn(`Ignoring invalid IMAGE_DEFAULT_IMAGE_MODEL "${raw}".`);
    return null;
}

function parseImageQuality(raw: string | undefined): ImageQualityType | null {
    if (!raw) {
        return null;
    }

    if (VALID_IMAGE_QUALITIES.has(raw as ImageQualityType)) {
        return raw as ImageQualityType;
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
