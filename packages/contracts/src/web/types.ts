/**
 * @description: Shared web API contract types for request and response payloads.
 * @footnote-scope: interface
 * @footnote-module: WebContracts
 * @footnote-risk: low - Contract drift can break client/server compatibility.
 * @footnote-ethics: medium - Contract clarity supports transparent behavior.
 */

import type {
    PartialResponseTemperament,
    ResponseMetadata,
    TraceAxisScore,
} from '../ethics-core';

// Standard API error envelope used by multiple endpoints.
export type ApiErrorResponse = {
    error: string;
    details?: string;
    retryAfter?: number;
};

/**
 * Review lifecycle used by operators while investigating one report.
 */
export type IncidentStatus =
    | 'new'
    | 'under_review'
    | 'confirmed'
    | 'dismissed'
    | 'resolved';

/**
 * Canonical audit event names recorded for incident workflows.
 */
export type IncidentAuditAction =
    | 'incident.created'
    | 'incident.remediated'
    | 'incident.status_changed'
    | 'incident.note_added';

/**
 * Outcome of the bot's immediate "mark under review" remediation attempt.
 */
export type IncidentRemediationState =
    | 'pending'
    | 'applied'
    | 'already_marked'
    | 'skipped_not_assistant'
    | 'failed';

/**
 * Operator-safe provenance pointers. Discord identifiers are already hashed by
 * the time these values leave the backend.
 */
export type IncidentPointers = {
    responseId?: string;
    guildId?: string;
    channelId?: string;
    messageId?: string;
    modelVersion?: string;
    chainHash?: string;
};

/**
 * One incident audit entry shown in detail views.
 */
export type IncidentAuditEvent = {
    action: IncidentAuditAction;
    actorHash?: string | null;
    notes?: string | null;
    createdAt: string;
};

/**
 * Remediation status returned with each incident response so operators can see
 * whether the bot successfully marked the message.
 */
export type IncidentRemediation = {
    state: IncidentRemediationState;
    applied: boolean;
    notes?: string | null;
    updatedAt?: string | null;
};

/**
 * Compact operator-safe incident row used by list responses and `/incident
 * list`.
 */
export type IncidentSummary = {
    incidentId: string;
    status: IncidentStatus;
    tags: string[];
    description?: string | null;
    contact?: string | null;
    createdAt: string;
    updatedAt: string;
    consentedAt: string;
    pointers: IncidentPointers;
    remediation: IncidentRemediation;
};

/**
 * Full operator-safe incident view, including audit history.
 */
export type IncidentDetail = IncidentSummary & {
    auditEvents: IncidentAuditEvent[];
};

/**
 * Report submission sent from the Discord bot to the backend. Raw Discord IDs
 * may appear here at the boundary, but the backend pseudonymizes them before
 * storage or operator responses.
 *
 * @api.operationId: postIncidentReport
 * @api.path: POST /api/incidents/report
 */
export type PostIncidentReportRequest = {
    reporterUserId: string;
    guildId?: string;
    channelId?: string;
    messageId?: string;
    jumpUrl?: string;
    responseId?: string;
    chainHash?: string;
    modelVersion?: string;
    tags?: string[];
    description?: string;
    contact?: string;
    consentedAt: string;
};

/**
 * Report creation response returned after the incident is durably stored.
 *
 * @api.operationId: postIncidentReport
 * @api.path: POST /api/incidents/report
 */
export type PostIncidentReportResponse = {
    incident: IncidentDetail;
    remediation: {
        state: 'pending';
    };
};

/**
 * Newest-first incident list response for review tooling.
 *
 * @api.operationId: listIncidents
 * @api.path: GET /api/incidents
 */
export type GetIncidentsResponse = {
    incidents: IncidentSummary[];
};

/**
 * Detail response for one incident short ID.
 *
 * @api.operationId: getIncident
 * @api.path: GET /api/incidents/{incidentId}
 */
export type GetIncidentResponse = {
    incident: IncidentDetail;
};

/**
 * Operator status change request. `actorUserId` is optional so non-Discord
 * trusted callers can still use the API.
 *
 * @api.operationId: postIncidentStatus
 * @api.path: POST /api/incidents/{incidentId}/status
 */
export type PostIncidentStatusRequest = {
    status: IncidentStatus;
    actorUserId?: string;
    notes?: string;
};

/**
 * Status change response containing the fresh incident detail.
 *
 * @api.operationId: postIncidentStatus
 * @api.path: POST /api/incidents/{incidentId}/status
 */
export type PostIncidentStatusResponse = {
    incident: IncidentDetail;
};

/**
 * Appends an internal review note without changing incident status.
 *
 * @api.operationId: postIncidentNotes
 * @api.path: POST /api/incidents/{incidentId}/notes
 */
export type PostIncidentNotesRequest = {
    actorUserId?: string;
    notes: string;
};

/**
 * Note append response containing the fresh incident detail.
 *
 * @api.operationId: postIncidentNotes
 * @api.path: POST /api/incidents/{incidentId}/notes
 */
export type PostIncidentNotesResponse = {
    incident: IncidentDetail;
};

/**
 * Callback used by the Discord bot after it attempts the immediate under-review
 * edit.
 *
 * @api.operationId: postIncidentRemediation
 * @api.path: POST /api/incidents/{incidentId}/remediation
 */
export type PostIncidentRemediationRequest = {
    actorUserId?: string;
    state: Exclude<IncidentRemediationState, 'pending'>;
    notes?: string;
};

/**
 * Remediation update response containing the fresh incident detail.
 *
 * @api.operationId: postIncidentRemediation
 * @api.path: POST /api/incidents/{incidentId}/remediation
 */
export type PostIncidentRemediationResponse = {
    incident: IncidentDetail;
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
 * Internal task discriminator for the trusted `/api/internal/text` endpoint.
 * The endpoint stays task-based on purpose and currently implements `news`
 * only.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type InternalTextTask = 'news';

/**
 * One structured news item returned by the internal `news` task.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type InternalNewsItem = {
    title: string;
    summary: string;
    url: string;
    source: string;
    timestamp: string;
    thumbnail?: string | null;
    image?: string | null;
};

/**
 * Trusted internal request for the `/news` task. The backend owns
 * prompt assembly and model execution; callers only send task inputs.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalNewsTaskRequest = {
    task: 'news';
    query?: string;
    category?: string;
    maxResults?: number;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    verbosity?: 'low' | 'medium' | 'high';
    channelContext?: {
        channelId?: string;
        guildId?: string;
    };
};

/**
 * Trusted internal response for the `/news` task.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalNewsTaskResponse = {
    task: 'news';
    result: {
        news: InternalNewsItem[];
        summary: string;
    };
};

/**
 * Narrow trusted internal text-task request union. This stays purpose-built on
 * purpose; it is not a generic prompt proxy.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalTextRequest = PostInternalNewsTaskRequest;

/**
 * Narrow trusted internal text-task response union.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalTextResponse = PostInternalNewsTaskResponse;

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
 * Optional metadata scores shown next to the TRACE wheel in a trace-card.
 * Omitted scores render as unavailable.
 */
export type TraceCardChipData = {
    evidenceScore?: TraceAxisScore;
    freshnessScore?: TraceAxisScore;
};

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export type PostTraceCardRequest = {
    responseId?: string;
    temperament?: PartialResponseTemperament;
    chips?: TraceCardChipData;
};

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export type PostTraceCardResponse = {
    responseId: string;
    pngBase64: string;
};

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export type PostTraceCardFromTraceRequest = {
    responseId: string;
};

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export type PostTraceCardFromTraceResponse = PostTraceCardResponse;

/**
 * @api.operationId: getTraceCardSvg
 * @api.path: GET /api/traces/{responseId}/assets/trace-card.svg
 */
export type GetTraceCardSvgResponse = string;

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
