/**
 * @description: Shared API transport and error normalization for package-local clients.
 * @footnote-scope: utility
 * @footnote-module: WebApiClientCore
 * @footnote-risk: moderate - Shared transport regressions can impact multiple clients.
 * @footnote-ethics: moderate - Consistent error behavior helps maintain transparent fail-open handling.
 */

import type { NormalizedApiError } from './types';

export type ApiClientError = Error & NormalizedApiError;

export type ApiRequestCacheMode =
    | 'default'
    | 'no-store'
    | 'reload'
    | 'no-cache'
    | 'force-cache'
    | 'only-if-cached';

export type ApiResponseValidationResult<T> =
    | { success: true; data: T }
    | { success: false; error: string };

export type ApiResponseValidator<T> = (
    data: unknown
) => ApiResponseValidationResult<T>;

export type ApiRequestOptions<T = unknown> = {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
    cache?: ApiRequestCacheMode;
    acceptedStatusCodes?: readonly number[];
    validateResponse?: ApiResponseValidator<T>;
};

export type ApiJsonResult<T> = {
    status: number;
    data: T;
};

export type ApiRequester = <T>(
    endpoint: string,
    options?: ApiRequestOptions<T>
) => Promise<ApiJsonResult<T>>;

export type CreateApiTransportOptions = {
    baseUrl?: string;
    defaultHeaders?: Record<string, string>;
    defaultTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    clientErrorName?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ERROR_NAME = 'ApiClientError';

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const normalizeBaseUrl = (baseUrl?: string): string => {
    const trimmed = baseUrl?.trim();
    if (!trimmed) {
        return '';
    }

    // Avoid regex backtracking scanners by trimming trailing "/" with a linear scan.
    let end = trimmed.length;
    while (end > 0 && trimmed.charCodeAt(end - 1) === 47) {
        end -= 1;
    }

    return trimmed.slice(0, end);
};

const buildUrl = (baseUrl: string, endpoint: string): string => {
    if (!endpoint.startsWith('/')) {
        throw new Error(
            `API endpoint "${endpoint}" must start with "/" for predictable routing.`
        );
    }

    return baseUrl ? `${baseUrl}${endpoint}` : endpoint;
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

const createApiClientError = (
    payload: NormalizedApiError,
    errorName: string
): ApiClientError => {
    const error = new Error(payload.message) as ApiClientError;
    error.name = errorName;
    error.status = payload.status;
    error.code = payload.code;
    error.details = payload.details;
    error.retryAfter = payload.retryAfter;
    error.endpoint = payload.endpoint;
    error.raw = payload.raw;
    return error;
};

const validateApiResponsePayload = <T>(
    payload: unknown,
    endpoint: string,
    status: number,
    validateResponse: ApiResponseValidator<T>,
    errorName: string
): T => {
    try {
        const validationResult = validateResponse(payload);
        if (validationResult.success) {
            return validationResult.data;
        }

        throw createApiClientError(
            {
                status,
                code: 'invalid_payload',
                message: validationResult.error,
                endpoint,
                raw: payload,
            },
            errorName
        );
    } catch (error) {
        if (isApiClientError(error, errorName)) {
            throw error;
        }

        const errorMessage =
            error instanceof Error ? error.message : 'Response validation failed';
        throw createApiClientError(
            {
                status,
                code: 'invalid_payload',
                message: errorMessage,
                endpoint,
                raw: payload,
            },
            errorName
        );
    }
};

export const isApiClientError = (
    value: unknown,
    errorName = DEFAULT_ERROR_NAME
): value is ApiClientError =>
    value instanceof Error &&
    (value as Partial<ApiClientError>).name === errorName;

export const createApiTransport = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    clientErrorName = DEFAULT_ERROR_NAME,
}: CreateApiTransportOptions = {}) => {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    const requestJson: ApiRequester = async <T>(
        endpoint: string,
        {
            method = 'GET',
            headers,
            body,
            signal,
            timeoutMs = defaultTimeoutMs,
            cache,
            acceptedStatusCodes = [],
            validateResponse,
        }: ApiRequestOptions<T> = {}
    ): Promise<ApiJsonResult<T>> => {
        const url = buildUrl(normalizedBaseUrl, endpoint);
        const controller = new AbortController();
        const timeout = Math.max(0, timeoutMs);

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let didTimeoutAbort = false;
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
                didTimeoutAbort = true;
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
                throw createApiClientError(
                    {
                        status: response.status,
                        code: normalizeErrorCode(response.status),
                        message:
                            parsed.message ??
                            `Request failed with status ${response.status}`,
                        details: parsed.details,
                        retryAfter: parsed.retryAfter,
                        endpoint,
                        raw: payload,
                    },
                    clientErrorName
                );
            }

            const data = validateResponse
                ? validateApiResponsePayload(
                      payload,
                      endpoint,
                      response.status,
                      validateResponse,
                      clientErrorName
                  )
                : (payload as T);

            return {
                status: response.status,
                data,
            };
        } catch (error) {
            if (isApiClientError(error, clientErrorName)) {
                throw error;
            }

            if (didTimeoutAbort) {
                throw createApiClientError(
                    {
                        status: null,
                        code: 'timeout_error',
                        message: `Request timed out after ${timeout}ms`,
                        endpoint,
                        raw: error,
                    },
                    clientErrorName
                );
            }

            if (signal?.aborted) {
                throw createApiClientError(
                    {
                        status: null,
                        code: 'aborted_error',
                        message: 'Request was aborted',
                        endpoint,
                        raw: error,
                    },
                    clientErrorName
                );
            }

            const errorLike = isObjectRecord(error)
                ? (error as { name?: unknown; message?: unknown })
                : null;

            if (
                errorLike &&
                typeof errorLike.name === 'string' &&
                errorLike.name === 'AbortError'
            ) {
                throw createApiClientError(
                    {
                        status: null,
                        code: 'aborted_error',
                        message: 'Request was aborted',
                        endpoint,
                        raw: error,
                    },
                    clientErrorName
                );
            }

            throw createApiClientError(
                {
                    status: null,
                    code: 'network_error',
                    message:
                        errorLike && typeof errorLike.message === 'string'
                            ? errorLike.message
                            : 'Network request failed',
                    endpoint,
                    raw: error,
                },
                clientErrorName
            );
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            if (signal) {
                signal.removeEventListener('abort', onExternalAbort);
            }
        }
    };

    return {
        requestJson,
    };
};

