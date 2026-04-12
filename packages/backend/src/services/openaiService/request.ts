/**
 * @description: Provider-facing OpenAI Responses API request execution for chat
 * generation, with bounded retries and timeout/abort handling.
 * @footnote-scope: utility
 * @footnote-module: OpenAIServiceRequest
 * @footnote-risk: high - Request/response handling bugs can break backend generation reliability.
 * @footnote-ethics: medium - Request execution errors can indirectly degrade provenance quality.
 */

import type { RuntimeMessage } from '@footnote/agent-runtime';
import { runtimeConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { buildWebSearchInstruction } from '../chatGenerationHints.js';
import {
    extractCitationsFromOutputItems,
    extractMarkdownLinkCitations,
    hasWebSearchCallInOutputItems,
} from './citations.js';
import type {
    GenerateResponseOptions,
    GenerateResponseResult,
    OpenAIResponseMetadata,
    OpenAIService,
    ResponsesApiInputMessage,
    ResponsesApiResponseData,
    ResponsesApiTool,
} from './types.js';

// Owns: provider request shape normalization, request lifecycle, and raw response extraction.
// Does not own: response metadata assembly policy or orchestration/workflow decisions.

type GenerateResponseInternalOptions = GenerateResponseOptions & {
    signal?: AbortSignal;
};

/**
 * Maps planner reasoning effort to a valid Responses API setting.
 */
const normalizeReasoningEffort = (
    value: GenerateResponseOptions['reasoningEffort']
): NonNullable<GenerateResponseOptions['reasoningEffort']> => {
    if (value === 'minimal') {
        return 'low';
    }

    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

/**
 * Maps planner verbosity to a valid Responses API setting.
 */
const normalizeVerbosity = (
    value: GenerateResponseOptions['verbosity']
): NonNullable<GenerateResponseOptions['verbosity']> => {
    if (value === 'low' || value === 'medium' || value === 'high') {
        return value;
    }

    return 'low';
};

/**
 * Converts internal role/content messages into Responses API input messages.
 */
const buildInputMessage = (
    role: string,
    text: string
): ResponsesApiInputMessage => ({
    role,
    type: 'message',
    content: role === 'assistant' ? text : [{ type: 'input_text', text }],
});

type RequestAbortContext = {
    signal: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
};

/**
 * Merges the backend timeout budget with an optional caller cancellation signal.
 */
const createRequestAbortContext = (
    timeoutMs: number,
    externalSignal?: AbortSignal
): RequestAbortContext => {
    const controller = new AbortController();
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    const handleExternalAbort = (): void => {
        controller.abort();
    };

    if (externalSignal) {
        if (externalSignal.aborted) {
            handleExternalAbort();
        } else {
            externalSignal.addEventListener('abort', handleExternalAbort, {
                once: true,
            });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutHandle);
            if (externalSignal) {
                externalSignal.removeEventListener(
                    'abort',
                    handleExternalAbort
                );
            }
        },
        didTimeout: () => timedOut,
    };
};

class SimpleOpenAIService implements OpenAIService {
    private readonly apiKey: string;
    private readonly requestTimeoutMs: number;
    private readonly retryAttempts: number;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        this.requestTimeoutMs = runtimeConfig.openai.requestTimeoutMs;
        this.retryAttempts = 1;
    }

    async generateResponse(
        model: string,
        messages: RuntimeMessage[],
        options: GenerateResponseInternalOptions = {}
    ): Promise<GenerateResponseResult> {
        const validMessages = messages.filter((message) => {
            if (!message.content || !message.content.trim()) {
                logger.warn('Filtering out invalid backend chat message', {
                    role: message.role,
                    reason: 'empty_content',
                });
                return false;
            }

            return true;
        });

        const normalizedReasoningEffort = normalizeReasoningEffort(
            options.reasoningEffort
        );
        const normalizedVerbosity = normalizeVerbosity(options.verbosity);
        const hasSearchRequest =
            typeof options.search?.query === 'string' &&
            options.search.query.trim().length > 0;

        if (options.search && !hasSearchRequest) {
            logger.warn('Backend chat requested search without usable query', {
                searchProvided: options.search !== undefined,
                queryLength:
                    typeof options.search?.query === 'string'
                        ? options.search.query.length
                        : 0,
                reason: 'empty_query',
            });
        }

        const tools: ResponsesApiTool[] = [];
        if (hasSearchRequest && options.search) {
            tools.push({
                type: 'web_search',
                search_context_size: options.search.contextSize,
            });
        }

        const requestInput: ResponsesApiInputMessage[] = [
            ...validMessages.map((message) =>
                buildInputMessage(message.role, message.content)
            ),
            ...(hasSearchRequest && options.search
                ? [
                      buildInputMessage(
                          'system',
                          buildWebSearchInstruction({
                              ...options.search,
                              repoHints: options.search.repoHints ?? [],
                          })
                      ),
                  ]
                : []),
        ];

        const requestBody = JSON.stringify({
            model,
            input: requestInput,
            max_output_tokens: options.maxOutputTokens ?? 4000,
            reasoning: { effort: normalizedReasoningEffort },
            text: { verbosity: normalizedVerbosity },
            ...(tools.length > 0 && { tools }),
        });

        const performRequest = async (attempt: number): Promise<Response> => {
            const abortContext = createRequestAbortContext(
                this.requestTimeoutMs,
                options.signal
            );

            try {
                return await fetch('https://api.openai.com/v1/responses', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: requestBody,
                    signal: abortContext.signal,
                });
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    if (abortContext.didTimeout()) {
                        throw new Error(
                            `OpenAI request timed out after ${this.requestTimeoutMs}ms`,
                            { cause: error }
                        );
                    }

                    throw new Error('OpenAI request was aborted by caller', {
                        cause: error,
                    });
                }

                if (attempt < this.retryAttempts) {
                    const backoffMs = 300 * (attempt + 1);
                    await new Promise((resolve) =>
                        setTimeout(resolve, backoffMs)
                    );
                    return performRequest(attempt + 1);
                }

                throw error;
            } finally {
                abortContext.cleanup();
            }
        };

        let response = await performRequest(0);
        let retryCount = 0;
        while (
            !response.ok &&
            response.status >= 500 &&
            retryCount < this.retryAttempts
        ) {
            const backoffMs = 300 * (retryCount + 1);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            retryCount += 1;
            response = await performRequest(retryCount);
        }

        if (!response.ok) {
            const requestId =
                response.headers.get('x-request-id') ??
                response.headers.get('request-id') ??
                undefined;
            logger.error('OpenAI API request failed.', {
                status: response.status,
                statusText: response.statusText,
                ...(requestId !== undefined && { requestId }),
            });
            throw new Error(
                `OpenAI API error: ${response.status} ${response.statusText}`
            );
        }

        const data = (await response.json()) as ResponsesApiResponseData;

        const outputItems = data.output ?? [];
        let rawOutputText = '';
        let finishReason: string | undefined;

        for (const item of outputItems) {
            if (
                item.type === 'message' &&
                item.role === 'assistant' &&
                Array.isArray(item.content)
            ) {
                const textSegments = item.content
                    .filter(
                        (contentItem) =>
                            contentItem.type === 'output_text' &&
                            typeof contentItem.text === 'string'
                    )
                    .map((contentItem) => contentItem.text ?? '');
                if (textSegments.length > 0) {
                    rawOutputText += textSegments.join('');
                }
                if (typeof item.finish_reason === 'string') {
                    finishReason = item.finish_reason;
                }
            }
        }

        if (!rawOutputText && typeof data.output_text === 'string') {
            rawOutputText = data.output_text;
        }

        // User-facing reply body is model text only; metadata is produced out-of-band.
        const normalizedText = rawOutputText.trimEnd();
        const hasWebSearchCall = hasWebSearchCallInOutputItems(outputItems);
        const citationsFromAnnotations =
            extractCitationsFromOutputItems(outputItems);
        const citations =
            citationsFromAnnotations.length === 0 &&
            hasWebSearchCall &&
            normalizedText.length > 0
                ? extractMarkdownLinkCitations(normalizedText)
                : citationsFromAnnotations;

        const assistantMetadata: OpenAIResponseMetadata = {
            model: data.model ?? model,
            usage: {
                prompt_tokens: data.usage?.input_tokens,
                completion_tokens: data.usage?.output_tokens,
                total_tokens:
                    data.usage?.total_tokens ??
                    (data.usage?.input_tokens ?? 0) +
                        (data.usage?.output_tokens ?? 0),
            },
            finishReason,
            reasoningEffort: normalizedReasoningEffort,
            verbosity: normalizedVerbosity,
            provenance:
                citations.length > 0 || hasWebSearchCall
                    ? 'Retrieved'
                    : 'Inferred',
            citations,
        };

        return {
            normalizedText,
            metadata: assistantMetadata,
        };
    }
}

export { SimpleOpenAIService };
