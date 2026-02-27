/**
 * @description: Public exports for web API contract types.
 * @arete-scope: interface
 * @arete-module: WebContractsIndex
 * @arete-risk: low - Incorrect exports can cause type mismatches.
 * @arete-ethics: low - Export surface only; no runtime behavior.
 *
 * @openapi.source: docs/api/openapi.yaml
 */

/**
 * Shared error envelopes.
 * @openapi.component: ErrorResponse
 * @openapi.source: docs/api/openapi.yaml
 */
export type {
    ApiErrorResponse,
    NormalizedApiError,
} from './types';

/**
 * Reflection endpoint contracts.
 * @openapi.operationId: postReflect
 * @openapi.path: POST /api/reflect
 * @openapi.source: docs/api/openapi.yaml
 */
export type {
    ReflectRequest,
    ReflectResponse,
} from './types';

/**
 * Trace retrieval endpoint contracts.
 * @openapi.operationId: getTrace
 * @openapi.path: GET /api/traces/{responseId}
 * @openapi.source: docs/api/openapi.yaml
 */
export type {
    TraceResponse,
    TraceStaleResponse,
} from './types';

/**
 * Runtime config endpoint contract.
 * @openapi.operationId: getRuntimeConfig
 * @openapi.path: GET /config.json
 * @openapi.source: docs/api/openapi.yaml
 */
export type {
    RuntimeConfigResponse,
} from './types';

/**
 * Blog endpoint contracts.
 * @openapi.operationId: listBlogPosts
 * @openapi.path: GET /api/blog-posts
 * @openapi.operationId: getBlogPost
 * @openapi.path: GET /api/blog-posts/{postId}
 * @openapi.source: docs/api/openapi.yaml
 */
export type {
    BlogAuthor,
    BlogPostMetadata,
    BlogPost,
    BlogIndexResponse,
    BlogPostResponse,
} from './types';
