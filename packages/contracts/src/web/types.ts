/**
 * @description: Shared web API contract types for request and response payloads.
 * @arete-scope: interface
 * @arete-module: WebContracts
 * @arete-risk: low - Contract drift can break client/server compatibility.
 * @arete-ethics: moderate - Contract clarity supports transparent behavior.
 */

import type { ResponseMetadata } from '../ethics-core';

// Standard API error envelope used by multiple endpoints.
export type ApiErrorResponse = {
    error: string;
    details?: string;
    retryAfter?: number;
};

/**
 * Package-local normalized error model.
 * This is intentionally not an OpenAPI schema because it includes client-only fields
 * like endpoint and raw payload references.
 */
export type NormalizedApiError = {
    status: number | null;
    code: string;
    message: string;
    details?: string;
    retryAfter?: number;
    endpoint: string;
    raw?: unknown;
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type PostReflectRequest = {
    question: string;
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type PostReflectResponse = {
    message: string;
    metadata: ResponseMetadata;
};

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export type GetTraceResponse = ResponseMetadata;

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export type GetTraceStaleResponse = {
    message: 'Trace is stale';
    metadata: ResponseMetadata;
};

/**
 * @api.operationId: getRuntimeConfig
 * @api.path: GET /config.json
 */
export type GetRuntimeConfigResponse = {
    turnstileSiteKey: string;
};

// Blog author payload used by blog list/detail endpoints.
export type BlogAuthor = {
    login: string;
    avatarUrl: string;
    profileUrl: string;
};

/**
 * @api.operationId: listBlogPosts
 * @api.path: GET /api/blog-posts
 */
export type BlogPostMetadata = {
    number: number;
    title: string;
    author: BlogAuthor;
    createdAt: string;
    updatedAt: string;
};

/**
 * @api.operationId: getBlogPost
 * @api.path: GET /api/blog-posts/{postId}
 */
export type BlogPost = BlogPostMetadata & {
    body: string;
    discussionUrl: string;
    commentCount: number;
};

/**
 * @api.operationId: listBlogPosts
 * @api.path: GET /api/blog-posts
 */
export type ListBlogPostsResponse = BlogPostMetadata[];

/**
 * @api.operationId: getBlogPost
 * @api.path: GET /api/blog-posts/{postId}
 */
export type GetBlogPostResponse = BlogPost;
