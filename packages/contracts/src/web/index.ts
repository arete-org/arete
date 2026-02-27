/**
 * @description: Public exports for web API contract types.
 * @arete-scope: interface
 * @arete-module: WebContractsIndex
 * @arete-risk: low - Incorrect exports can cause type mismatches.
 * @arete-ethics: low - Export surface only; no runtime behavior.
 */

// Shared error envelopes.
export type { ApiErrorResponse, NormalizedApiError } from './types';

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type { PostReflectRequest, PostReflectResponse } from './types';

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export type { PostTracesRequest, PostTracesResponse } from './types';

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export type { GetTraceResponse, GetTraceStaleResponse } from './types';

/**
 * @api.operationId: getRuntimeConfig
 * @api.path: GET /config.json
 */
export type { GetRuntimeConfigResponse } from './types';

/**
 * @api.operationId: listBlogPosts
 * @api.path: GET /api/blog-posts
 */
export type {
    BlogAuthor,
    BlogPostMetadata,
    ListBlogPostsResponse,
} from './types';

/**
 * @api.operationId: getBlogPost
 * @api.path: GET /api/blog-posts/{postId}
 */
export type { BlogPost, GetBlogPostResponse } from './types';
