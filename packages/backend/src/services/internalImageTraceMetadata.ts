/**
 * @description: Builds canonical image-generation provenance metadata for trace persistence.
 * @footnote-scope: core
 * @footnote-module: InternalImageTraceMetadata
 * @footnote-risk: high - Invalid metadata assembly can break trace reads and follow-up image recovery.
 * @footnote-ethics: high - Prompt-rich image provenance payloads affect transparency and future governance controls.
 */
import { createHash } from 'node:crypto';
import type {
    ImageGenerationMetadata,
    ResponseMetadata,
} from '@footnote/contracts/ethics-core';
import type {
    PostInternalImageGenerateRequest,
    PostInternalImageGenerateResponse,
} from '@footnote/contracts/web';

const IMAGE_TRACE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_IMAGE_PROMPT_MAX_INPUT_CHARS = 8000;
const DEFAULT_IMAGE_PROVENANCE: ResponseMetadata['provenance'] = 'Speculative';
const DEFAULT_IMAGE_SAFETY_TIER: ResponseMetadata['safetyTier'] = 'Low';
const DEFAULT_IMAGE_LICENSE_CONTEXT = 'MIT + HL3';

const clampOutputCompression = (value: number): number => {
    if (!Number.isFinite(value)) {
        return 100;
    }

    return Math.min(100, Math.max(1, Math.round(value)));
};

const normalizeOriginalPrompt = (
    request: PostInternalImageGenerateRequest
): string => {
    const fromPolicy = request.promptPolicy?.originalPrompt?.trim();
    if (fromPolicy && fromPolicy.length > 0) {
        return fromPolicy;
    }

    return request.prompt;
};

/**
 * Builds one deterministic metadata payload for image generation traces.
 *
 * TODO(auth-memory-governance): Route prompt storage and retrieval through
 * upcoming user opt-in auth/memory/governance controls before broad exposure.
 */
export const buildInternalImageTraceMetadata = (input: {
    request: PostInternalImageGenerateRequest;
    response: PostInternalImageGenerateResponse;
}): ResponseMetadata | null => {
    const responseId = input.response.result.responseId;
    if (!responseId) {
        return null;
    }

    const now = Date.now();
    const originalPrompt = normalizeOriginalPrompt(input.request);
    const activePrompt =
        input.response.result.revisedPrompt ?? input.request.prompt;
    const maxInputChars =
        input.request.promptPolicy?.maxInputChars ??
        DEFAULT_IMAGE_PROMPT_MAX_INPUT_CHARS;
    const policyTruncated = Boolean(input.request.promptPolicy?.policyTruncated);

    const imageGeneration: ImageGenerationMetadata = {
        version: 'v1',
        prompts: {
            original: originalPrompt,
            active: activePrompt,
            revised: input.response.result.revisedPrompt,
            maxInputChars,
            policyTruncated,
        },
        request: {
            textModel: input.request.textModel,
            imageModel: input.request.imageModel,
            quality: input.request.quality,
            size: input.request.size,
            aspectRatio: input.request.aspectRatio ?? 'auto',
            background: input.request.background,
            style: input.request.style,
            allowPromptAdjustment: input.request.allowPromptAdjustment,
            outputFormat: input.request.outputFormat,
            outputCompression: clampOutputCompression(
                input.request.outputCompression
            ),
        },
        linkage: {
            followUpResponseId: input.request.followUpResponseId ?? null,
        },
        result: {
            outputResponseId: responseId,
            finalStyle: input.response.result.finalStyle,
            generationTimeMs: input.response.result.generationTimeMs,
        },
        usage: {
            inputTokens: input.response.result.usage.inputTokens,
            outputTokens: input.response.result.usage.outputTokens,
            totalTokens: input.response.result.usage.totalTokens,
            imageCount: input.response.result.usage.imageCount,
        },
        costs: {
            text: input.response.result.costs.text,
            image: input.response.result.costs.image,
            total: input.response.result.costs.total,
            perImage: input.response.result.costs.perImage,
        },
    };

    const chainHash = createHash('sha256')
        .update(
            JSON.stringify({
                responseId,
                originalPrompt,
                activePrompt,
                imageModel: input.request.imageModel,
                textModel: input.request.textModel,
            })
        )
        .digest('hex')
        .slice(0, 16);

    return {
        responseId,
        provenance: DEFAULT_IMAGE_PROVENANCE,
        safetyTier: DEFAULT_IMAGE_SAFETY_TIER,
        tradeoffCount: 0,
        chainHash,
        licenseContext: DEFAULT_IMAGE_LICENSE_CONTEXT,
        modelVersion: input.response.result.imageModel,
        staleAfter: new Date(now + IMAGE_TRACE_RETENTION_MS).toISOString(),
        totalDurationMs: input.response.result.generationTimeMs,
        citations: [],
        trace_target: {},
        trace_final: {},
        execution: [
            {
                kind: 'generation',
                status: 'executed',
                provider: 'openai',
                model: input.response.result.imageModel,
                durationMs: input.response.result.generationTimeMs,
            },
        ],
        imageGeneration,
    };
};
