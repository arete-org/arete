/**
 * @description: Records backend token usage and estimated spend for server-side model calls.
 * @footnote-scope: core
 * @footnote-module: BackendLLMCostRecorder
 * @footnote-risk: medium - Incorrect pricing or totals can hide backend spend and weaken cost visibility.
 * @footnote-ethics: medium - Cost tracking supports transparency and responsible AI resource use.
 */
import {
    estimateOpenAITextCost,
    estimateOpenAIRealtimeCost,
    estimateOpenAITtsCost,
    hasOpenAITextPricing,
    hasOpenAIRealtimePricing,
    hasOpenAITtsPricing,
} from '@footnote/contracts/pricing';
import { formatUsd, logger, type LLMCostTotals } from '../utils/logger.js';

export type BackendLLMCostRecord = {
    feature:
        | 'chat'
        | 'chat_planner'
        | 'news'
        | 'image'
        | 'image_description'
        | 'tts'
        | 'voice_realtime';
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
    if (!hasOpenAITextPricing(model)) {
        logger.warn(
            `No backend LLM pricing configured for model ${model}. Recording zero estimated cost.`
        );
    }

    const estimatedCost = estimateOpenAITextCost(
        model,
        promptTokens,
        completionTokens
    );
    return {
        inputCostUsd: estimatedCost.inputCost,
        outputCostUsd: estimatedCost.outputCost,
        totalCostUsd: estimatedCost.totalCost,
    };
};

export const estimateBackendTtsCost = (
    model: string,
    promptTokens: number
): Pick<
    BackendLLMCostRecord,
    'inputCostUsd' | 'outputCostUsd' | 'totalCostUsd'
> => {
    if (!hasOpenAITtsPricing(model)) {
        logger.warn(
            `No backend TTS pricing configured for model ${model}. Recording zero estimated cost.`
        );
    }

    const estimatedCost = estimateOpenAITtsCost(model, promptTokens);
    return {
        inputCostUsd: estimatedCost.inputCost,
        outputCostUsd: estimatedCost.outputCost,
        totalCostUsd: estimatedCost.totalCost,
    };
};

export const estimateBackendVoiceRealtimeCost = (
    model: string,
    promptTokens: number,
    completionTokens: number
): Pick<
    BackendLLMCostRecord,
    'inputCostUsd' | 'outputCostUsd' | 'totalCostUsd'
> => {
    if (!hasOpenAIRealtimePricing(model)) {
        logger.warn(
            `No backend realtime pricing configured for model ${model}. Recording zero estimated cost.`
        );
    }

    const estimatedCost = estimateOpenAIRealtimeCost(
        model,
        promptTokens,
        completionTokens
    );
    return {
        inputCostUsd: estimatedCost.inputCost,
        outputCostUsd: estimatedCost.outputCost,
        totalCostUsd: estimatedCost.totalCost,
    };
};

export const recordBackendLLMUsage = (record: BackendLLMCostRecord): void => {
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
