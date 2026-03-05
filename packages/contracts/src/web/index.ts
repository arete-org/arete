/**
 * @description: Public exports for web API contract types and runtime schemas.
 * @footnote-scope: interface
 * @footnote-module: WebContractsIndex
 * @footnote-risk: low - Incorrect exports can cause type mismatches.
 * @footnote-ethics: low - Export surface only; no runtime behavior.
 */

// Shared error envelopes.
export type { ApiErrorResponse, NormalizedApiError } from './types';

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type {
    ReflectSurface,
    ReflectTriggerKind,
    ReflectConversationMessage,
    ReflectAttachment,
    ReflectCapabilities,
    ReflectImageRequest,
    PostReflectRequest,
    ReflectMessageActionResponse,
    ReflectReactActionResponse,
    ReflectIgnoreActionResponse,
    ReflectImageActionResponse,
    PostReflectResponse,
} from './types';

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export type { PostTracesRequest, PostTracesResponse } from './types';

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export type {
    PostTraceCardRequest,
    PostTraceCardResponse,
    GetTraceCardSvgResponse,
    TraceCardChipData,
} from './types';

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export type {
    PostTraceCardFromTraceRequest,
    PostTraceCardFromTraceResponse,
} from './types';

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

// Runtime validation schemas for reflect/traces contracts.
export {
    ApiErrorResponseSchema,
    CitationSchema,
    GetTraceApiResponseSchema,
    GetTraceResponseSchema,
    GetTraceStaleResponseSchema,
    PostReflectRequestSchema,
    PostReflectResponseSchema,
    PostTraceCardFromTraceRequestSchema,
    PostTraceCardFromTraceResponseSchema,
    PostTraceCardRequestSchema,
    PostTraceCardResponseSchema,
    PostTracesRequestSchema,
    PostTracesResponseSchema,
    ResponseMetadataSchema,
    createSchemaResponseValidator,
} from './schemas';

