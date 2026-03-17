/**
 * @description: Temporary backend-side bridge from the generic generation seam to the current OpenAI execution path.
 * @footnote-scope: core
 * @footnote-module: GenerationExecutionBridge
 * @footnote-risk: high - Incorrect request or result mapping here can silently change retrieval behavior, usage accounting, or provenance signals.
 * @footnote-ethics: high - This bridge shapes the facts backend uses to explain sourcing and cost, so drift can mislead users.
 */
import type {
    GenerationRequest,
    GenerationResult,
} from '@footnote/agent-runtime';
import type {
    GenerateResponseOptions,
    OpenAIResponseMetadata,
    OpenAIService,
} from './openaiService.js';

type ExecuteOpenAIGenerationInput = {
    openaiService: OpenAIService;
    request: GenerationRequest;
};

type ExecuteOpenAIGenerationResult = {
    generationResult: GenerationResult;
    assistantMetadata: OpenAIResponseMetadata;
};

/**
 * Converts the canonical generation request into the current OpenAI wrapper
 * options. This keeps provider-shaped request details out of Reflect service
 * code while the backend still executes through the OpenAI path.
 */
const buildGenerateResponseOptions = (
    request: GenerationRequest
): GenerateResponseOptions => ({
    ...(request.maxOutputTokens !== undefined && {
        maxOutputTokens: request.maxOutputTokens,
    }),
    ...(request.reasoningEffort !== undefined && {
        reasoningEffort: request.reasoningEffort,
    }),
    ...(request.verbosity !== undefined && {
        verbosity: request.verbosity,
    }),
    ...(request.search !== undefined && {
        search: request.search,
    }),
    ...(request.signal !== undefined && { signal: request.signal }),
});

/**
 * Normalizes OpenAI wrapper output into the generic generation result shape
 * while preserving the raw assistant metadata that backend still needs for
 * response metadata assembly and cost tracking.
 */
const executeOpenAIGeneration = async ({
    openaiService,
    request,
}: ExecuteOpenAIGenerationInput): Promise<ExecuteOpenAIGenerationResult> => {
    const response = await openaiService.generateResponse(
        request.model ?? '',
        request.messages,
        buildGenerateResponseOptions(request)
    );
    const assistantMetadata = response.metadata;
    const citations = assistantMetadata.citations ?? [];
    const requestedSearch = request.search !== undefined;
    const usedSearch = assistantMetadata.provenance === 'Retrieved';

    return {
        generationResult: {
            text: response.normalizedText,
            model: assistantMetadata.model || request.model,
            finishReason: assistantMetadata.finishReason,
            usage: assistantMetadata.usage
                ? {
                      promptTokens: assistantMetadata.usage.prompt_tokens,
                      completionTokens:
                          assistantMetadata.usage.completion_tokens,
                      totalTokens: assistantMetadata.usage.total_tokens,
                  }
                : undefined,
            citations,
            retrieval: {
                requested: requestedSearch,
                used: usedSearch,
            },
            provenance: assistantMetadata.provenance,
        },
        assistantMetadata,
    };
};

export {
    buildGenerateResponseOptions,
    executeOpenAIGeneration,
    type ExecuteOpenAIGenerationInput,
    type ExecuteOpenAIGenerationResult,
};
