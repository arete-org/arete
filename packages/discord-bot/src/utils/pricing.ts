/**
 * @description: Formats cost values for Discord and re-exports the shared pricing helpers used across the repo.
 * @footnote-scope: core
 * @footnote-module: Pricing
 * @footnote-risk: medium - Wrong formatting or exports here would confuse Discord-side cost displays.
 * @footnote-ethics: high - Clear cost display supports user trust and transparent AI usage.
 */

export type {
    GPT5ModelType,
    OmniModelType,
    SupportedOpenAIEmbeddingModel as EmbeddingModelType,
    TextModelPricingKey,
    ImageGenerationQuality,
    ImageGenerationSize,
    ImageModelPricingKey,
    OpenAITextCostBreakdown as CostBreakdown,
    ImageGenerationCostOptions,
    ImageGenerationCostEstimate,
} from '@footnote/contracts/pricing';
export {
    estimateOpenAITextCost as estimateTextCost,
    estimateOpenAIImageGenerationCost as estimateImageGenerationCost,
    openAITextPricingTable as TEXT_MODEL_PRICING,
    openAIImageGenerationPricingTable as IMAGE_GENERATION_COST_TABLE,
} from '@footnote/contracts/pricing';
import { logger } from './logger.js';

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
