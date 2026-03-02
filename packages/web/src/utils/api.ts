/**
 * @description: Provides a package-local API client for web routes with shared transport and error parsing.
 * @footnote-scope: utility
 * @footnote-module: WebApiClient
 * @footnote-risk: medium - Incorrect request handling can break chat/blog/trace experiences.
 * @footnote-ethics: medium - Consistent error handling helps keep fallback behavior transparent.
 */

import type {
    ApiErrorResponse,
    GetBlogPostResponse,
    GetRuntimeConfigResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    ListBlogPostsResponse,
    PostReflectRequest,
    PostReflectResponse,
} from '@footnote/contracts/web';
import {
    GetTraceApiResponseSchema,
    PostReflectResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
import {
    createApiTransport,
    isApiClientError as isSharedApiClientError,
    type ApiClientError,
    type ApiJsonResult,
    type CreateApiTransportOptions,
} from '@footnote/contracts/web/client-core';

type CreateWebApiClientOptions = CreateApiTransportOptions;

export const isApiClientError = (value: unknown): value is ApiClientError =>
    isSharedApiClientError(value, 'ApiClientError');

export const createWebApiClient = ({
    baseUrl,
    defaultHeaders,
    defaultTimeoutMs,
    fetchImpl = fetch,
}: CreateWebApiClientOptions = {}) => {
    const { requestJson } = createApiTransport({
        baseUrl,
        defaultHeaders,
        defaultTimeoutMs,
        fetchImpl,
        clientErrorName: 'ApiClientError',
    });

    /**
     * @api.operationId: postReflect
     * @api.path: POST /api/reflect
     */
    const reflectQuestion = async (
        request: PostReflectRequest,
        options?: { turnstileToken?: string; signal?: AbortSignal }
    ): Promise<PostReflectResponse> => {
        const headers: Record<string, string> = {};

        if (options?.turnstileToken) {
            headers['x-turnstile-token'] = options.turnstileToken;
        }

        const response = await requestJson<PostReflectResponse>(
            '/api/reflect',
            {
                method: 'POST',
                headers,
                body: request,
                signal: options?.signal,
                validateResponse:
                    createSchemaResponseValidator(PostReflectResponseSchema),
            }
        );

        return response.data;
    };

    /**
     * @api.operationId: getRuntimeConfig
     * @api.path: GET /config.json
     */
    const getRuntimeConfig = async (
        signal?: AbortSignal
    ): Promise<GetRuntimeConfigResponse> => {
        const response = await requestJson<GetRuntimeConfigResponse>(
            '/config.json',
            {
                method: 'GET',
                signal,
                cache: 'no-store',
            }
        );
        return response.data;
    };

    /**
     * @api.operationId: listBlogPosts
     * @api.path: GET /api/blog-posts
     */
    const getBlogIndex = async (
        signal?: AbortSignal
    ): Promise<ListBlogPostsResponse> => {
        const response = await requestJson<ListBlogPostsResponse>(
            '/api/blog-posts',
            {
                method: 'GET',
                signal,
            }
        );
        return response.data;
    };

    /**
     * @api.operationId: getBlogPost
     * @api.path: GET /api/blog-posts/{postId}
     */
    const getBlogPost = async (
        discussionNumber: number,
        signal?: AbortSignal
    ): Promise<GetBlogPostResponse> => {
        const response = await requestJson<GetBlogPostResponse>(
            `/api/blog-posts/${discussionNumber}`,
            {
                method: 'GET',
                signal,
            }
        );
        return response.data;
    };

    /**
     * @api.operationId: getTrace
     * @api.path: GET /api/traces/{responseId}
     */
    const getTrace = async (
        responseId: string,
        signal?: AbortSignal
    ): Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>> => {
        const encodedResponseId = encodeURIComponent(responseId);
        return requestJson<GetTraceResponse | GetTraceStaleResponse>(
            `/api/traces/${encodedResponseId}`,
            {
                method: 'GET',
                signal,
                headers: {
                    Accept: 'application/json',
                },
                acceptedStatusCodes: [410],
                validateResponse: createSchemaResponseValidator(
                    GetTraceApiResponseSchema
                ),
            }
        );
    };

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

