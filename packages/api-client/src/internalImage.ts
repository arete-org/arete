/**
 * @description: Trusted internal image-task endpoint methods for backend integration.
 * @footnote-scope: utility
 * @footnote-module: SharedInternalImageApi
 * @footnote-risk: medium - Transport mistakes can break backend-owned image tasks.
 * @footnote-ethics: medium - Narrow task transport keeps backend-owned image policy explicit.
 */
import type {
    InternalImageStreamEvent,
    PostInternalImageGenerateRequest,
    PostInternalImageGenerateResponse,
} from '@footnote/contracts/web';
import {
    InternalImageStreamEventSchema,
    PostInternalImageGenerateResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
import type { ApiRequester, CreateApiTransportOptions } from './client.js';

export type CreateInternalImageApiOptions = {
    traceApiToken?: string;
};

type CreateInternalImageApiFactoryOptions = CreateInternalImageApiOptions &
    CreateApiTransportOptions & {
        baseUrl: string;
    };

export type InternalImageApi = {
    runImageTaskViaApi: (
        request: PostInternalImageGenerateRequest,
        options?: { signal?: AbortSignal }
    ) => Promise<PostInternalImageGenerateResponse>;
    runImageTaskStreamViaApi: (
        request: PostInternalImageGenerateRequest,
        options?: {
            signal?: AbortSignal;
            onPartialImage?: (payload: {
                index: number;
                base64: string;
            }) => Promise<void> | void;
        }
    ) => Promise<PostInternalImageGenerateResponse>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STREAM_ITERATIONS = 10_000;
const MAX_STREAM_BYTES = 10 * 1024 * 1024;

const buildTrustedHeaders = (
    traceApiToken?: string
): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (traceApiToken) {
        headers['X-Trace-Token'] = traceApiToken;
    }
    return headers;
};

const normalizeBaseUrl = (baseUrl: string): string => {
    const trimmed = baseUrl.trim();
    let end = trimmed.length;
    while (end > 0 && trimmed.charCodeAt(end - 1) === 47) {
        end -= 1;
    }

    return trimmed.slice(0, end);
};

const buildUrl = (baseUrl: string, endpoint: string): string =>
    baseUrl ? `${baseUrl}${endpoint}` : endpoint;

const readErrorMessage = async (response: Response): Promise<string> => {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        const payload = (await response.json().catch(() => null)) as {
            error?: unknown;
            message?: unknown;
        } | null;
        if (typeof payload?.error === 'string') {
            return payload.error;
        }
        if (typeof payload?.message === 'string') {
            return payload.message;
        }
    }

    const text = await response.text().catch(() => '');
    return text || `Request failed with status ${response.status}`;
};

export const createInternalImageApi = (
    requestJson: ApiRequester,
    {
        traceApiToken,
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
        fetchImpl = fetch,
    }: CreateInternalImageApiFactoryOptions
): InternalImageApi => {
    const headers = buildTrustedHeaders(traceApiToken);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    /**
     * @api.operationId: postInternalImageTask
     * @api.path: POST /api/internal/image
     */
    const runImageTaskViaApi = async (
        request: PostInternalImageGenerateRequest,
        options?: { signal?: AbortSignal }
    ): Promise<PostInternalImageGenerateResponse> => {
        const response = await requestJson<PostInternalImageGenerateResponse>(
            '/api/internal/image',
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse: createSchemaResponseValidator(
                    PostInternalImageGenerateResponseSchema
                ),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: postInternalImageTask
     * @api.path: POST /api/internal/image
     */
    const runImageTaskStreamViaApi = async (
        request: PostInternalImageGenerateRequest,
        options?: {
            signal?: AbortSignal;
            onPartialImage?: (payload: {
                index: number;
                base64: string;
            }) => Promise<void> | void;
        }
    ): Promise<PostInternalImageGenerateResponse> => {
        const controller = new AbortController();
        const timeoutMs = Math.max(0, defaultTimeoutMs);
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const onExternalAbort = () => {
            controller.abort(options?.signal?.reason);
        };

        if (options?.signal) {
            if (options.signal.aborted) {
                controller.abort(options.signal.reason);
            } else {
                options.signal.addEventListener('abort', onExternalAbort, {
                    once: true,
                });
            }
        }

        if (timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                controller.abort('Request timeout');
            }, timeoutMs);
        }

        try {
            const response = await fetchImpl(
                buildUrl(normalizedBaseUrl, '/api/internal/image'),
                {
                    method: 'POST',
                    headers: {
                        ...defaultHeaders,
                        ...headers,
                        Accept: 'application/x-ndjson, application/json',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        ...request,
                        stream: true,
                    }),
                    signal: controller.signal,
                }
            );

            if (!response.ok) {
                throw new Error(await readErrorMessage(response));
            }

            if (!response.body) {
                throw new Error(
                    'Internal image stream response did not include a body.'
                );
            }

            const reader = response.body.getReader();
            const decoder = new globalThis.TextDecoder();
            let buffered = '';
            let finalResponse: PostInternalImageGenerateResponse | null = null;
            let streamIterations = 0;
            let streamBytesRead = 0;
            const processEventLine = async (line: string): Promise<boolean> => {
                const trimmed = line.trim();
                if (!trimmed) {
                    return false;
                }

                let parsedEvent: InternalImageStreamEvent;
                try {
                    parsedEvent = JSON.parse(
                        trimmed
                    ) as InternalImageStreamEvent;
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    throw new Error(
                        `Internal image stream payload was invalid: body Malformed JSON (${message})`,
                        { cause: error }
                    );
                }

                const parsed =
                    InternalImageStreamEventSchema.safeParse(parsedEvent);
                if (!parsed.success) {
                    const firstIssue = parsed.error.issues[0];
                    throw new Error(
                        `Internal image stream payload was invalid: ${firstIssue?.path.join('.') ?? 'body'} ${firstIssue?.message ?? 'Invalid event'}`
                    );
                }

                const event = parsed.data;
                if (event.type === 'partial_image') {
                    await options?.onPartialImage?.({
                        index: event.index,
                        base64: event.base64,
                    });
                    return false;
                }

                if (event.type === 'error') {
                    throw new Error(event.error);
                }

                finalResponse = {
                    task: event.task,
                    result: event.result,
                };
                return true;
            };

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    const chunk = value ?? new Uint8Array();
                    streamIterations += 1;
                    streamBytesRead += chunk.byteLength;

                    if (streamIterations > MAX_STREAM_ITERATIONS) {
                        await reader
                            .cancel(
                                'Internal image stream iteration limit exceeded'
                            )
                            .catch(() => undefined);
                        throw new Error(
                            `Internal image stream exceeded the iteration safety limit (${MAX_STREAM_ITERATIONS}).`
                        );
                    }
                    if (streamBytesRead > MAX_STREAM_BYTES) {
                        await reader
                            .cancel('Internal image stream byte limit exceeded')
                            .catch(() => undefined);
                        throw new Error(
                            `Internal image stream exceeded the byte safety limit (${MAX_STREAM_BYTES}).`
                        );
                    }

                    buffered += decoder.decode(chunk, {
                        stream: !done,
                    });

                    const lines = buffered.split('\n');
                    buffered = lines.pop() ?? '';
                    let reachedFinalResult = false;

                    for (const line of lines) {
                        const isTerminalResult = await processEventLine(line);
                        if (isTerminalResult) {
                            reachedFinalResult = true;
                            break;
                        }
                    }

                    if (done || reachedFinalResult) {
                        break;
                    }
                }
            } finally {
                reader.releaseLock();
            }

            if (!finalResponse && buffered.trim()) {
                await processEventLine(buffered);
            }

            if (!finalResponse) {
                throw new Error(
                    'Internal image stream ended without a final result.'
                );
            }

            const validation = createSchemaResponseValidator(
                PostInternalImageGenerateResponseSchema
            )(finalResponse);
            if (!validation.success) {
                throw new Error(validation.error);
            }

            return validation.data;
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            if (options?.signal) {
                options.signal.removeEventListener('abort', onExternalAbort);
            }
        }
    };

    return {
        runImageTaskViaApi,
        runImageTaskStreamViaApi,
    };
};
