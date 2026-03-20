/**
 * @description: Defines the request and response shapes shared by Footnote's web-facing APIs.
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
import type {
    InternalImageRenderModelId,
    InternalImageTextModelId,
    SupportedImageOutputFormat,
} from '../providers';

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
 * Curated text-model vocabulary accepted by the trusted internal image route.
 * The concrete list lives in the shared provider registry so contracts, schema
 * validation, and Discord model choices stay aligned.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageTextModel = InternalImageTextModelId;

/**
 * Curated image-model vocabulary accepted by the trusted internal image route.
 * The concrete list lives in the shared provider registry so contracts, schema
 * validation, and Discord model choices stay aligned.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageRenderModel = InternalImageRenderModelId;

/**
 * Internal image quality values accepted by the trusted backend image route.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageQuality = 'low' | 'medium' | 'high' | 'auto';

/**
 * Internal image size values accepted by the trusted backend image route.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageSize =
    | '1024x1024'
    | '1024x1536'
    | '1536x1024'
    | 'auto';

/**
 * Internal image background values accepted by the trusted backend image route.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageBackground = 'auto' | 'transparent' | 'opaque';

/**
 * One normalized image annotation bundle returned by backend-owned image
 * execution.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageAnnotations = {
    title: string | null;
    description: string | null;
    note: string | null;
    adjustedPrompt?: string | null;
};

/**
 * User-context fields the backend image runtime uses to assemble the
 * Footnote-owned prompt overlay and developer prompt.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageUserContext = {
    username: string;
    nickname: string;
    guildName: string;
};

/**
 * Optional routing context used for backend logging and Discord-side usage
 * accounting.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageChannelContext = {
    channelId?: string;
    guildId?: string;
};

/**
 * Trusted internal request for backend-owned image generation.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type PostInternalImageGenerateRequest = {
    task: 'generate';
    prompt: string;
    textModel: InternalImageTextModel;
    imageModel: InternalImageRenderModel;
    size: InternalImageSize;
    quality: InternalImageQuality;
    background: InternalImageBackground;
    style: string;
    allowPromptAdjustment: boolean;
    outputFormat: SupportedImageOutputFormat;
    outputCompression: number;
    user: InternalImageUserContext;
    followUpResponseId?: string;
    channelContext?: InternalImageChannelContext;
    stream?: boolean;
};

/**
 * Normalized image artifact payload returned by backend-owned image execution.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageGenerationArtifact = {
    responseId: string | null;
    textModel: InternalImageTextModel;
    imageModel: InternalImageRenderModel;
    revisedPrompt: string | null;
    finalStyle: string;
    annotations: InternalImageAnnotations;
    finalImageBase64: string;
    outputFormat: SupportedImageOutputFormat;
    outputCompression: number;
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        imageCount: number;
    };
    costs: {
        text: number;
        image: number;
        total: number;
        perImage: number;
    };
    generationTimeMs: number;
};

/**
 * Trusted internal response for backend-owned image generation.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type PostInternalImageGenerateResponse = {
    task: 'generate';
    result: InternalImageGenerationArtifact;
};

/**
 * One streamed partial-image preview emitted by the trusted internal image
 * route when the caller opts into NDJSON streaming.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImagePartialImageEvent = {
    type: 'partial_image';
    index: number;
    base64: string;
};

/**
 * One streamed final result event emitted by the trusted internal image route.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageResultEvent = {
    type: 'result';
    task: 'generate';
    result: InternalImageGenerationArtifact;
};

/**
 * One streamed terminal error emitted by the trusted internal image route
 * after streaming has already started.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageErrorEvent = {
    type: 'error';
    error: string;
};

/**
 * Narrow streamed event union for the trusted internal image route.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type InternalImageStreamEvent =
    | InternalImagePartialImageEvent
    | InternalImageResultEvent
    | InternalImageErrorEvent;

/**
 * Narrow trusted internal image-task request union.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type PostInternalImageRequest = PostInternalImageGenerateRequest;

/**
 * Narrow trusted internal image-task response union.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export type PostInternalImageResponse = PostInternalImageGenerateResponse;

/**
 * Internal task discriminator for the trusted `/api/internal/text` endpoint.
 * The endpoint stays task-based on purpose so trusted callers cannot turn it
 * into a generic prompt proxy.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type InternalTextTask = 'news' | 'image_description';

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
    timestamp?: string;
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
 * Optional routing context used for backend logging and Discord-side usage
 * attribution on trusted internal text tasks.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type InternalTextChannelContext = {
    channelId?: string;
    guildId?: string;
};

/**
 * Trusted internal request for the image-description helper task. The backend
 * owns the prompt, vision call, and spend recording; callers only send the
 * image URL plus optional grounding text.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalImageDescriptionTaskRequest = {
    task: 'image_description';
    imageUrl: string;
    context?: string;
    channelContext?: InternalTextChannelContext;
};

/**
 * Normalized token usage returned by the internal image-description helper.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type InternalTextUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
};

/**
 * Normalized cost breakdown returned by the internal image-description helper.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type InternalTextCosts = {
    input: number;
    output: number;
    total: number;
};

/**
 * Trusted internal response for the image-description helper task.
 *
 * The `description` field carries the compact text payload that Discord uses
 * for reflect grounding today. It may contain structured JSON text when that
 * preserves more useful image details than a plain sentence would.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalImageDescriptionTaskResponse = {
    task: 'image_description';
    result: {
        description: string;
        model: string;
        usage: InternalTextUsage;
        costs: InternalTextCosts;
    };
};

/**
 * Narrow trusted internal text-task request union. This stays purpose-built on
 * purpose; it is not a generic prompt proxy.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalTextRequest =
    | PostInternalNewsTaskRequest
    | PostInternalImageDescriptionTaskRequest;

/**
 * Narrow trusted internal text-task response union.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export type PostInternalTextResponse =
    | PostInternalNewsTaskResponse
    | PostInternalImageDescriptionTaskResponse;

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
