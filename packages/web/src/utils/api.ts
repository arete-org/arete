/**
 * @description: Provides a package-local API client for web routes with shared transport and error parsing.
 * @arete-scope: utility
 * @arete-module: WebApiClient
 * @arete-risk: moderate - Incorrect request handling can break chat/blog/trace experiences.
 * @arete-ethics: moderate - Consistent error handling helps keep fallback behavior transparent.
 */

import type {
    ApiErrorResponse,
    BlogIndexResponse,
    BlogPostResponse,
    NormalizedApiError,
    ReflectRequest,
    ReflectResponse,
    RuntimeConfigResponse,
    TraceResponse,
    TraceStaleResponse,
} from '@arete/contracts/web';

type ApiClientError = Error & NormalizedApiError;

type ApiRequestCacheMode =
    | 'default'
    | 'no-store'
    | 'reload'
    | 'no-cache'
    | 'force-cache'
    | 'only-if-cached';

type ApiRequestOptions = {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
    cache?: ApiRequestCacheMode;
    acceptedStatusCodes?: readonly number[];
};

type ApiJsonResult<T> = {
    status: number;
    data: T;
};

type CreateWebApiClientOptions = {
    baseUrl?: string;
    defaultHeaders?: Record<string, string>;
    defaultTimeoutMs?: number;
    fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 60_000;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const normalizeBaseUrl = (baseUrl?: string): string => {
    const trimmed = baseUrl?.trim();
    if (!trimmed) {
        return '';
    }
    return trimmed.replace(/\/+$/, '');
};

const buildUrl = (baseUrl: string, endpoint: string): string => {
    if (!endpoint.startsWith('/')) {
        throw new Error(
            `API endpoint "${endpoint}" must start with "/" for predictable routing.`
        );
    }

    return baseUrl ? `${baseUrl}${endpoint}` : endpoint;
};

const createApiClientError = (
    payload: NormalizedApiError
): ApiClientError => {
    const error = new Error(payload.message) as ApiClientError;
    error.name = 'ApiClientError';
    error.status = payload.status;
    error.code = payload.code;
    error.details = payload.details;
    error.retryAfter = payload.retryAfter;
    error.endpoint = payload.endpoint;
    error.raw = payload.raw;
    return error;
};

const normalizeErrorCode = (status: number | null): string => {
    if (status === null) return 'network_error';
    if (status === 400) return 'bad_request';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not_found';
    if (status === 408) return 'timeout_error';
    if (status === 409) return 'conflict';
    if (status === 410) return 'stale_resource';
    if (status === 413) return 'payload_too_large';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'api_error';
};

const parseApiErrorEnvelope = (
    payload: unknown
): {
    message?: string;
    details?: string;
    retryAfter?: number;
} => {
    if (!isObjectRecord(payload)) {
        return {};
    }

    const message =
        typeof payload.error === 'string'
            ? payload.error
            : typeof payload.message === 'string'
              ? payload.message
              : undefined;

    const details =
        typeof payload.details === 'string' ? payload.details : undefined;

    const retryAfter =
        typeof payload.retryAfter === 'number' &&
        Number.isFinite(payload.retryAfter)
            ? payload.retryAfter
            : undefined;

    return { message, details, retryAfter };
};

const toJsonBody = (body: unknown): string => {
    if (typeof body === 'string') {
        return body;
    }
    return JSON.stringify(body);
};

const readResponsePayload = async (response: Response): Promise<unknown> => {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
        return response.json().catch(() => null);
    }

    const text = await response.text().catch(() => '');
    return text.length > 0 ? text : null;
};

export const isApiClientError = (value: unknown): value is ApiClientError =>
    value instanceof Error &&
    (value as Partial<ApiClientError>).name === 'ApiClientError';

export const createWebApiClient = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
}: CreateWebApiClientOptions = {}) => {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    const requestJson = async <T>(
        endpoint: string,
        {
            method = 'GET',
            headers,
            body,
            signal,
            timeoutMs = defaultTimeoutMs,
            cache,
            acceptedStatusCodes = [],
        }: ApiRequestOptions = {}
    ): Promise<ApiJsonResult<T>> => {
        const url = buildUrl(normalizedBaseUrl, endpoint);
        const controller = new AbortController();
        const timeout = Math.max(0, timeoutMs);

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const onExternalAbort = () => {
            controller.abort(signal?.reason);
        };

        if (signal) {
            if (signal.aborted) {
                controller.abort(signal.reason);
            } else {
                signal.addEventListener('abort', onExternalAbort, {
                    once: true,
                });
            }
        }

        if (timeout > 0) {
            timeoutId = setTimeout(() => {
                controller.abort('Request timeout');
            }, timeout);
        }

        const requestHeaders: Record<string, string> = {
            Accept: 'application/json',
            ...defaultHeaders,
            ...headers,
        };

        if (body !== undefined && requestHeaders['Content-Type'] === undefined) {
            requestHeaders['Content-Type'] = 'application/json';
        }

        try {
            const response = await fetchImpl(url, {
                method,
                headers: requestHeaders,
                body: body === undefined ? undefined : toJsonBody(body),
                signal: controller.signal,
                ...(cache ? { cache } : {}),
            });

            const payload = await readResponsePayload(response);
            const isAcceptedStatus = acceptedStatusCodes.includes(
                response.status
            );

            if (!response.ok && !isAcceptedStatus) {
                const parsed = parseApiErrorEnvelope(payload);
                throw createApiClientError({
                    status: response.status,
                    code: normalizeErrorCode(response.status),
                    message:
                        parsed.message ??
                        `Request failed with status ${response.status}`,
                    details: parsed.details,
                    retryAfter: parsed.retryAfter,
                    endpoint,
                    raw: payload,
                });
            }

            return {
                status: response.status,
                data: payload as T,
            };
        } catch (error) {
            if (isApiClientError(error)) {
                throw error;
            }

            const errorLike = isObjectRecord(error)
                ? (error as { name?: unknown; message?: unknown })
                : null;

            if (
                errorLike &&
                typeof errorLike.name === 'string' &&
                errorLike.name === 'AbortError'
            ) {
                const requestWasExternallyAborted = signal?.aborted ?? false;
                throw createApiClientError({
                    status: null,
                    code: requestWasExternallyAborted
                        ? 'aborted_error'
                        : 'timeout_error',
                    message: requestWasExternallyAborted
                        ? 'Request was aborted'
                        : `Request timed out after ${timeout}ms`,
                    endpoint,
                    raw: error,
                });
            }

            throw createApiClientError({
                status: null,
                code: 'network_error',
                message:
                    errorLike && typeof errorLike.message === 'string'
                        ? errorLike.message
                        : 'Network request failed',
                endpoint,
                raw: error,
            });
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            if (signal) {
                signal.removeEventListener('abort', onExternalAbort);
            }
        }
    };

    const reflectQuestion = async (
        request: ReflectRequest,
        options?: { turnstileToken?: string; signal?: AbortSignal }
    ): Promise<ReflectResponse> => {
        const headers: Record<string, string> = {};

        if (options?.turnstileToken) {
            headers['x-turnstile-token'] = options.turnstileToken;
        }

        const response = await requestJson<ReflectResponse>('/api/reflect', {
            method: 'POST',
            headers,
            body: request,
            signal: options?.signal,
        });

        return response.data;
    };

    const getRuntimeConfig = async (
        signal?: AbortSignal
    ): Promise<RuntimeConfigResponse> => {
        const response = await requestJson<RuntimeConfigResponse>(
            '/config.json',
            {
                method: 'GET',
                signal,
                cache: 'no-store',
            }
        );
        return response.data;
    };

    const getBlogIndex = async (
        signal?: AbortSignal
    ): Promise<BlogIndexResponse> => {
        const response = await requestJson<BlogIndexResponse>(
            '/api/blog-posts',
            {
                method: 'GET',
                signal,
            }
        );
        return response.data;
    };

    const getBlogPost = async (
        discussionNumber: number,
        signal?: AbortSignal
    ): Promise<BlogPostResponse> => {
        const response = await requestJson<BlogPostResponse>(
            `/api/blog-posts/${discussionNumber}`,
            {
                method: 'GET',
                signal,
            }
        );
        return response.data;
    };

    const getTrace = async (
        responseId: string,
        signal?: AbortSignal
    ): Promise<ApiJsonResult<TraceResponse | TraceStaleResponse>> =>
        requestJson<TraceResponse | TraceStaleResponse>(
            `/api/traces/${responseId}`,
            {
                method: 'GET',
                signal,
                headers: {
                    Accept: 'application/json',
                },
                acceptedStatusCodes: [410],
            }
        );

    return {
        requestJson,
        reflectQuestion,
        getRuntimeConfig,
        getBlogIndex,
        getBlogPost,
        getTrace,
    };
};

export const api = createWebApiClient();
export type { ApiClientError, ApiErrorResponse };
