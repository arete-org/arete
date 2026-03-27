/**
 * @description: Read-oriented web endpoint methods used by browser and server-rendered web helpers.
 * @footnote-scope: utility
 * @footnote-module: SharedWebReadApi
 * @footnote-risk: medium - Request handling mistakes can break config, blog, and trace reading in the web surface.
 * @footnote-ethics: medium - Consistent error handling helps keep fallback behavior transparent.
 */
import type {
    GetBlogPostResponse,
    GetRuntimeConfigResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    ListBlogPostsResponse,
} from '@footnote/contracts/web';
import {
    GetTraceApiResponseSchema,
    createSchemaResponseValidator,
} from '@footnote/contracts/web/schemas';
import type { ApiJsonResult, ApiRequester } from './client.js';

export type WebReadApi = {
    getRuntimeConfig: (
        signal?: AbortSignal
    ) => Promise<GetRuntimeConfigResponse>;
    getBlogIndex: (signal?: AbortSignal) => Promise<ListBlogPostsResponse>;
    getBlogPost: (
        discussionNumber: number,
        signal?: AbortSignal
    ) => Promise<GetBlogPostResponse>;
    getTrace: (
        responseId: string,
        signal?: AbortSignal
    ) => Promise<ApiJsonResult<GetTraceResponse | GetTraceStaleResponse>>;
};

export const createWebReadApi = (requestJson: ApiRequester): WebReadApi => {
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
        getRuntimeConfig,
        getBlogIndex,
        getBlogPost,
        getTrace,
    };
};
