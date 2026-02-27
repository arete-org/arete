/**
 * @description: Shared web API contract types for request and response payloads.
 * @arete-scope: interface
 * @arete-module: WebContracts
 * @arete-risk: low - Contract drift can break client/server compatibility.
 * @arete-ethics: moderate - Contract clarity supports transparent behavior.
 *
 * @openapi.source: docs/api/openapi.yaml
 */

import type { ResponseMetadata } from '../ethics-core';

/**
 * OpenAPI component contract.
 * @openapi.component: ErrorResponse
 * @openapi.source: docs/api/openapi.yaml
 */
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
 * OpenAPI operation contract.
 * @openapi.operationId: postReflect
 * @openapi.path: POST /api/reflect
 * @openapi.component: ReflectRequest
 * @openapi.source: docs/api/openapi.yaml
 */
export type ReflectRequest = {
    question: string;
};

/**
 * OpenAPI operation contract.
 * @openapi.operationId: postReflect
 * @openapi.path: POST /api/reflect
 * @openapi.component: ReflectResponse
 * @openapi.source: docs/api/openapi.yaml
 */
export type ReflectResponse = {
    message: string;
    metadata: ResponseMetadata;
};

/**
 * OpenAPI operation contract.
 * @openapi.operationId: getTrace
 * @openapi.path: GET /api/traces/{responseId}
 * @openapi.component: ResponseMetadata
 * @openapi.source: docs/api/openapi.yaml
 */
export type TraceResponse = ResponseMetadata;

/**
 * OpenAPI operation contract.
 * @openapi.operationId: getTrace
 * @openapi.path: GET /api/traces/{responseId}
 * @openapi.component: TraceStaleResponse
 * @openapi.source: docs/api/openapi.yaml
 */
export type TraceStaleResponse = {
    message: 'Trace is stale';
    metadata: ResponseMetadata;
};

/**
 * OpenAPI operation contract.
 * @openapi.operationId: getRuntimeConfig
 * @openapi.path: GET /config.json
 * @openapi.component: RuntimeConfig
 * @openapi.source: docs/api/openapi.yaml
 */
export type RuntimeConfigResponse = {
    turnstileSiteKey: string;
};

/**
 * OpenAPI component contract.
 * @openapi.component: BlogPostAuthor
 * @openapi.source: docs/api/openapi.yaml
 */
export type BlogAuthor = {
    login: string;
    avatarUrl: string;
    profileUrl: string;
};

/**
 * OpenAPI operation contract.
 * @openapi.operationId: listBlogPosts
 * @openapi.path: GET /api/blog-posts
 * @openapi.component: BlogPostIndexEntry
 * @openapi.source: docs/api/openapi.yaml
 */
export type BlogPostMetadata = {
    number: number;
    title: string;
    author: BlogAuthor;
    createdAt: string;
    updatedAt: string;
};

/**
 * OpenAPI operation contract.
 * @openapi.operationId: getBlogPost
 * @openapi.path: GET /api/blog-posts/{postId}
 * @openapi.component: BlogPost
 * @openapi.source: docs/api/openapi.yaml
 */
export type BlogPost = BlogPostMetadata & {
    body: string;
    discussionUrl: string;
    commentCount: number;
};

/**
 * OpenAPI operation contract.
 * @openapi.operationId: listBlogPosts
 * @openapi.path: GET /api/blog-posts
 * @openapi.component: BlogPostIndexEntry[]
 * @openapi.source: docs/api/openapi.yaml
 */
export type BlogIndexResponse = BlogPostMetadata[];

/**
 * OpenAPI operation contract.
 * @openapi.operationId: getBlogPost
 * @openapi.path: GET /api/blog-posts/{postId}
 * @openapi.component: BlogPost
 * @openapi.source: docs/api/openapi.yaml
 */
export type BlogPostResponse = BlogPost;
