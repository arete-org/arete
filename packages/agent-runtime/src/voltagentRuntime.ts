/**
 * @description: VoltAgent-backed generation runtime used to prove the shared runtime seam can host a second implementation.
 * @footnote-scope: core
 * @footnote-module: VoltAgentRuntime
 * @footnote-risk: high - Incorrect request mapping or fallback behavior here can silently change model selection, retrieval handling, or usage facts.
 * @footnote-ethics: high - This adapter must preserve Footnote's sourcing and transparency expectations even before VoltAgent becomes the active backend runtime.
 */
import { Agent, type BaseMessage } from '@voltagent/core';
import type {
    GenerationRequest,
    GenerationResult,
    GenerationRuntime,
    GenerationUsage,
    RuntimeMessage,
} from './index.js';

type VoltAgentOpenAiProviderOptions = {
    reasoningEffort?: 'low' | 'medium' | 'high';
    textVerbosity?: 'low' | 'medium' | 'high';
};

/**
 * Provider-specific OpenAI options passed through VoltAgent.
 *
 * The runtime seam stays provider-agnostic, but VoltAgent still needs a small
 * OpenAI-specific option bag for the current text-only MVP.
 */
export type VoltAgentProviderOptions = Record<string, unknown> & {
    openai?: VoltAgentOpenAiProviderOptions;
};

/**
 * Narrow execution options the VoltAgent adapter passes into one text call.
 */
export interface VoltAgentGenerateTextOptions {
    maxOutputTokens?: number;
    providerOptions?: VoltAgentProviderOptions;
    signal?: AbortSignal;
}

/**
 * Narrow usage shape the VoltAgent adapter needs from one text call.
 */
export interface VoltAgentUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/**
 * Narrow response metadata the VoltAgent adapter needs from one text call.
 */
export interface VoltAgentResponseMetadata {
    modelId?: string;
}

/**
 * Narrow text result shape exposed by the VoltAgent executor wrapper.
 */
export interface VoltAgentTextResult {
    text: string;
    finishReason?: string;
    usage?: VoltAgentUsage;
    response?: VoltAgentResponseMetadata;
}

/**
 * Small executor contract that keeps the adapter testable without depending on
 * VoltAgent internals in unit tests.
 */
export interface VoltAgentTextExecutor {
    generateText(
        messages: RuntimeMessage[],
        options: VoltAgentGenerateTextOptions
    ): Promise<VoltAgentTextResult>;
}

/**
 * Factory used to create one VoltAgent executor for a chosen model.
 */
export type VoltAgentExecutorFactory = (input: {
    model: string;
}) => VoltAgentTextExecutor;

/**
 * Constructor input for the VoltAgent runtime implementation.
 */
export interface CreateVoltAgentRuntimeOptions {
    fallbackRuntime: GenerationRuntime;
    defaultModel?: string;
    createExecutor?: VoltAgentExecutorFactory;
    kind?: string;
}

type VoltAgentCallOptions = NonNullable<Parameters<Agent['generateText']>[1]>;

/**
 * Turns the shared runtime transcript into the simple message shape VoltAgent
 * accepts for text generation.
 */
const toVoltAgentMessages = (messages: RuntimeMessage[]): BaseMessage[] =>
    messages.map((message) => ({
        role: message.role,
        content: message.content,
    }));

/**
 * VoltAgent's model router expects provider-prefixed model ids.
 */
const toVoltAgentModel = (model: string): string =>
    model.includes('/') ? model : `openai/${model}`;

/**
 * Footnote still expects the plain model id in normalized runtime results.
 */
const toFootnoteModel = (model: string): string => {
    const slashIndex = model.indexOf('/');
    return slashIndex === -1 ? model : model.slice(slashIndex + 1);
};

/**
 * Keeps the current reasoning semantics aligned with the legacy runtime path.
 */
const normalizeVoltAgentReasoningEffort = (
    value: GenerationRequest['reasoningEffort']
): VoltAgentOpenAiProviderOptions['reasoningEffort'] => {
    if (value === 'minimal') {
        return 'low';
    }

    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return undefined;
};

/**
 * Builds the provider option bag for one VoltAgent text call.
 */
const buildVoltAgentProviderOptions = (
    request: GenerationRequest
): VoltAgentProviderOptions | undefined => {
    const reasoningEffort = normalizeVoltAgentReasoningEffort(
        request.reasoningEffort
    );
    const textVerbosity = request.verbosity;

    if (!reasoningEffort && !textVerbosity) {
        return undefined;
    }

    return {
        openai: {
            ...(reasoningEffort !== undefined && { reasoningEffort }),
            ...(textVerbosity !== undefined && { textVerbosity }),
        },
    };
};

/**
 * Converts the executor result into the shared generation result shape.
 */
const normalizeVoltAgentResult = (
    executedModel: string,
    result: VoltAgentTextResult
): GenerationResult => {
    const responseModel = result.response?.modelId ?? executedModel;
    const usage: GenerationUsage | undefined = result.usage
        ? {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              totalTokens: result.usage.totalTokens,
          }
        : undefined;

    return {
        text: result.text,
        model: toFootnoteModel(responseModel),
        finishReason: result.finishReason,
        usage,
        citations: [],
        retrieval: {
            requested: false,
            used: false,
        },
        provenance: 'Inferred',
    };
};

/**
 * Default executor factory backed by a real VoltAgent `Agent`.
 *
 * This stays intentionally narrow: no memory, no server, and no extra runtime
 * wiring yet. The adapter only needs plain text generation for now.
 */
const createDefaultVoltAgentExecutor: VoltAgentExecutorFactory = ({
    model,
}) => {
    const agent = new Agent({
        name: 'footnote-generation-runtime',
        instructions:
            'Continue the provided conversation transcript and follow any system messages included in it.',
        model,
        memory: false,
    });

    return {
        async generateText(
            messages: RuntimeMessage[],
            options: VoltAgentGenerateTextOptions
        ): Promise<VoltAgentTextResult> {
            const callOptions: VoltAgentCallOptions = {
                ...(options.maxOutputTokens !== undefined && {
                    maxOutputTokens: options.maxOutputTokens,
                }),
                ...(options.providerOptions !== undefined && {
                    providerOptions:
                        options.providerOptions as VoltAgentCallOptions['providerOptions'],
                }),
                ...(options.signal !== undefined && {
                    signal: options.signal,
                }),
            };
            const result = await agent.generateText(
                toVoltAgentMessages(messages),
                callOptions
            );

            return {
                text: result.text,
                finishReason: result.finishReason,
                usage: {
                    promptTokens: result.usage.inputTokens,
                    completionTokens: result.usage.outputTokens,
                    totalTokens: result.usage.totalTokens,
                },
                response: {
                    modelId: result.response.modelId,
                },
            };
        },
    };
};

/**
 * Creates the VoltAgent-backed runtime implementation.
 *
 * Search requests deliberately fall back to another runtime for now so this
 * step can prove the second implementation without taking on retrieval parity
 * work at the same time.
 */
const createVoltAgentRuntime = ({
    fallbackRuntime,
    defaultModel,
    createExecutor = createDefaultVoltAgentExecutor,
    kind = 'voltagent',
}: CreateVoltAgentRuntimeOptions): GenerationRuntime => ({
    kind,
    async generate(request: GenerationRequest): Promise<GenerationResult> {
        if (request.search !== undefined) {
            return fallbackRuntime.generate(request);
        }

        const selectedModel = request.model ?? defaultModel;
        if (!selectedModel) {
            throw new Error(
                'VoltAgent runtime requires request.model or a configured defaultModel.'
            );
        }

        const executedModel = toVoltAgentModel(selectedModel);
        const executor = createExecutor({ model: executedModel });
        const providerOptions = buildVoltAgentProviderOptions(request);
        const result = await executor.generateText(request.messages, {
            ...(request.maxOutputTokens !== undefined && {
                maxOutputTokens: request.maxOutputTokens,
            }),
            ...(request.signal !== undefined && { signal: request.signal }),
            ...(providerOptions !== undefined && { providerOptions }),
        });

        return normalizeVoltAgentResult(executedModel, result);
    },
});

export {
    buildVoltAgentProviderOptions,
    createDefaultVoltAgentExecutor,
    createVoltAgentRuntime,
    normalizeVoltAgentReasoningEffort,
    normalizeVoltAgentResult,
    toFootnoteModel,
    toVoltAgentMessages,
    toVoltAgentModel,
};
