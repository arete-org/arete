/**
 * @description: Handles all pricing calculations and estimations for text and image generation.
 * @footnote-scope: core
 * @footnote-module: Pricing
 * @footnote-risk: high - Incorrect pricing calculations can lead to unexpected costs.
 * @footnote-ethics: high - Inaccurate pricing information for LLM interactions can erode trust.
 */

import crypto from 'node:crypto';
import { logger } from './logger.js';

// ====================
// Type Declarations
// ====================

export type GPT5ModelType =
    | 'gpt-5'
    | 'gpt-5-mini'
    | 'gpt-5-nano'
    | 'gpt-5.1'
    | 'gpt-5.2';
export type OmniModelType =
    | 'gpt-4o'
    | 'gpt-4o-mini'
    | 'gpt-4.1'
    | 'gpt-4.1-mini'
    | 'gpt-4.1-nano';
export type EmbeddingModelType =
    | 'text-embedding-3-small'
    | 'text-embedding-3-large'
    | 'text-embedding-ada-002';
export type TextModelPricingKey =
    | GPT5ModelType
    | OmniModelType
    | EmbeddingModelType;
export type ImageGenerationQuality = 'low' | 'medium' | 'high' | 'auto';
export type ImageGenerationSize =
    | '1024x1024'
    | '1024x1536'
    | '1536x1024'
    | 'auto';
export type ImageModelPricingKey =
    | 'gpt-image-1.5'
    | 'gpt-image-1'
    | 'gpt-image-1-mini';

/**
 * Core cost breakdown for any model type
 * @interface CostBreakdown
 * @property {number} inputTokens - Tokens consumed from the input prompt (user message, context, etc.)
 * @property {number} outputTokens - Tokens generated in the AI response
 * @property {number} inputCost - Cost for processing input tokens (typically cheaper)
 * @property {number} outputCost - Cost for generating output tokens (typically more expensive)
 * @property {number} totalCost - Combined cost of input + output processing
 */
export interface CostBreakdown {
    inputTokens: number;
    outputTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
}

/**
 * Extended cost breakdown with metadata for tracking and billing
 * @interface ModelCostBreakdown
 * @property {TextModelPricingKey} model - OpenAI model used (affects pricing per token)
 * @property {string} channelId - Discord channel ID for per-channel cost tracking
 * @property {string} guildId - Discord guild ID for per-guild cost tracking
 * @property {number} timestamp - When this cost was incurred (for billing periods)
 * @property {string} requestId - Unique identifier for this specific API call
 */
export interface ModelCostBreakdown extends CostBreakdown {
    model: TextModelPricingKey;
    channelId?: string;
    guildId?: string;
    timestamp: number;
    requestId: string;
}

/**
 * Aggregated cost statistics for reporting and budget enforcement
 * @interface CostStatistics
 * @property {number} totalCalls - Total number of API calls made
 * @property {number} totalTokensIn - Sum of all input tokens across all calls
 * @property {number} totalTokensOut - Sum of all output tokens across all calls
 * @property {number} totalCostUsd - Total spending in USD across all calls
 * @property {Record<string, { calls: number; tokensIn: number; tokensOut: number; costUsd: number }>} byModel - Cost breakdown grouped by AI model (useful for model comparison)
 * @property {Record<string, { calls: number; tokensIn: number; tokensOut: number; costUsd: number }>} byChannel - Cost breakdown grouped by Discord channel (useful for channel-specific budgets)
 * @property {Record<string, { calls: number; tokensIn: number; tokensOut: number; costUsd: number }>} byGuild - Cost breakdown grouped by Discord guild (useful for server-wide budgets)
 */
export interface CostStatistics {
    totalCalls: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCostUsd: number;
    byModel: Record<
        string,
        { calls: number; tokensIn: number; tokensOut: number; costUsd: number }
    >;
    byChannel?: Record<
        string,
        { calls: number; tokensIn: number; tokensOut: number; costUsd: number }
    >;
    byGuild?: Record<
        string,
        { calls: number; tokensIn: number; tokensOut: number; costUsd: number }
    >;
}

/**
 * Configuration options for image generation cost estimation
 * @interface ImageGenerationCostOptions
 * @property {ImageGenerationQuality} quality - Image quality setting (affects generation cost)
 * @property {ImageGenerationSize} size - Image dimensions (larger images cost more)
 * @property {number} imageCount - Number of images to generate (multiplies total cost)
 * @property {ImageModelPricingKey} model - OpenAI image model to use (different models have different pricing)
 */
export interface ImageGenerationCostOptions {
    quality: ImageGenerationQuality;
    size: ImageGenerationSize;
    imageCount?: number;
    model: ImageModelPricingKey;
}

/**
 * Calculated cost estimate for image generation with resolved settings
 * @interface ImageGenerationCostEstimate
 * @property {Exclude<ImageGenerationQuality, 'auto'>} effectiveQuality - Resolved quality setting (auto becomes 'low')
 * @property {Exclude<ImageGenerationSize, 'auto'>} effectiveSize - Resolved dimensions (auto becomes '1024x1024')
 * @property {number} imageCount - Number of images to generate
 * @property {number} perImageCost - Cost per individual image in USD
 * @property {number} totalCost - Total cost for all images in USD
 */
export interface ImageGenerationCostEstimate {
    effectiveQuality: Exclude<ImageGenerationQuality, 'auto'>;
    effectiveSize: Exclude<ImageGenerationSize, 'auto'>;
    imageCount: number;
    perImageCost: number;
    totalCost: number;
}

/**
 * Pricing per 1M tokens (USD) sourced from https://platform.openai.com/pricing
 * Updated on 2025-10-26
 */
const TEXT_MODEL_PRICING: Record<
    TextModelPricingKey,
    { input: number; output: number }
> = {
    // GPT-5 Models
    'gpt-5.2': { input: 1.75, output: 14.0 },
    'gpt-5.1': { input: 1.25, output: 10.0 },
    'gpt-5': { input: 1.25, output: 10.0 },
    'gpt-5-mini': { input: 0.25, output: 2.0 },
    'gpt-5-nano': { input: 0.05, output: 0.4 },

    // GPT-4 Models
    'gpt-4o': { input: 2.5, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4.1': { input: 2.0, output: 8.0 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },

    // Embedding Models (these bill only on input tokens)
    'text-embedding-3-small': { input: 0.02, output: 0 },
    'text-embedding-3-large': { input: 0.13, output: 0 },
    'text-embedding-ada-002': { input: 0.1, output: 0 },
};

/**
 * Pricing per image in USD sourced from https://platform.openai.com/pricing
 * Updated on 2025-12-18
 */
const IMAGE_GENERATION_COST_TABLE: Record<
    ImageModelPricingKey,
    Record<
        Exclude<ImageGenerationQuality, 'auto'>,
        Record<'1024x1024' | '1024x1536' | '1536x1024', number>
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
 * Resolves the effective quality for image generation cost estimation.
 * The OpenAI API defaults to "low" when quality is set to "auto", so we
 * mirror that behaviour for cost estimations to keep the numbers aligned.
 * @param {ImageGenerationQuality} quality - The quality to resolve
 * @returns {Exclude<ImageGenerationQuality, 'auto'>} The effective quality
 */
function resolveEffectiveQuality(
    quality: ImageGenerationQuality
): Exclude<ImageGenerationQuality, 'auto'> {
    return quality === 'auto' ? 'low' : quality;
}

/**
 * Resolves the effective size for image generation cost estimation.
 * The service currently resolves "auto" to a 1024x1024 canvas by default.
 * @param {ImageGenerationSize} size - The size to resolve
 * @returns {Exclude<ImageGenerationSize, 'auto'>} The effective size
 */
function resolveEffectiveSize(
    size: ImageGenerationSize
): Exclude<ImageGenerationSize, 'auto'> {
    return size === 'auto' ? '1024x1024' : size;
}

/**
 * Estimates the cost of text generation for a given model and token usage.
 * @`param {TextModelPricingKey} model - The model to estimate cost for
 * @param {number} inputTokens - The number of input tokens
 * @param {number} outputTokens - The number of output tokens
 * @returns {CostBreakdown} The estimated cost breakdown
 */
export function estimateTextCost(
    model: TextModelPricingKey,
    inputTokens: number,
    outputTokens: number
): CostBreakdown {
    const pricing = TEXT_MODEL_PRICING[model];
    if (!pricing) {
        logger.warn(
            `No pricing information found for model ${model}. Assuming zero cost.`
        );
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
}

/**
 * Estimates the cost of image generation for a given set of options.
 * @param {ImageGenerationCostOptions} options - The options to estimate cost for
 * @returns {ImageGenerationCostEstimate} The estimated cost breakdown
 */
export function estimateImageGenerationCost(
    options: ImageGenerationCostOptions
): ImageGenerationCostEstimate {
    // Even when callers forget to request a count we assume at least one image
    // so that the consumer receives a realistic non-zero cost estimate.
    const imageCount = Math.max(1, options.imageCount ?? 1);
    const effectiveQuality = resolveEffectiveQuality(options.quality);
    const effectiveSize = resolveEffectiveSize(options.size);

    // Calculated pricing for the given model
    const modelPricing = IMAGE_GENERATION_COST_TABLE[options.model];
    if (!modelPricing) {
        logger.warn(
            `Unable to locate pricing table for image model ${options.model}. Assuming zero cost.`
        );
        return {
            effectiveQuality,
            effectiveSize,
            imageCount,
            perImageCost: 0,
            totalCost: 0,
        };
    }

    // Pricing for the given quality
    const qualityPricing = modelPricing[effectiveQuality];
    if (!qualityPricing) {
        logger.warn(
            `No pricing tier defined for quality ${effectiveQuality} on model ${options.model}. Assuming zero cost.`
        );
        return {
            effectiveQuality,
            effectiveSize,
            imageCount,
            perImageCost: 0,
            totalCost: 0,
        };
    }

    // Pricing for the given size
    const perImageCost = qualityPricing[effectiveSize];
    if (typeof perImageCost !== 'number') {
        logger.warn(
            `Unable to determine pricing for model ${options.model}, quality ${effectiveQuality}, and size ${effectiveSize}.`
        );
        return {
            effectiveQuality,
            effectiveSize,
            imageCount,
            perImageCost: 0,
            totalCost: 0,
        };
    }

    // Total cost of the image generation
    const totalCost = perImageCost * imageCount;

    return {
        effectiveQuality,
        effectiveSize,
        imageCount,
        perImageCost,
        totalCost,
    };
}

/**
 * Formats a number in USD to a string with the specified number of fraction digits.
 * @param {number | null | undefined} amount - The amount to format
 * @param {number} fractionDigits - The number of fraction digits to include
 * @returns {string} The formatted amount
 */
export function formatUsd(
    amount: number | null | undefined,
    fractionDigits = 6
): string {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        logger.warn(
            `formatUsd received an invalid amount: ${amount}. Defaulting to $0.00.`
        );
        return '$0.00';
    }

    return `$${amount.toFixed(fractionDigits)}`;
}

/**
 * Creates a cost breakdown for a given model and token usage.
 * @param {TextModelPricingKey} model - The model to create a cost breakdown for
 * @param {number} inputTokens - The number of input tokens
 * @param {number} outputTokens - The number of output tokens
 * @param {string} channelId - The ID of the channel to create a cost breakdown for
 * @param {string} guildId - The ID of the guild to create a cost breakdown for
 * @returns {ModelCostBreakdown} The created cost breakdown
 */
export function createCostBreakdown(
    model: TextModelPricingKey,
    inputTokens: number,
    outputTokens: number,
    channelId?: string,
    guildId?: string
): ModelCostBreakdown {
    const baseCost = estimateTextCost(model, inputTokens, outputTokens);
    const timestamp = Date.now();
    const requestId = crypto.randomUUID();

    return {
        ...baseCost,
        model,
        channelId,
        guildId,
        timestamp,
        requestId,
    };
}

/**
 * Describes the token usage in a human-readable format.
 * @param {Object} usage - The token usage to describe
 * @param {number | null} usage.input_tokens - The number of input tokens
 * @param {number | null} usage.output_tokens - The number of output tokens
 * @param {number | null} usage.total_tokens - The total number of tokens
 * @returns {string} The described token usage
 */
export function describeTokenUsage(usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
}): string {
    if (!usage) {
        return 'Tokens: unknown';
    }

    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const total = usage.total_tokens ?? input + output;
    return `Tokens • In: ${input} • Out: ${output} • Total: ${total}`;
}

export { TEXT_MODEL_PRICING, IMAGE_GENERATION_COST_TABLE };

