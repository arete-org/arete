/**
 * @description: Re-exports the shared web API types and validation schemas used across Footnote packages.
 * @footnote-scope: interface
 * @footnote-module: WebContractsIndex
 * @footnote-risk: low - Incorrect exports can cause type mismatches.
 * @footnote-ethics: low - Export surface only; no runtime behavior.
 */

// Shared error envelopes.
export type { ApiErrorResponse, NormalizedApiError } from './types.js';

/**
 * @api.operationId: postChat
 * @api.path: POST /api/chat
 */
export type {
    ChatSurface,
    ChatTriggerKind,
    ChatProfileOption,
    ChatConversationMessage,
    ChatAttachment,
    ChatCapabilities,
    ChatImageRequest,
    PostChatRequest,
    ChatMessageActionResponse,
    ChatReactActionResponse,
    ChatIgnoreActionResponse,
    ChatImageActionResponse,
    PostChatResponse,
    GetChatProfilesResponse,
} from './types.js';

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type {
    InternalTextTask,
    InternalTextChannelContext,
    InternalTextCosts,
    InternalNewsItem,
    InternalTextUsage,
    PostInternalImageDescriptionTaskRequest,
    PostInternalImageDescriptionTaskResponse,
    PostInternalNewsTaskRequest,
    PostInternalNewsTaskResponse,
    PostInternalTextRequest,
    PostInternalTextResponse,
} from './types.js';

/**
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type {
    InternalImageAnnotations,
    InternalImageBackground,
    InternalImageChannelContext,
    InternalImageErrorEvent,
    InternalImageGenerationArtifact,
    InternalImagePartialImageEvent,
    InternalImageQuality,
    InternalImageRenderModel,
    InternalImageResultEvent,
    InternalImageSize,
    InternalImageStreamEvent,
    InternalImageTextModel,
    InternalImageUserContext,
    PostInternalImageGenerateRequest,
    PostInternalImageGenerateResponse,
    PostInternalImageRequest,
    PostInternalImageResponse,
} from './types.js';

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export type { PostTracesRequest, PostTracesResponse } from './types.js';

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export type {
    PostTraceCardRequest,
    PostTraceCardResponse,
    GetTraceCardSvgResponse,
    TraceCardChipData,
} from './types.js';

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export type {
    PostTraceCardFromTraceRequest,
    PostTraceCardFromTraceResponse,
} from './types.js';

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export type { GetTraceResponse, GetTraceStaleResponse } from './types.js';

/**
 * @api.operationId: getRuntimeConfig
 * @api.path: GET /config.json
 */
export type { GetRuntimeConfigResponse } from './types.js';

/**
 * @api.operationId: postIncidentReport
 * @api.path: POST /api/incidents/report
 * @api.operationId: listIncidents
 * @api.path: GET /api/incidents
 * @api.operationId: getIncident
 * @api.path: GET /api/incidents/{incidentId}
 * @api.operationId: postIncidentStatus
 * @api.path: POST /api/incidents/{incidentId}/status
 * @api.operationId: postIncidentNotes
 * @api.path: POST /api/incidents/{incidentId}/notes
 * @api.operationId: postIncidentRemediation
 * @api.path: POST /api/incidents/{incidentId}/remediation
 */
export type {
    IncidentAuditAction,
    IncidentAuditEvent,
    IncidentDetail,
    IncidentPointers,
    IncidentRemediation,
    IncidentRemediationState,
    IncidentStatus,
    IncidentSummary,
    GetIncidentResponse,
    GetIncidentsResponse,
    PostIncidentNotesRequest,
    PostIncidentNotesResponse,
    PostIncidentRemediationRequest,
    PostIncidentRemediationResponse,
    PostIncidentReportRequest,
    PostIncidentReportResponse,
    PostIncidentStatusRequest,
    PostIncidentStatusResponse,
} from './types.js';

/**
 * @api.operationId: listBlogPosts
 * @api.path: GET /api/blog-posts
 */
export type {
    BlogAuthor,
    BlogPostMetadata,
    ListBlogPostsResponse,
} from './types.js';

/**
 * @api.operationId: getBlogPost
 * @api.path: GET /api/blog-posts/{postId}
 */
export type { BlogPost, GetBlogPostResponse } from './types.js';

// Runtime validation schemas for chat/traces contracts.
export {
    ApiErrorResponseSchema,
    CitationSchema,
    GetTraceApiResponseSchema,
    GetIncidentResponseSchema,
    GetIncidentsResponseSchema,
    GetTraceResponseSchema,
    GetTraceStaleResponseSchema,
    PostIncidentNotesRequestSchema,
    PostIncidentNotesResponseSchema,
    PostIncidentRemediationRequestSchema,
    PostIncidentRemediationResponseSchema,
    PostIncidentReportRequestSchema,
    PostIncidentReportResponseSchema,
    PostInternalImageDescriptionTaskRequestSchema,
    PostInternalImageDescriptionTaskResponseSchema,
    PostIncidentStatusRequestSchema,
    PostIncidentStatusResponseSchema,
    PostInternalNewsTaskRequestSchema,
    PostInternalNewsTaskResponseSchema,
    PostInternalImageGenerateRequestSchema,
    PostInternalImageGenerateResponseSchema,
    PostInternalImageRequestSchema,
    PostInternalImageResponseSchema,
    InternalImageStreamEventSchema,
    PostInternalTextRequestSchema,
    PostInternalTextResponseSchema,
    PostChatRequestSchema,
    GetChatProfilesResponseSchema,
    PostChatResponseSchema,
    PostTraceCardFromTraceRequestSchema,
    PostTraceCardFromTraceResponseSchema,
    PostTraceCardRequestSchema,
    PostTraceCardResponseSchema,
    PostTracesRequestSchema,
    PostTracesResponseSchema,
    ResponseMetadataSchema,
    createSchemaResponseValidator,
} from './schemas.js';
