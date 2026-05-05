/**
 * @description: Web-facing wrapper over the shared @footnote/api-client package.
 * @footnote-scope: utility
 * @footnote-module: WebApiClient
 * @footnote-risk: medium - Incorrect transport wiring can break chat/trace experiences.
 * @footnote-ethics: medium - Consistent error handling helps keep fallback behavior transparent.
 */
import {
    createWebApiClient as createSharedWebApiClient,
    isApiClientError as isSharedApiClientError,
    type ApiJsonResult,
    type ApiClientError,
    type ApiErrorResponse,
    type CreateWebApiClientOptions,
} from '@footnote/api-client/web-client';
import type {
    GetRuntimeConfigResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    PostChatRequest,
    PostChatResponse,
} from '@footnote/contracts/web';

export const isApiClientError = (value: unknown): value is ApiClientError =>
    isSharedApiClientError(value, 'ApiClientError');

export type WebApiClient = {
    requestJson: ReturnType<typeof createSharedWebApiClient>['requestJson'];
    chatQuestion: (
        request: PostChatRequest,
        options?: { turnstileToken?: string; signal?: AbortSignal }
    ) => Promise<PostChatResponse>;
    getRuntimeConfig: (
        signal?: AbortSignal
    ) => Promise<GetRuntimeConfigResponse>;
    getTrace: (
        responseId: string,
        signal?: AbortSignal
    ) => Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>>;
};

// Keep this thin local wrapper so web can add surface-specific behavior later
// (telemetry, headers, retries, or method overrides) without changing imports.
export const createWebApiClient = (
    options: CreateWebApiClientOptions = {}
): WebApiClient => {
    const shared = createSharedWebApiClient(options);

    const chatQuestion = shared.chatQuestion;
    const getRuntimeConfig = shared.getRuntimeConfig;
    const getTrace = shared.getTrace;

    return {
        requestJson: shared.requestJson,
        chatQuestion,
        getRuntimeConfig,
        getTrace,
    };
};

export const api = createWebApiClient();

/**
 * Public API boundary helper for posting chat requests to backend chat routes.
 * Delegates to internal api.chatQuestion and supports optional turnstileToken
 * and abort signal. Returns PostChatResponse.
 */
export const chatQuestion = (
    request: PostChatRequest,
    options?: { turnstileToken?: string; signal?: AbortSignal }
): Promise<PostChatResponse> => api.chatQuestion(request, options);

/**
 * Public API boundary helper for loading web runtime configuration from backend.
 * Delegates to internal api.getRuntimeConfig and accepts an optional abort
 * signal. Returns GetRuntimeConfigResponse.
 */
export const getRuntimeConfig = (
    signal?: AbortSignal
): Promise<GetRuntimeConfigResponse> => api.getRuntimeConfig(signal);

/**
 * Public API boundary helper for fetching trace details for a response id.
 * Delegates to internal api.getTrace and supports optional abort signal for
 * cancellation. Returns ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>.
 */
export const getTrace = (
    responseId: string,
    signal?: AbortSignal
): Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>> =>
    api.getTrace(responseId, signal);

export type { ApiClientError, ApiErrorResponse };
