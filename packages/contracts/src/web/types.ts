/**
 * @description: Shared web API contract types for request and response payloads.
 * @footnote-scope: interface
 * @footnote-module: WebContracts
 * @footnote-risk: low - Contract drift can break client/server compatibility.
 * @footnote-ethics: medium - Contract clarity supports transparent behavior.
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
export type ReflectSurface = 'web' | 'discord';

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type ReflectTriggerKind = 'submit' | 'direct' | 'invoked' | 'catchup';

/**
 * Transport-neutral conversation entry sent to the backend reflect workflow.
 */
export type ReflectConversationMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
    authorName?: string;
    authorId?: string;
    messageId?: string;
    createdAt?: string;
};

/**
 * Attachments provide lightweight modality hints without coupling the contract
 * to one surface's event model.
 */
export type ReflectAttachment = {
    kind: 'image';
    url: string;
    contentType?: string;
};

/**
 * Surface capabilities tell the backend which action types are actually usable
 * for this caller.
 */
export type ReflectCapabilities = {
    canReact: boolean;
    canGenerateImages: boolean;
    canUseTts: boolean;
};

/**
 * Shared image-generation instructions returned by reflect planning.
 */
export type ReflectImageRequest = {
    prompt: string;
    aspectRatio?: 'auto' | 'square' | 'portrait' | 'landscape';
    background?: string;
    quality?: 'low' | 'medium' | 'high' | 'auto';
    style?: string;
    allowPromptAdjustment?: boolean;
    followUpResponseId?: string;
    outputFormat?: 'png' | 'webp' | 'jpeg';
    outputCompression?: number;
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type PostReflectRequest = {
    surface: ReflectSurface;
    trigger: {
        kind: ReflectTriggerKind;
        messageId?: string;
    };
    latestUserInput: string;
    conversation: ReflectConversationMessage[];
    attachments?: ReflectAttachment[];
    capabilities?: ReflectCapabilities;
    sessionId?: string;
    surfaceContext?: {
        channelId?: string;
        guildId?: string;
        userId?: string;
        requestHost?: string;
    };
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type ReflectMessageActionResponse = {
    action: 'message';
    message: string;
    modality: 'text' | 'tts';
    metadata: ResponseMetadata;
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type ReflectReactActionResponse = {
    action: 'react';
    reaction: string;
    metadata: null;
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type ReflectIgnoreActionResponse = {
    action: 'ignore';
    metadata: null;
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type ReflectImageActionResponse = {
    action: 'image';
    imageRequest: ReflectImageRequest;
    metadata: null;
};

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export type PostReflectResponse =
    | ReflectMessageActionResponse
    | ReflectReactActionResponse
    | ReflectIgnoreActionResponse
    | ReflectImageActionResponse;

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export type PostTracesRequest = ResponseMetadata;

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export type PostTracesResponse = {
    ok: true;
    responseId: string;
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

