/**
 * @description: VoltAgent-backed generation runtime used to prove the shared runtime seam can host a second implementation.
 * @footnote-scope: core
 * @footnote-module: VoltAgentRuntime
 * @footnote-risk: high - Incorrect request mapping or fallback behavior here can silently change model selection, retrieval handling, or usage facts.
 * @footnote-ethics: high - This adapter must preserve Footnote's sourcing and transparency expectations even before VoltAgent becomes the active backend runtime.
 */
import { Agent, type BaseMessage } from '@voltagent/core';
import type {
    GenerationCitation,
    GenerationRequest,
    GenerationResult,
    GenerationRuntime,
    GenerationSearchRequest,
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
    search?: GenerationSearchRequest;
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
    body?: unknown;
}

/**
 * Narrow text result shape exposed by the VoltAgent executor wrapper.
 */
export interface VoltAgentSource {
    url: string;
    title?: string;
}

type VoltAgentProviderTool = {
    type: 'provider';
    id: 'openai.web_search';
    name: 'web_search';
    args: {
        searchContextSize?: GenerationSearchRequest['contextSize'];
    };
};

export interface VoltAgentTextResult {
    text: string;
    finishReason?: string;
    usage?: VoltAgentUsage;
    response?: VoltAgentResponseMetadata;
    sources?: VoltAgentSource[];
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
type VoltAgentToolSet = NonNullable<VoltAgentCallOptions['tools']>;

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

const normalizeFallbackCitationTitle = (label: string): string => {
    const normalizedLabel = label.trim();

    return /^\d+$/.test(normalizedLabel) ? 'Source' : normalizedLabel;
};

const extractMarkdownLinkCitations = (text: string): GenerationCitation[] => {
    const citations: GenerationCitation[] = [];
    const seenUrls = new Set<string>();
    const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

    for (const match of text.matchAll(markdownLinkPattern)) {
        const rawLabel = match[1];
        const rawUrl = match[2];
        if (
            typeof rawLabel !== 'string' ||
            rawLabel.trim().length === 0 ||
            typeof rawUrl !== 'string'
        ) {
            continue;
        }

        let normalizedUrl: string;
        try {
            const parsedUrl = new URL(rawUrl);
            if (
                parsedUrl.protocol !== 'http:' &&
                parsedUrl.protocol !== 'https:'
            ) {
                continue;
            }
            normalizedUrl = parsedUrl.toString();
        } catch {
            continue;
        }

        if (seenUrls.has(normalizedUrl)) {
            continue;
        }

        seenUrls.add(normalizedUrl);
        citations.push({
            title: normalizeFallbackCitationTitle(rawLabel),
            url: normalizedUrl,
        });
    }

    return citations;
};

const buildRepoExplainerQuery = (search: GenerationSearchRequest): string => {
    const rawTerms = [
        'footnote-ai/footnote',
        'footnote-ai',
        'footnote',
        'DeepWiki',
        ...(search.repoHints ?? []),
        search.query.trim(),
    ];
    const seenTerms = new Set<string>();
    const dedupedTerms: string[] = [];

    for (const term of rawTerms) {
        const normalized = term.trim().toLowerCase();
        if (!normalized || seenTerms.has(normalized)) {
            continue;
        }

        seenTerms.add(normalized);
        dedupedTerms.push(term.trim());
    }

    return dedupedTerms.join(' ');
};

const buildVoltAgentSearchInstruction = (
    search: GenerationSearchRequest
): string => {
    if (search.intent === 'repo_explainer') {
        const repoQuery = buildRepoExplainerQuery(search);
        const hintText =
            (search.repoHints?.length ?? 0) > 0
                ? ` Focus areas: ${search.repoHints?.join(', ')}.`
                : '';

        return [
            'The planner marked this as a Footnote repository explanation lookup.',
            'Treat footnote-ai/footnote as the canonical repository identity for this search.',
            'Prefer DeepWiki results from https://deepwiki.com/footnote-ai/footnote when they are relevant.',
            'If DeepWiki coverage is thin, use broader web context instead of getting stuck.',
            `Search query: ${repoQuery}.${hintText}`.trim(),
            `Original planner query: ${search.query.trim()}.`,
        ].join(' ');
    }

    return `The planner instructed you to perform a web search for: ${search.query.trim()}`;
};

const createVoltAgentSearchTool = (
    search: GenerationSearchRequest
): VoltAgentProviderTool => ({
    type: 'provider',
    id: 'openai.web_search',
    name: 'web_search',
    args: {
        searchContextSize: search.contextSize,
    },
});

type VoltAgentResponseBody = {
    output?: Array<{
        type?: string;
    }>;
};

const hasWebSearchCallInResponseBody = (body: unknown): boolean => {
    if (!body || typeof body !== 'object') {
        return false;
    }

    const outputItems = (body as VoltAgentResponseBody).output;
    return (
        Array.isArray(outputItems) &&
        outputItems.some((item) => item?.type === 'web_search_call')
    );
};

const extractCitationsFromSources = (
    sources: VoltAgentSource[] | undefined
): GenerationCitation[] => {
    if (!Array.isArray(sources) || sources.length === 0) {
        return [];
    }

    const citations: GenerationCitation[] = [];
    const seenUrls = new Set<string>();

    for (const source of sources) {
        if (!source || typeof source.url !== 'string') {
            continue;
        }

        let normalizedUrl: string;
        try {
            const parsedUrl = new URL(source.url);
            if (
                parsedUrl.protocol !== 'http:' &&
                parsedUrl.protocol !== 'https:'
            ) {
                continue;
            }
            normalizedUrl = parsedUrl.toString();
        } catch {
            continue;
        }

        if (seenUrls.has(normalizedUrl)) {
            continue;
        }

        seenUrls.add(normalizedUrl);
        citations.push({
            title:
                typeof source.title === 'string' && source.title.trim()
                    ? source.title.trim()
                    : 'Source',
            url: normalizedUrl,
        });
    }

    return citations;
};

/**
 * Converts the executor result into the shared generation result shape.
 */
const normalizeVoltAgentResult = (
    executedModel: string,
    request: GenerationRequest,
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
    const hasSearchRequest = request.search !== undefined;
    const hasWebSearchCall = hasWebSearchCallInResponseBody(result.response?.body);
    const citationsFromSources = extractCitationsFromSources(result.sources);
    const citations =
        citationsFromSources.length === 0 &&
        hasWebSearchCall &&
        result.text.trim().length > 0
            ? extractMarkdownLinkCitations(result.text)
            : citationsFromSources;
    const retrievalUsed =
        hasSearchRequest && (hasWebSearchCall || citations.length > 0);

    return {
        text: result.text,
        model: toFootnoteModel(responseModel),
        finishReason: result.finishReason,
        usage,
        citations,
        retrieval: {
            requested: hasSearchRequest,
            used: retrievalUsed,
        },
        provenance: retrievalUsed ? 'Retrieved' : 'Inferred',
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
            const runtimeMessages = options.search
                ? [
                      ...messages,
                      {
                          role: 'system' as const,
                          content: buildVoltAgentSearchInstruction(
                              options.search
                          ),
                      },
                  ]
                : messages;
            const searchTools =
                options.search !== undefined
                    ? ([createVoltAgentSearchTool(options.search)] as unknown as VoltAgentToolSet)
                    : undefined;
            const callOptions: VoltAgentCallOptions = {
                ...(options.maxOutputTokens !== undefined && {
                    maxOutputTokens: options.maxOutputTokens,
                }),
                ...(options.providerOptions !== undefined && {
                    providerOptions:
                        options.providerOptions as VoltAgentCallOptions['providerOptions'],
                }),
                ...(searchTools !== undefined && {
                    tools: searchTools,
                    toolChoice: 'required' as VoltAgentCallOptions['toolChoice'],
                }),
                ...(options.signal !== undefined && {
                    signal: options.signal,
                }),
            };
            const result = await agent.generateText(
                toVoltAgentMessages(runtimeMessages),
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
                    body: result.response.body,
                },
                sources:
                    result.sources
                        ?.filter(
                            (
                                source
                            ): source is typeof source & {
                                sourceType: 'url';
                                url: string;
                            } =>
                                source.type === 'source' &&
                                source.sourceType === 'url'
                        )
                        .map((source) => ({
                            url: source.url,
                            title: source.title,
                        })) ?? [],
            };
        },
    };
};

/**
 * Creates the VoltAgent-backed runtime implementation.
 */
const createVoltAgentRuntime = ({
    fallbackRuntime: _fallbackRuntime,
    defaultModel,
    createExecutor = createDefaultVoltAgentExecutor,
    kind = 'voltagent',
}: CreateVoltAgentRuntimeOptions): GenerationRuntime => ({
    kind,
    async generate(request: GenerationRequest): Promise<GenerationResult> {
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
            ...(request.search !== undefined && {
                search: request.search,
            }),
            ...(request.signal !== undefined && { signal: request.signal }),
            ...(providerOptions !== undefined && { providerOptions }),
        });

        return normalizeVoltAgentResult(executedModel, request, result);
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
