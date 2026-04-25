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
    SupportedProvider,
} from './providers.js';

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
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-pro',
    'gpt-5.2',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.1',
    'gpt-5-pro',
    'gpt-5.2-pro',
    'gpt-5.3-codex',
    'gpt-5.3-chat-latest',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    ...supportedOpenAIEmbeddingModels,
] as const;

/**
 * One priced OpenAI text-capable model identifier.
 */
export type PricedOpenAITextModel =
    (typeof supportedPricedOpenAITextModels)[number];

/**
 * OpenAI realtime model ids with shared backend pricing data.
 */
export const supportedPricedOpenAIRealtimeModels = [
    'gpt-realtime-1.5',
    'gpt-realtime',
    'gpt-realtime-mini',
] as const;

/**
 * One priced OpenAI realtime model identifier.
 */
export type PricedOpenAIRealtimeModel =
    (typeof supportedPricedOpenAIRealtimeModels)[number];

/**
 * OpenAI TTS model ids with shared backend pricing data.
 */
export const supportedPricedOpenAITtsModels = [
    'tts-1',
    'tts-1-hd',
    'gpt-4o-mini-tts',
] as const;

/**
 * One priced OpenAI TTS model identifier.
 */
export type PricedOpenAITtsModel =
    (typeof supportedPricedOpenAITtsModels)[number];

/**
 * OpenAI image model ids with shared backend pricing data.
 */
export const supportedPricedOpenAIImageModels = [
    'gpt-image-2',
    'gpt-image-1.5',
    'gpt-image-1',
    'gpt-image-1-mini',
] as const;

/**
 * One priced OpenAI image model identifier.
 */
export type PricedOpenAIImageModel =
    (typeof supportedPricedOpenAIImageModels)[number];

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

export type OpenAIModelCanonicalizationRule =
    | 'trim'
    | 'lowercase'
    | 'remove_openai_prefix'
    | 'strip_slash_date_suffix'
    | 'strip_slash_snapshot_suffix'
    | 'strip_hyphen_date_suffix';

export interface OpenAIModelCanonicalizationResult {
    inputModel: string;
    canonicalModel: string;
    wasCanonicalized: boolean;
    appliedRules: OpenAIModelCanonicalizationRule[];
}

export interface OpenAIModelPricingResolution<ModelKey extends string> {
    inputModel: string;
    canonicalModel: string;
    matchedModel: ModelKey | null;
    wasCanonicalized: boolean;
    appliedRules: OpenAIModelCanonicalizationRule[];
}

export type ModelPricingCoverageClassification =
    | 'priced'
    | 'unpriced_by_policy'
    | 'unknown_unpriced';

/**
 * OpenAI text model ids intentionally excluded from shared backend pricing.
 * Keeping this explicit prevents silent drift between "missing price data"
 * and "known policy decision to treat as unpriced".
 */
export const explicitlyUnpricedOpenAITextModels = [] as const;
export type ExplicitlyUnpricedOpenAITextModel =
    (typeof explicitlyUnpricedOpenAITextModels)[number];

export interface ModelProfileTextPricingCoverage {
    provider: SupportedProvider;
    model: string;
    canonicalModel: string;
    matchedModel: PricedOpenAITextModel | null;
    classification: ModelPricingCoverageClassification;
    policyReason:
        | 'openai_priced'
        | 'openai_explicitly_unpriced_by_policy'
        | 'openai_unpriced_unknown'
        | 'non_openai_not_priced_by_backend_policy';
    wasCanonicalized: boolean;
    appliedRules: OpenAIModelCanonicalizationRule[];
}

/**
 * Realtime token pricing per 1M tokens (USD).
 * Source: https://platform.openai.com/docs/models/gpt-realtime
 * Last updated in-repo: 2026-03-20
 */
export type OpenAIRealtimePricingEntry = OpenAITextPricingEntry;

type OpenAIImageTokenPricingEntry = {
    input: number;
    output: number;
};

/**
 * Canonical text pricing per 1M tokens (USD).
 * Source: https://developers.openai.com/api/docs/pricing
 * Last updated in-repo: 2026-04-24
 */
export const openAITextPricingTable: Record<
    PricedOpenAITextModel,
    OpenAITextPricingEntry
> = {
    'gpt-5.5': { input: 2.5, output: 15.0 },
    'gpt-5.4': { input: 2.5, output: 15.0 },
    'gpt-5.4-pro': { input: 30.0, output: 180.0 },
    'gpt-5.2': { input: 1.75, output: 14.0 },
    'gpt-5.4-mini': { input: 0.75, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25 },
    'gpt-5.1': { input: 1.25, output: 10.0 },
    'gpt-5-pro': { input: 15.0, output: 120.0 },
    'gpt-5.2-pro': { input: 21.0, output: 168.0 },
    'gpt-5.3-codex': { input: 1.75, output: 14.0 },
    'gpt-5.3-chat-latest': { input: 1.75, output: 14.0 },
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
 * Canonical realtime pricing per 1M text tokens (USD).
 * Source: https://platform.openai.com/docs/models/gpt-realtime
 * Last updated in-repo: 2026-04-21
 *
 * We use the text-token row because the realtime usage payload currently
 * arrives as generic prompt/completion token counts at our backend boundary.
 */
export const openAIRealtimePricingTable: Record<
    PricedOpenAIRealtimeModel,
    OpenAIRealtimePricingEntry
> = {
    'gpt-realtime-1.5': { input: 4.0, output: 16.0 },
    'gpt-realtime': { input: 4.0, output: 16.0 },
    'gpt-realtime-mini': { input: 0.6, output: 2.4 },
};

/**
 * Canonical TTS pricing per 1M input tokens (USD).
 * Source: https://platform.openai.com/pricing
 * Last updated in-repo: 2026-03-20
 */
export const openAITtsPricingTable: Record<PricedOpenAITtsModel, number> = {
    'tts-1': 15,
    'tts-1-hd': 30,
    'gpt-4o-mini-tts': 0.6,
};

/**
 * Canonical image pricing per generated image (USD).
 * Source: https://developers.openai.com/api/docs/guides/image-generation
 * Last updated in-repo: 2026-04-24
 */
export const openAIImageGenerationPricingTable: Record<
    PricedOpenAIImageModel,
    Record<
        PricedImageGenerationQuality,
        Record<PricedImageGenerationSize, number>
    >
> = {
    'gpt-image-2': {
        low: {
            '1024x1024': 0.006,
            '1024x1536': 0.005,
            '1536x1024': 0.005,
        },
        medium: {
            '1024x1024': 0.053,
            '1024x1536': 0.041,
            '1536x1024': 0.041,
        },
        high: {
            '1024x1024': 0.211,
            '1024x1536': 0.165,
            '1536x1024': 0.165,
        },
    },
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
 * Source: https://developers.openai.com/api/docs/pricing
 * Last updated in-repo: 2026-04-24
 */
const openAIImageTokenPricingTable: Record<
    PricedOpenAIImageModel,
    OpenAIImageTokenPricingEntry
> = {
    'gpt-image-2': { input: 8.0, output: 30.0 },
    'gpt-image-1.5': { input: 8.0, output: 32.0 },
    'gpt-image-1': { input: 10.0, output: 40.0 },
    'gpt-image-1-mini': { input: 2.5, output: 8.0 },
};

const openAIProviderPrefixPattern = /^openai\//i;
const slashDateSuffixPattern = /\/\d{4}-\d{2}-\d{2}$/;
const slashSnapshotSuffixPattern = /\/snapshot-[a-z0-9._-]+$/;
const hyphenDateSuffixPattern = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Canonicalizes provider-qualified and version-suffixed OpenAI model ids
 * into a stable family id for pricing lookup.
 *
 * This is intentionally conservative:
 * - only OpenAI provider prefixes are stripped
 * - only known suffix formats are removed
 * - no cross-family guessing is attempted
 */
export const canonicalizeOpenAIModelIdForPricing = (
    model: string
): OpenAIModelCanonicalizationResult => {
    const inputModel = model;
    const appliedRules: OpenAIModelCanonicalizationRule[] = [];
    let canonicalModel = model.trim();

    if (canonicalModel !== model) {
        appliedRules.push('trim');
    }

    const lowerCased = canonicalModel.toLowerCase();
    if (lowerCased !== canonicalModel) {
        appliedRules.push('lowercase');
    }
    canonicalModel = lowerCased;

    if (openAIProviderPrefixPattern.test(canonicalModel)) {
        canonicalModel = canonicalModel.replace(
            openAIProviderPrefixPattern,
            ''
        );
        appliedRules.push('remove_openai_prefix');
    }

    if (slashDateSuffixPattern.test(canonicalModel)) {
        canonicalModel = canonicalModel.replace(slashDateSuffixPattern, '');
        appliedRules.push('strip_slash_date_suffix');
    }

    if (slashSnapshotSuffixPattern.test(canonicalModel)) {
        canonicalModel = canonicalModel.replace(slashSnapshotSuffixPattern, '');
        appliedRules.push('strip_slash_snapshot_suffix');
    }

    if (hyphenDateSuffixPattern.test(canonicalModel)) {
        canonicalModel = canonicalModel.replace(hyphenDateSuffixPattern, '');
        appliedRules.push('strip_hyphen_date_suffix');
    }

    return {
        inputModel,
        canonicalModel,
        wasCanonicalized: canonicalModel !== inputModel,
        appliedRules,
    };
};

const resolveOpenAIModelPricingKey = <ModelKey extends string>(
    model: string,
    table: Record<ModelKey, unknown>
): OpenAIModelPricingResolution<ModelKey> => {
    const canonicalized = canonicalizeOpenAIModelIdForPricing(model);
    const matchedModel = Object.prototype.hasOwnProperty.call(
        table,
        canonicalized.canonicalModel
    )
        ? (canonicalized.canonicalModel as ModelKey)
        : null;

    return {
        inputModel: canonicalized.inputModel,
        canonicalModel: canonicalized.canonicalModel,
        matchedModel,
        wasCanonicalized: canonicalized.wasCanonicalized,
        appliedRules: canonicalized.appliedRules,
    };
};

/**
 * Resolves one text model id to a priced model key after canonicalization.
 */
export const resolveOpenAITextPricingModel = (
    model: string
): OpenAIModelPricingResolution<PricedOpenAITextModel> =>
    resolveOpenAIModelPricingKey(model, openAITextPricingTable);

/**
 * Resolves one TTS model id to a priced model key after canonicalization.
 */
export const resolveOpenAITtsPricingModel = (
    model: string
): OpenAIModelPricingResolution<PricedOpenAITtsModel> =>
    resolveOpenAIModelPricingKey(model, openAITtsPricingTable);

/**
 * Resolves one realtime model id to a priced model key after canonicalization.
 */
export const resolveOpenAIRealtimePricingModel = (
    model: string
): OpenAIModelPricingResolution<PricedOpenAIRealtimeModel> =>
    resolveOpenAIModelPricingKey(model, openAIRealtimePricingTable);

/**
 * Resolves one image generation model id to a priced model key after
 * canonicalization.
 */
export const resolveOpenAIImagePricingModel = (
    model: string
): OpenAIModelPricingResolution<PricedOpenAIImageModel> =>
    resolveOpenAIModelPricingKey(model, openAIImageGenerationPricingTable);

/**
 * Checks whether Footnote has a shared text-pricing entry for the given model.
 */
export const hasOpenAITextPricing = (model: string): boolean =>
    resolveOpenAITextPricingModel(model).matchedModel !== null;

/**
 * Checks whether Footnote has a shared image-pricing entry for the given
 * render model.
 */
export const hasOpenAIImagePricing = (model: string): boolean =>
    resolveOpenAIImagePricingModel(model).matchedModel !== null;

/**
 * Checks whether Footnote has a shared TTS pricing entry for the given model.
 */
export const hasOpenAITtsPricing = (model: string): boolean =>
    resolveOpenAITtsPricingModel(model).matchedModel !== null;

/**
 * Checks whether Footnote has a shared realtime pricing entry for the given
 * model.
 */
export const hasOpenAIRealtimePricing = (model: string): boolean =>
    resolveOpenAIRealtimePricingModel(model).matchedModel !== null;

/**
 * Classifies whether one active text profile model is priced, intentionally
 * unpriced by policy, or currently unknown/unpriced.
 */
export const classifyModelProfileTextPricingCoverage = (
    provider: SupportedProvider,
    model: string
): ModelProfileTextPricingCoverage => {
    if (provider !== 'openai') {
        const canonicalized = canonicalizeOpenAIModelIdForPricing(model);
        return {
            provider,
            model,
            canonicalModel: canonicalized.canonicalModel,
            matchedModel: null,
            classification: 'unpriced_by_policy',
            policyReason: 'non_openai_not_priced_by_backend_policy',
            wasCanonicalized: canonicalized.wasCanonicalized,
            appliedRules: canonicalized.appliedRules,
        };
    }

    const resolved = resolveOpenAITextPricingModel(model);
    if (resolved.matchedModel) {
        return {
            provider,
            model,
            canonicalModel: resolved.canonicalModel,
            matchedModel: resolved.matchedModel,
            classification: 'priced',
            policyReason: 'openai_priced',
            wasCanonicalized: resolved.wasCanonicalized,
            appliedRules: resolved.appliedRules,
        };
    }

    if (
        explicitlyUnpricedOpenAITextModels.includes(
            resolved.canonicalModel as ExplicitlyUnpricedOpenAITextModel
        )
    ) {
        return {
            provider,
            model,
            canonicalModel: resolved.canonicalModel,
            matchedModel: null,
            classification: 'unpriced_by_policy',
            policyReason: 'openai_explicitly_unpriced_by_policy',
            wasCanonicalized: resolved.wasCanonicalized,
            appliedRules: resolved.appliedRules,
        };
    }

    return {
        provider,
        model,
        canonicalModel: resolved.canonicalModel,
        matchedModel: null,
        classification: 'unknown_unpriced',
        policyReason: 'openai_unpriced_unknown',
        wasCanonicalized: resolved.wasCanonicalized,
        appliedRules: resolved.appliedRules,
    };
};

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
    const pricingModel = resolveOpenAITextPricingModel(model).matchedModel;
    const pricing = pricingModel ? openAITextPricingTable[pricingModel] : null;

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
    const pricingModel = resolveOpenAITtsPricingModel(model).matchedModel;
    const pricing = pricingModel ? openAITtsPricingTable[pricingModel] : null;

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
 * Estimates realtime token cost from shared pricing data.
 * Unknown model strings fail open to zero cost so callers can keep running
 * while still surfacing mismatches through their own logs.
 */
export const estimateOpenAIRealtimeCost = (
    model: string,
    inputTokens: number,
    outputTokens: number
): OpenAITextCostBreakdown => {
    const pricingModel = resolveOpenAIRealtimePricingModel(model).matchedModel;
    const pricing = pricingModel
        ? openAIRealtimePricingTable[pricingModel]
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
            options.partialImageCount ?? (options.allowPartialImages ? 1 : 0)
        )
    );
    const effectiveQuality = resolveEffectiveImageGenerationQuality(
        options.quality
    );
    const effectiveSize = resolveEffectiveImageGenerationSize(options.size);
    const pricingModel = resolveOpenAIImagePricingModel(
        options.model
    ).matchedModel;
    const pricing = pricingModel
        ? openAIImageGenerationPricingTable[pricingModel]
        : null;
    const tokenPricing = pricingModel
        ? openAIImageTokenPricingTable[pricingModel]
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
