/**
 * @description: Web-facing wrapper over the shared @footnote/api-client package.
 * @footnote-scope: utility
 * @footnote-module: WebApiClient
 * @footnote-risk: medium - Incorrect transport wiring can break chat/blog/trace experiences.
 * @footnote-ethics: medium - Consistent error handling helps keep fallback behavior transparent.
 */
import {
    createWebApiClient as createSharedWebApiClient,
    isApiClientError,
    type ApiJsonResult,
    type ApiClientError,
    type ApiErrorResponse,
    type CreateWebApiClientOptions,
} from '@footnote/api-client';
import type {
    GetBlogPostResponse,
    GetRuntimeConfigResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    ListBlogPostsResponse,
    PostChatRequest,
    PostChatResponse,
} from '@footnote/contracts/web';

export { isApiClientError };

export const createWebApiClient = (
    options: CreateWebApiClientOptions = {}
) => {
    const shared = createSharedWebApiClient(options);

    const chatQuestion = shared.chatQuestion;
    const getRuntimeConfig = shared.getRuntimeConfig;
    const getBlogIndex = shared.getBlogIndex;
    const getBlogPost = shared.getBlogPost;
    const getTrace = shared.getTrace;

    return {
        requestJson: shared.requestJson,
        chatQuestion,
        getRuntimeConfig,
        getBlogIndex,
        getBlogPost,
        getTrace,
    };
};

export const api = createWebApiClient();

export const chatQuestion = (
    request: PostChatRequest,
    options?: { turnstileToken?: string; signal?: AbortSignal }
): Promise<PostChatResponse> => api.chatQuestion(request, options);
export const getRuntimeConfig = (
    signal?: AbortSignal
): Promise<GetRuntimeConfigResponse> => api.getRuntimeConfig(signal);
export const getBlogIndex = (
    signal?: AbortSignal
): Promise<ListBlogPostsResponse> => api.getBlogIndex(signal);
export const getBlogPost = (
    discussionNumber: number,
    signal?: AbortSignal
): Promise<GetBlogPostResponse> => api.getBlogPost(discussionNumber, signal);
export const getTrace = (
    responseId: string,
    signal?: AbortSignal
): Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>> =>
    api.getTrace(responseId, signal);

export type { ApiClientError, ApiErrorResponse };

