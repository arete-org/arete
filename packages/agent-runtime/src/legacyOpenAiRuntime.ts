/**
 * @description: Legacy OpenAI-backed generation runtime used during the runtime-seam migration.
 * @footnote-scope: core
 * @footnote-module: LegacyOpenAiRuntime
 * @footnote-risk: high - Incorrect request or result mapping here can silently change retrieval, usage, or provenance behavior.
 * @footnote-ethics: high - This adapter preserves the execution facts Footnote uses to explain sourcing and cost while the backend still relies on the legacy provider path.
 */
import type {
    GenerationCitation,
    GenerationProvenance,
    GenerationRequest,
    GenerationResult,
    GenerationRuntime,
    RuntimeMessage,
} from './index.js';

/**
 * Narrow usage payload exposed by the legacy OpenAI-backed client.
 */
export interface LegacyOpenAiUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

/**
 * Provider-facing execution options consumed by the legacy OpenAI-backed client.
 */
export type LegacyOpenAiGenerateOptions = Pick<
    GenerationRequest,
    'maxOutputTokens' | 'reasoningEffort' | 'verbosity' | 'search' | 'signal'
>;

/**
 * Provider metadata the legacy adapter needs in order to normalize a
 * `GenerationResult` while preserving backend compatibility.
 */
export interface LegacyOpenAiMetadata {
    model: string;
    usage?: LegacyOpenAiUsage;
    finishReason?: string;
    provenance?: GenerationProvenance;
    citations?: GenerationCitation[];
}

/**
 * Raw result shape returned by the legacy OpenAI-backed client.
 */
export interface LegacyOpenAiResult {
    normalizedText: string;
    metadata: LegacyOpenAiMetadata;
}

/**
 * Minimal provider contract the legacy adapter needs from an OpenAI-backed
 * client. This stays local to `agent-runtime` so backend-specific types do not
 * leak into the shared runtime seam.
 */
export interface LegacyOpenAiClient {
    generateResponse(
        model: string,
        messages: RuntimeMessage[],
        options?: LegacyOpenAiGenerateOptions
    ): Promise<LegacyOpenAiResult>;
}

type ExecuteLegacyOpenAiGenerationInput = {
    client: LegacyOpenAiClient;
    request: GenerationRequest;
};

type ExecuteLegacyOpenAiGenerationResult = {
    generationResult: GenerationResult;
    metadata: LegacyOpenAiMetadata;
};

/**
 * Converts the canonical generation request into the option shape the legacy
 * OpenAI-backed client already understands.
 */
const buildLegacyOpenAiGenerateOptions = (
    request: GenerationRequest
): LegacyOpenAiGenerateOptions => ({
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
    ...(request.signal !== undefined && {
        signal: request.signal,
    }),
});

/**
 * Converts the raw legacy client result into the canonical `GenerationResult`
 * while keeping the original metadata available to callers that still depend on
 * provider-specific fields during the migration.
 */
const executeLegacyOpenAiGeneration = async ({
    client,
    request,
}: ExecuteLegacyOpenAiGenerationInput): Promise<ExecuteLegacyOpenAiGenerationResult> => {
    const requestedModel = request.model?.trim();
    if (!requestedModel) {
        throw new Error('Missing model for legacy request.');
    }

    const response = await client.generateResponse(
        requestedModel,
        request.messages,
        buildLegacyOpenAiGenerateOptions(request)
    );
    const metadata = response.metadata;
    const citations = metadata.citations ?? [];
    const requestedSearch = request.search !== undefined;
    const usedSearch = metadata.provenance === 'Retrieved';

    return {
        generationResult: {
            text: response.normalizedText,
            model: metadata.model || request.model,
            finishReason: metadata.finishReason,
            usage: metadata.usage
                ? {
                      promptTokens: metadata.usage.prompt_tokens,
                      completionTokens: metadata.usage.completion_tokens,
                      totalTokens: metadata.usage.total_tokens,
                  }
                : undefined,
            citations,
            retrieval: {
                requested: requestedSearch,
                used: usedSearch,
            },
            provenance: metadata.provenance,
        },
        metadata,
    };
};

/**
 * Creates the legacy OpenAI-backed runtime implementation that satisfies the
 * shared `GenerationRuntime` interface.
 */
const createLegacyOpenAiRuntime = ({
    client,
    kind = 'legacy-openai',
}: {
    client: LegacyOpenAiClient;
    kind?: string;
}): GenerationRuntime => ({
    kind,
    async generate(request: GenerationRequest): Promise<GenerationResult> {
        const { generationResult } = await executeLegacyOpenAiGeneration({
            client,
            request,
        });

        return generationResult;
    },
});

export {
    buildLegacyOpenAiGenerateOptions,
    createLegacyOpenAiRuntime,
    executeLegacyOpenAiGeneration,
    type ExecuteLegacyOpenAiGenerationInput,
    type ExecuteLegacyOpenAiGenerationResult,
};
