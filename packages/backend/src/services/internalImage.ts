/**
 * @description: Runs the trusted internal image task through the shared backend image runtime.
 * @footnote-scope: core
 * @footnote-module: InternalImageTaskService
 * @footnote-risk: high - Invalid task wiring here can break image generation or return malformed artifacts to trusted callers.
 * @footnote-ethics: medium - Backend-owned image execution affects cost visibility and image-generation transparency.
 */
import type {
    ImageGenerationPartialImage,
    ImageGenerationRuntime,
    ImageGenerationResult,
} from '@footnote/agent-runtime';
import type {
    InternalImagePartialImageEvent,
    PostInternalImageGenerateRequest,
    PostInternalImageGenerateResponse,
} from '@footnote/contracts/web';
import { PostInternalImageGenerateResponseSchema } from '@footnote/contracts/web/schemas';
import {
    recordBackendLLMUsage,
    type BackendLLMCostRecord,
} from './llmCostRecorder.js';
import { composeImagePrompts } from './prompts/imagePromptComposer.js';

export type CreateInternalImageTaskServiceOptions = {
    imageGenerationRuntime: ImageGenerationRuntime;
    recordUsage?: (record: BackendLLMCostRecord) => void;
};

export type RunInternalImageTaskOptions = {
    onPartialImage?: (
        payload: InternalImagePartialImageEvent
    ) => Promise<void> | void;
};

export type InternalImageTaskService = {
    runImageTask(
        request: PostInternalImageGenerateRequest,
        options?: RunInternalImageTaskOptions
    ): Promise<PostInternalImageGenerateResponse>;
};

const toInternalImageResponse = (
    result: ImageGenerationResult
): PostInternalImageGenerateResponse => ({
    task: 'generate',
    result: {
        responseId: result.responseId,
        textModel:
            result.textModel as PostInternalImageGenerateResponse['result']['textModel'],
        imageModel:
            result.imageModel as PostInternalImageGenerateResponse['result']['imageModel'],
        revisedPrompt: result.revisedPrompt,
        finalStyle: result.finalStyle,
        annotations: result.annotations,
        finalImageBase64: result.finalImageBase64,
        outputFormat: result.outputFormat,
        outputCompression: result.outputCompression,
        usage: result.usage,
        costs: result.costs,
        generationTimeMs: result.generationTimeMs,
    },
});

export const createInternalImageTaskService = ({
    imageGenerationRuntime,
    recordUsage = recordBackendLLMUsage,
}: CreateInternalImageTaskServiceOptions): InternalImageTaskService => {
    const runImageTask = async (
        request: PostInternalImageGenerateRequest,
        options: RunInternalImageTaskOptions = {}
    ): Promise<PostInternalImageGenerateResponse> => {
        const { systemPrompt, developerPrompt } = composeImagePrompts({
            prompt: request.prompt,
            allowPromptAdjustment: request.allowPromptAdjustment,
            size: request.size,
            quality: request.quality,
            background: request.background,
            style: request.style,
            user: request.user,
        });

        const result = await imageGenerationRuntime.generateImage({
            prompt: request.prompt,
            systemPrompt,
            developerPrompt,
            textModel: request.textModel,
            imageModel: request.imageModel,
            quality: request.quality,
            size: request.size,
            background: request.background,
            style: request.style,
            allowPromptAdjustment: request.allowPromptAdjustment,
            outputFormat: request.outputFormat,
            outputCompression: request.outputCompression,
            followUpResponseId: request.followUpResponseId,
            stream: request.stream,
            onPartialImage: options.onPartialImage
                ? async (payload: ImageGenerationPartialImage) => {
                      await options.onPartialImage?.({
                          type: 'partial_image',
                          index: payload.index,
                          base64: payload.base64,
                      });
                  }
                : undefined,
        });

        recordUsage({
            feature: 'image',
            model: result.textModel,
            promptTokens: result.usage.inputTokens,
            completionTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            inputCostUsd: result.costs.text,
            outputCostUsd: result.costs.image,
            totalCostUsd: result.costs.total,
            timestamp: Date.now(),
        });

        const response = toInternalImageResponse(result);
        const parsed =
            PostInternalImageGenerateResponseSchema.safeParse(response);
        if (!parsed.success) {
            const firstIssue = parsed.error.issues[0];
            throw new Error(
                `Internal image task returned invalid artifact output: ${firstIssue?.path.join('.') ?? 'body'} ${firstIssue?.message ?? 'Invalid response'}`
            );
        }

        return parsed.data;
    };

    return {
        runImageTask,
    };
};
