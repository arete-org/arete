/**
 * @description: Stores shared OpenAI pricing tables and pure cost helpers used by backend, Discord, and runtime code.
 * @footnote-scope: interface
 * @footnote-module: SharedPricing
 * @footnote-risk: medium - Wrong prices or helper logic here would make multiple packages disagree about cost at the same time.
 * @footnote-ethics: high - Cost calculations shape transparency and spend reporting across Footnote.
 */

import type {
    SupportedOpenAIImageModel,
    SupportedOpenAITextModel,
    SupportedOpenAITtsModel,
} from './providers.js';
import { supportedOpenAITextModels } from './providers.js';

/**
 * Embedding models that still need shared cost math even though they are not
 * part of the curated text-model picker lists.
 */
export const supportedOpenAIEmbeddingModels = [
    'text-embedding-3-small',
    'text-embedding-3-large',
    'text-embedding-ada-002',
] as const;

/**
 * One known embedding model identifier with shared pricing data.
 */
export type SupportedOpenAIEmbeddingModel =
    (typeof supportedOpenAIEmbeddingModels)[number];

/**
 * Any OpenAI text-capable model that Footnote knows how to price today.
 */
export const supportedPricedOpenAITextModels = [
    ...supportedOpenAITextModels,
    ...supportedOpenAIEmbeddingModels,
] as const;

/**
 * One priced OpenAI text-capable model identifier.
 */
export type PricedOpenAITextModel =
    (typeof supportedPricedOpenAITextModels)[number];

/**
 * GPT-5 family identifiers used by Discord's text service layer.
 */
export type GPT5ModelType = Extract<SupportedOpenAITextModel, `gpt-5${string}`>;

/**
 * GPT-4o / GPT-4.1 family identifiers used by multimodal helper paths.
 */
export type OmniModelType = Extract<SupportedOpenAITextModel, `gpt-4${string}`>;

/**
 * Shared alias kept for existing callers that think in terms of text-pricing
 * keys instead of the broader priced-model registry.
 */
export type TextModelPricingKey = PricedOpenAITextModel;

/**
 * Shared alias kept for existing callers that think in terms of image-pricing
 * keys.
 */
export type ImageModelPricingKey = SupportedOpenAIImageModel;

/**
 * Image quality levels that change per-image pricing.
 */
export type ImageGenerationQuality = 'low' | 'medium' | 'high' | 'auto';

/**
 * Image canvas sizes that change per-image pricing.
 */
export type ImageGenerationSize =
    | '1024x1024'
    | '1024x1536'
    | '1536x1024'
    | 'auto';

/**
 * Resolved quality level after callers normalize image pricing inputs.
 * "auto" stays explicit so helpers can fail open instead of under-reporting.
 */
export type EffectiveImageGenerationQuality = ImageGenerationQuality;

type PricedImageGenerationQuality = Exclude<ImageGenerationQuality, 'auto'>;

/**
 * Resolved canvas size after callers normalize image pricing inputs.
 * "auto" stays explicit so helpers can fail open instead of under-reporting.
 */
export type EffectiveImageGenerationSize = ImageGenerationSize;

type PricedImageGenerationSize = Exclude<ImageGenerationSize, 'auto'>;

/**
 * Shared text-cost breakdown used by both backend accounting and bot-side
 * display helpers.
 */
export interface OpenAITextCostBreakdown {
    inputTokens: number;
    outputTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
}

/**
 * Shared TTS-cost breakdown used by backend accounting and bot-side display
 * helpers.
 */
export interface OpenAITtsCostBreakdown {
    inputTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
}

/**
 * Shared image-cost request shape.
 */
export interface ImageGenerationCostOptions {
    quality: ImageGenerationQuality;
    size: ImageGenerationSize;
    imageCount?: number;
    model: string;
    allowPartialImages?: boolean;
    partialImageCount?: number;
}

/**
 * Shared image-cost result with resolved settings.
 */
export interface ImageGenerationCostEstimate {
    effectiveQuality: EffectiveImageGenerationQuality;
    effectiveSize: EffectiveImageGenerationSize;
    imageCount: number;
    partialImageCount: number;
    perImageCost: number;
    totalCost: number;
}

export type OpenAITextPricingEntry = {
    input: number;
    output: number;
};

type OpenAIImageTokenPricingEntry = {
    input: number;
    output: number;
};

/**
 * Canonical text pricing per 1M tokens (USD).
 * Source: https://platform.openai.com/pricing
 * Last updated in-repo: 2025-10-26
 */
export const openAITextPricingTable: Record<
    PricedOpenAITextModel,
    OpenAITextPricingEntry
> = {
    'gpt-5.2': { input: 1.75, output: 14.0 },
    'gpt-5.1': { input: 1.25, output: 10.0 },
    'gpt-5': { input: 1.25, output: 10.0 },
    'gpt-5-mini': { input: 0.25, output: 2.0 },
    'gpt-5-nano': { input: 0.05, output: 0.4 },
    'gpt-4o': { input: 2.5, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4.1': { input: 2.0, output: 8.0 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
    'text-embedding-3-small': { input: 0.02, output: 0 },
    'text-embedding-3-large': { input: 0.13, output: 0 },
    'text-embedding-ada-002': { input: 0.1, output: 0 },
};

/**
 * Canonical TTS pricing per 1M input tokens (USD).
 * Source: https://platform.openai.com/pricing
 * Last updated in-repo: 2026-03-20
 */
export const openAITtsPricingTable: Record<SupportedOpenAITtsModel, number> = {
    'tts-1': 15,
    'tts-1-hd': 30,
    'gpt-4o-mini-tts': 0.6,
};

/**
 * Canonical image pricing per generated image (USD).
 * Source: https://platform.openai.com/pricing
 * Last updated in-repo: 2025-12-18
 */
export const openAIImageGenerationPricingTable: Record<
    SupportedOpenAIImageModel,
    Record<
        PricedImageGenerationQuality,
        Record<PricedImageGenerationSize, number>
    >
> = {
    'gpt-image-1.5': {
        low: {
            '1024x1024': 0.009,
            '1024x1536': 0.013,
            '1536x1024': 0.013,
        },
        medium: {
            '1024x1024': 0.034,
            '1024x1536': 0.05,
            '1536x1024': 0.05,
        },
        high: {
            '1024x1024': 0.133,
            '1024x1536': 0.2,
            '1536x1024': 0.2,
        },
    },
    'gpt-image-1': {
        low: {
            '1024x1024': 0.011,
            '1024x1536': 0.016,
            '1536x1024': 0.016,
        },
        medium: {
            '1024x1024': 0.042,
            '1024x1536': 0.063,
            '1536x1024': 0.063,
        },
        high: {
            '1024x1024': 0.167,
            '1024x1536': 0.25,
            '1536x1024': 0.25,
        },
    },
    'gpt-image-1-mini': {
        low: {
            '1024x1024': 0.005,
            '1024x1536': 0.006,
            '1536x1024': 0.006,
        },
        medium: {
            '1024x1024': 0.011,
            '1024x1536': 0.015,
            '1536x1024': 0.015,
        },
        high: {
            '1024x1024': 0.036,
            '1024x1536': 0.052,
            '1536x1024': 0.052,
        },
    },
};

/**
 * Canonical image token pricing per 1M tokens (USD).
 * Source: https://platform.openai.com/docs/pricing
 * Last updated in-repo: 2026-03-19
 */
const openAIImageTokenPricingTable: Record<
    SupportedOpenAIImageModel,
    OpenAIImageTokenPricingEntry
> = {
    'gpt-image-1.5': { input: 8.0, output: 32.0 },
    'gpt-image-1': { input: 10.0, output: 40.0 },
    'gpt-image-1-mini': { input: 2.5, output: 8.0 },
};

/**
 * Checks whether Footnote has a shared text-pricing entry for the given model.
 */
export const hasOpenAITextPricing = (
    model: string
): model is PricedOpenAITextModel =>
    Object.prototype.hasOwnProperty.call(openAITextPricingTable, model);

/**
 * Checks whether Footnote has a shared image-pricing entry for the given
 * render model.
 */
export const hasOpenAIImagePricing = (
    model: string
): model is SupportedOpenAIImageModel =>
    Object.prototype.hasOwnProperty.call(
        openAIImageGenerationPricingTable,
        model
    );

/**
 * Checks whether Footnote has a shared TTS pricing entry for the given model.
 */
export const hasOpenAITtsPricing = (
    model: string
): model is SupportedOpenAITtsModel =>
    Object.prototype.hasOwnProperty.call(openAITtsPricingTable, model);

/**
 * Resolves "auto" image quality to the default tier used by current image
 * generation accounting.
 */
export const resolveEffectiveImageGenerationQuality = (
    quality: ImageGenerationQuality
): EffectiveImageGenerationQuality => quality;

/**
 * Resolves "auto" image size to the default canvas used by current image
 * generation accounting.
 */
export const resolveEffectiveImageGenerationSize = (
    size: ImageGenerationSize
): EffectiveImageGenerationSize => size;

/**
 * Estimates text cost from shared pricing data.
 * Unknown model strings fail open to zero cost so callers can keep running
 * while still handling or logging the mismatch at their own boundary.
 */
export const estimateOpenAITextCost = (
    model: string,
    inputTokens: number,
    outputTokens: number
): OpenAITextCostBreakdown => {
    const pricing = hasOpenAITextPricing(model)
        ? openAITextPricingTable[model]
        : null;

    if (!pricing) {
        return {
            inputTokens,
            outputTokens,
            inputCost: 0,
            outputCost: 0,
            totalCost: 0,
        };
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return {
        inputTokens,
        outputTokens,
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
    };
};

/**
 * Estimates TTS cost from shared pricing data.
 * Unknown model strings fail open to zero cost so callers can keep running
 * while still surfacing mismatches through their own logs.
 */
export const estimateOpenAITtsCost = (
    model: string,
    inputTokens: number
): OpenAITtsCostBreakdown => {
    const pricing = hasOpenAITtsPricing(model)
        ? openAITtsPricingTable[model]
        : null;

    if (!pricing) {
        return {
            inputTokens,
            inputCost: 0,
            outputCost: 0,
            totalCost: 0,
        };
    }

    const inputCost = (inputTokens / 1_000_000) * pricing;
    return {
        inputTokens,
        inputCost,
        outputCost: 0,
        totalCost: inputCost,
    };
};

/**
 * Estimates image cost from shared pricing data.
 * Unknown model strings fail open to zero cost for the same reason as text
 * pricing: callers can keep the request path alive while surfacing the
 * mismatch through their own logs.
 */
export const estimateOpenAIImageGenerationCost = (
    options: ImageGenerationCostOptions
): ImageGenerationCostEstimate => {
    const imageCount = Math.max(1, options.imageCount ?? 1);
    const partialImageCount = Math.max(
        0,
        Math.round(
            options.partialImageCount ??
                (options.allowPartialImages ? 1 : 0)
        )
    );
    const effectiveQuality = resolveEffectiveImageGenerationQuality(
        options.quality
    );
    const effectiveSize = resolveEffectiveImageGenerationSize(options.size);
    const pricing = hasOpenAIImagePricing(options.model)
        ? openAIImageGenerationPricingTable[options.model]
        : null;
    const tokenPricing = hasOpenAIImagePricing(options.model)
        ? openAIImageTokenPricingTable[options.model]
        : null;

    if (
        !pricing ||
        !tokenPricing ||
        effectiveQuality === 'auto' ||
        effectiveSize === 'auto'
    ) {
        return {
            effectiveQuality,
            effectiveSize,
            imageCount,
            partialImageCount,
            perImageCost: 0,
            totalCost: 0,
        };
    }

    const perImageCost = pricing[effectiveQuality][effectiveSize] ?? 0;
    const partialImageCost =
        (partialImageCount * 100 * tokenPricing.output) / 1_000_000;

    return {
        effectiveQuality,
        effectiveSize,
        imageCount,
        partialImageCount,
        perImageCost,
        totalCost: perImageCost * imageCount + partialImageCost,
    };
};
