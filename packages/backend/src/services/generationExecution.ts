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
import {
    buildLegacyOpenAiGenerateOptions,
    executeLegacyOpenAiGeneration,
    type LegacyOpenAiClient,
} from '@footnote/agent-runtime/legacyOpenAiRuntime';
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
 * options by delegating to the legacy runtime adapter mapping. This keeps the
 * canonical provider bridge in `@footnote/agent-runtime` while backend still
 * executes through the legacy OpenAI path.
 */
const buildGenerateResponseOptions = (
    request: GenerationRequest
): GenerateResponseOptions => buildLegacyOpenAiGenerateOptions(request);

/**
 * Thin backend compatibility wrapper over the legacy runtime adapter execution.
 * Backend still needs raw assistant metadata today, so this wrapper preserves
 * that value while delegating canonical request/result mapping to
 * `@footnote/agent-runtime`.
 */
const executeOpenAIGeneration = async ({
    openaiService,
    request,
}: ExecuteOpenAIGenerationInput): Promise<ExecuteOpenAIGenerationResult> => {
    const { generationResult, metadata } = await executeLegacyOpenAiGeneration({
        client: openaiService as LegacyOpenAiClient,
        request,
    });

    return {
        generationResult,
        assistantMetadata: metadata as OpenAIResponseMetadata,
    };
};

export {
    buildGenerateResponseOptions,
    executeOpenAIGeneration,
    type ExecuteOpenAIGenerationInput,
    type ExecuteOpenAIGenerationResult,
};
