/**
 * @description: Public entry point for shared type contracts used across packages.
 * @footnote-scope: interface
 * @footnote-module: ContractsIndex
 * @footnote-risk: low - Incorrect exports can cause type drift between packages.
 * @footnote-ethics: moderate - Types document data meaning but do not execute logic.
 */

// This file is intentionally small. It only re-exports types so every package
// can import from one place without pulling in runtime code.

// Ethics Core contracts (provenance/risk metadata)
export type {
    Provenance,
    RiskTier,
    ConfidenceScore,
    Citation,
    ResponseMetadata,
} from './ethics-core';

// Web API contracts (request/response envelopes)
export type {
    ApiErrorResponse,
    NormalizedApiError,
    PostReflectRequest,
    PostReflectResponse,
    PostTracesRequest,
    PostTracesResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    GetRuntimeConfigResponse,
    BlogAuthor,
    BlogPostMetadata,
    BlogPost,
    ListBlogPostsResponse,
    GetBlogPostResponse,
} from './web';

