/**
 * @description: Records backend LLM token usage and estimated cost totals for server-side features.
 * @footnote-scope: core
 * @footnote-module: BackendLLMCostRecorder
 * @footnote-risk: medium - Incorrect pricing or totals can hide backend spend and weaken cost visibility.
 * @footnote-ethics: medium - Cost tracking supports transparency and responsible AI resource use.
 */
import { formatUsd, logger, type LLMCostTotals } from '../utils/logger.js';

type TextModelPricing = {
    input: number;
    output: number;
};

const TEXT_MODEL_PRICING: Record<string, TextModelPricing> = {
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
};

export type BackendLLMCostRecord = {
    feature: 'reflect' | 'reflect_planner';
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    inputCostUsd: number;
    outputCostUsd: number;
    totalCostUsd: number;
    timestamp: number;
};

const backendCostTotals: LLMCostTotals = {
    totalCostUsd: 0,
    totalCalls: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
};

export const estimateBackendTextCost = (
    model: string,
    promptTokens: number,
    completionTokens: number
): Pick<
    BackendLLMCostRecord,
    'inputCostUsd' | 'outputCostUsd' | 'totalCostUsd'
> => {
    const pricing = TEXT_MODEL_PRICING[model];
    if (!pricing) {
        logger.warn(
            `No backend LLM pricing configured for model ${model}. Recording zero estimated cost.`
        );
        return {
            inputCostUsd: 0,
            outputCostUsd: 0,
            totalCostUsd: 0,
        };
    }

    const inputCostUsd = (promptTokens / 1_000_000) * pricing.input;
    const outputCostUsd = (completionTokens / 1_000_000) * pricing.output;
    return {
        inputCostUsd,
        outputCostUsd,
        totalCostUsd: inputCostUsd + outputCostUsd,
    };
};

export const recordBackendLLMUsage = (
    record: BackendLLMCostRecord
): void => {
    backendCostTotals.totalCalls += 1;
    backendCostTotals.totalCostUsd += record.totalCostUsd;
    backendCostTotals.totalTokensIn += record.promptTokens;
    backendCostTotals.totalTokensOut += record.completionTokens;

    logger.info(
        JSON.stringify({
            event: 'backend_llm_cost',
            feature: record.feature,
            model: record.model,
            promptTokens: record.promptTokens,
            completionTokens: record.completionTokens,
            totalTokens: record.totalTokens,
            totalCostUsd: Number(record.totalCostUsd.toFixed(6)),
            totalCostFormatted: formatUsd(record.totalCostUsd),
            cumulativeTotalCostUsd: Number(
                backendCostTotals.totalCostUsd.toFixed(6)
            ),
            timestamp: record.timestamp,
        })
    );
};

export const getBackendLLMCostTotals = (): LLMCostTotals => ({
    totalCostUsd: backendCostTotals.totalCostUsd,
    totalCalls: backendCostTotals.totalCalls,
    totalTokensIn: backendCostTotals.totalTokensIn,
    totalTokensOut: backendCostTotals.totalTokensOut,
});
