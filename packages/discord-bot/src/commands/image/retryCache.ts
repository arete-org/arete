/**
 * @description: Stores retry-scoped image generation context for token retry UX.
 * @footnote-scope: utility
 * @footnote-module: ImageRetryCache
 * @footnote-risk: medium - Retry cache mistakes can repeat incorrect prompts or settings.
 * @footnote-ethics: low - Caches user-provided prompts for short-lived retry interactions.
 */
import type {
    ImageBackgroundType,
    ImageQualityType,
    ImageRenderModel,
    ImageSizeType,
    ImageStylePreset,
    ImageTextModel,
    ImageOutputFormat,
    ImageOutputCompression,
} from './types.js';

/**
 * Represents the minimum data needed to recreate an image generation request.
 * This is stored so that we can re-run variations without asking the user to
 * manually re-enter every option.
 */
export interface ImageGenerationContext {
    /**
     * The prompt that should be sent to the model the next time this context is
     * used. When a refinement is available we promote it to the active prompt
     * so variations inherit the latest wording by default.
     */
    prompt: string;
    /**
     * The initial user-authored prompt. We keep this alongside the potentially
     * refined prompt so that embeds can present both versions and the recovery
     * logic always has the original source of truth to fall back to.
     */
    originalPrompt: string;
    /**
     * The most recent refined prompt returned by the model, if any. This is
     * optional because prompt adjustment may be disabled or the model may
     * choose not to alter the prompt.
     */
    refinedPrompt?: string | null;
    /**
     * Policy-enforced maximum prompt length used for image generation/storage
     * truncation decisions (not the embed/display character limit).
     */
    promptPolicyMaxInputChars: number;
    /**
     * True when original user input exceeded `promptPolicyMaxInputChars` and
     * was truncated to satisfy policy before generation/storage.
     */
    promptPolicyTruncated: boolean;
    textModel: ImageTextModel;
    imageModel: ImageRenderModel;
    size: ImageSizeType;
    aspectRatio: 'auto' | 'square' | 'portrait' | 'landscape';
    aspectRatioLabel: string;
    quality: ImageQualityType;
    background: ImageBackgroundType;
    style: ImageStylePreset;
    allowPromptAdjustment: boolean;
    outputFormat: ImageOutputFormat;
    outputCompression: ImageOutputCompression;
}

interface RetryCacheEntry {
    context: ImageGenerationContext;
    expiresAt: number;
    timeout: NodeJS.Timeout;
}

const DEFAULT_RETRY_CONTEXT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const retryContextCache = new Map<string, RetryCacheEntry>();

/**
 * Stores a retry context for later retrieval. Existing entries with the same
 * key are replaced and their eviction timers cleared.
 */
export function saveRetryContext(
    retryKey: string,
    context: ImageGenerationContext,
    ttlMs: number = DEFAULT_RETRY_CONTEXT_TTL_MS
): void {
    const existing = retryContextCache.get(retryKey);
    if (existing) {
        clearTimeout(existing.timeout);
    }

    const expiresAt = Date.now() + ttlMs;
    const timeout = setTimeout(() => {
        retryContextCache.delete(retryKey);
    }, ttlMs);

    retryContextCache.set(retryKey, { context, expiresAt, timeout });
}

/**
 * Retrieves a cached retry context if it has not expired yet. Expired
 * entries are removed and `null` is returned.
 */
export function readRetryContext(
    retryKey: string
): ImageGenerationContext | null {
    const entry = retryContextCache.get(retryKey);
    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= Date.now()) {
        clearTimeout(entry.timeout);
        retryContextCache.delete(retryKey);
        return null;
    }

    return entry.context;
}

/**
 * Forcefully evicts a cached retry context.
 */
export function evictRetryContext(retryKey: string): void {
    const entry = retryContextCache.get(retryKey);
    if (!entry) {
        return;
    }

    clearTimeout(entry.timeout);
    retryContextCache.delete(retryKey);
}

export { DEFAULT_RETRY_CONTEXT_TTL_MS };
