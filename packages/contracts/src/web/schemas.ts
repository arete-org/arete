/**
 * @description: Validates the shared request and response payloads used by Footnote's main web-facing APIs.
 * @footnote-scope: interface
 * @footnote-module: WebContractSchemas
 * @footnote-risk: medium - Schema drift can reject valid traffic or allow invalid payloads.
 * @footnote-ethics: medium - Validation quality affects provenance clarity and user trust.
 */

import { z } from 'zod';
import type { TraceAxisScore } from '../ethics-core/index.js';
import type { ApiResponseValidationResult } from './client-core.js';
import {
    internalImageRenderModels,
    internalImageTextModels,
    supportedImageOutputFormats,
} from '../providers.js';

const ProvenanceSchema = z.enum(['Retrieved', 'Inferred', 'Speculative']);
const RiskTierSchema = z.enum(['Low', 'Medium', 'High']);
const IncidentStatusSchema = z.enum([
    'new',
    'under_review',
    'confirmed',
    'dismissed',
    'resolved',
]);
const IncidentAuditActionSchema = z.enum([
    'incident.created',
    'incident.remediated',
    'incident.status_changed',
    'incident.note_added',
]);
const IncidentRemediationStateSchema = z.enum([
    'pending',
    'applied',
    'already_marked',
    'skipped_not_assistant',
    'failed',
]);
const ChatSurfaceSchema = z.enum(['web', 'discord']);
const ChatTriggerKindSchema = z.enum([
    'submit',
    'direct',
    'invoked',
    'catchup',
]);
const ChatProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const ChatConversationMessageSchema = z
    .object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
        authorName: z.string().min(1).optional(),
        authorId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        createdAt: z.string().min(1).optional(),
    })
    .strict();
const ChatAttachmentSchema = z
    .object({
        kind: z.literal('image'),
        url: z.string().url(),
        contentType: z.string().min(1).optional(),
    })
    .strict();
const ChatCapabilitiesSchema = z
    .object({
        canReact: z.boolean(),
        canGenerateImages: z.boolean(),
        canUseTts: z.boolean(),
    })
    .strict();
const ChatImageRequestSchema = z
    .object({
        prompt: z.string().min(1),
        aspectRatio: z
            .enum(['auto', 'square', 'portrait', 'landscape'])
            .optional(),
        background: z.string().min(1).optional(),
        quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
        style: z.string().min(1).optional(),
        allowPromptAdjustment: z.boolean().optional(),
        followUpResponseId: z.string().min(1).optional(),
        outputFormat: z.enum(['png', 'webp', 'jpeg']).optional(),
        outputCompression: z.number().int().min(1).max(100).optional(),
    })
    .strict();
export const InternalNewsItemSchema = z
    .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        url: z.string().url(),
        source: z.string().min(1),
        timestamp: z.string().datetime().optional(),
        thumbnail: z.string().url().nullable().optional(),
        image: z.string().url().nullable().optional(),
    })
    .strict();

/**
 * Shared citation schema used in reflect/traces metadata payloads.
 */
export const CitationSchema = z
    .object({
        title: z.string(),
        url: z.string().url(),
        snippet: z.string().optional(),
    })
    .strict();

/**
 * TRACE temperament profile:
 * - [T]ightness: concision and structural efficiency
 * - [R]ationale: amount of visible rationale and trade-off explanation
 * - [A]ttribution: clarity of sourced vs inferred boundaries
 * - [C]aution: safeguard posture and overclaim restraint
 * - [E]xtent: breadth of viable options and perspectives
 *
 * We use literal values (1..5) instead of a broad number schema so Zod output
 * matches the TraceAxisScore contract type exactly.
 */
const TraceAxisScoreSchema: z.ZodType<TraceAxisScore> = z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
]);

const ResponseTemperamentSchema = z
    .object({
        tightness: TraceAxisScoreSchema,
        rationale: TraceAxisScoreSchema,
        attribution: TraceAxisScoreSchema,
        caution: TraceAxisScoreSchema,
        extent: TraceAxisScoreSchema,
    })
    .strict();
const PartialResponseTemperamentSchema = ResponseTemperamentSchema.partial();
const ExecutionStatusSchema = z.enum(['executed', 'skipped', 'failed']);
const ExecutionReasonCodeSchema = z.enum([
    'planner_runtime_error',
    'planner_invalid_output',
    'evaluator_runtime_error',
    'generation_runtime_error',
    'tool_not_used',
    'search_not_supported_by_selected_profile',
    'unspecified_tool_outcome',
]);
const EvaluatorDecisionModeSchema = z.enum(['observe_only', 'enforced']);
const EvaluatorOutcomeSchema = z
    .object({
        mode: EvaluatorDecisionModeSchema,
        riskTier: RiskTierSchema,
        provenance: ProvenanceSchema,
        breakerTriggered: z.boolean(),
        breakerReason: z.string().min(1).optional(),
    })
    .strict();
// Cross-field execution invariants:
// - skipped/failed must explain why (reasonCode required)
// - executed must not include reasonCode
// This keeps telemetry queryable and avoids ambiguous event payloads.
const ExecutionEventSchema = z
    .object({
        kind: z.enum(['planner', 'evaluator', 'tool', 'generation']),
        status: ExecutionStatusSchema,
        originalProfileId: z.string().min(1).optional(),
        effectiveProfileId: z.string().min(1).optional(),
        profileId: z.string().min(1).optional(),
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        toolName: z.string().min(1).optional(),
        evaluator: EvaluatorOutcomeSchema.optional(),
        reasonCode: ExecutionReasonCodeSchema.optional(),
        durationMs: z.number().int().nonnegative().optional(),
    })
    .superRefine((value, context) => {
        if (
            (value.status === 'skipped' || value.status === 'failed') &&
            !value.reasonCode
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'reasonCode is required when execution status is skipped or failed.',
            });
        }

        if (value.status === 'executed' && value.reasonCode) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'reasonCode must be omitted when execution status is executed.',
            });
        }
    })
    .strict();

const responseMetadataShape = {
    responseId: z.string().min(1),
    provenance: ProvenanceSchema,
    riskTier: RiskTierSchema,
    tradeoffCount: z.number().nonnegative(),
    chainHash: z.string(),
    licenseContext: z.string(),
    // Deprecated compatibility field; prefer execution[].
    modelVersion: z.string(),
    staleAfter: z.string(),
    totalDurationMs: z.number().int().nonnegative().optional(),
    citations: z.array(CitationSchema),
    execution: z.array(ExecutionEventSchema).optional(),
    evaluator: EvaluatorOutcomeSchema.optional(),
    imageDescriptions: z.array(z.string()).optional(),
    evidenceScore: TraceAxisScoreSchema.optional(),
    freshnessScore: TraceAxisScoreSchema.optional(),
    temperament: PartialResponseTemperamentSchema.optional(),
} as const;

const TraceCardChipDataSchema = z
    .object({
        evidenceScore: TraceAxisScoreSchema.optional(),
        freshnessScore: TraceAxisScoreSchema.optional(),
    })
    .strict();

/**
 * Response metadata is intentionally tolerant so new backend fields do not break clients.
 */
export const ResponseMetadataSchema = z
    .object(responseMetadataShape)
    .passthrough();

/**
 * @api.operationId: postChat
 * @api.path: POST /api/chat
 */
export const PostChatRequestSchema = z
    .object({
        surface: ChatSurfaceSchema,
        profileId: ChatProfileIdSchema.optional(),
        generation: z
            .object({
                reasoningEffort: z
                    .enum(['minimal', 'low', 'medium', 'high'])
                    .optional(),
                verbosity: z.enum(['low', 'medium', 'high']).optional(),
            })
            .strict()
            .optional(),
        trigger: z
            .object({
                kind: ChatTriggerKindSchema,
                messageId: z.string().min(1).optional(),
            })
            .strict(),
        latestUserInput: z.string().min(1).max(3072),
        conversation: z.array(ChatConversationMessageSchema).min(1).max(64),
        attachments: z.array(ChatAttachmentSchema).max(8).optional(),
        capabilities: ChatCapabilitiesSchema.optional(),
        sessionId: z.string().min(1).max(128).optional(),
        surfaceContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
                userId: z.string().min(1).optional(),
                requestHost: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

/**
 * @api.operationId: postChat
 * @api.path: POST /api/chat
 */
export const PostChatResponseSchema = z.discriminatedUnion('action', [
    z
        .object({
            action: z.literal('message'),
            message: z.string(),
            modality: z.enum(['text', 'tts']),
            metadata: ResponseMetadataSchema,
        })
        .passthrough(),
    z
        .object({
            action: z.literal('react'),
            reaction: z.string().min(1),
            metadata: z.null(),
        })
        .passthrough(),
    z
        .object({
            action: z.literal('ignore'),
            metadata: z.null(),
        })
        .passthrough(),
    z
        .object({
            action: z.literal('image'),
            imageRequest: ChatImageRequestSchema,
            metadata: z.null(),
        })
        .passthrough(),
]);

/**
 * @api.operationId: getChatProfiles
 * @api.path: GET /api/chat/profiles
 */
export const GetChatProfilesResponseSchema = z
    .object({
        profiles: z
            .array(
                z
                    .object({
                        id: z.string().min(1),
                        description: z.string().min(1).optional(),
                    })
                    .strict()
            )
            .max(100),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalNewsTaskRequestSchema = z
    .object({
        task: z.literal('news'),
        query: z.string().min(1).max(512).optional(),
        category: z.string().min(1).max(128).optional(),
        maxResults: z.number().int().min(1).max(5).optional(),
        reasoningEffort: z
            .enum(['minimal', 'low', 'medium', 'high'])
            .optional(),
        verbosity: z.enum(['low', 'medium', 'high']).optional(),
        channelContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalNewsTaskResponseSchema = z
    .object({
        task: z.literal('news'),
        result: z
            .object({
                news: z.array(InternalNewsItemSchema),
                summary: z.string(),
            })
            .strict(),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalImageDescriptionTaskRequestSchema = z
    .object({
        task: z.literal('image_description'),
        imageUrl: z.string().url(),
        context: z.string().min(1).max(4096).optional(),
        channelContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

/**
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalImageDescriptionTaskResponseSchema = z
    .object({
        task: z.literal('image_description'),
        result: z
            .object({
                description: z.string().min(1),
                model: z.string().min(1),
                usage: z
                    .object({
                        inputTokens: z.number().int().nonnegative(),
                        outputTokens: z.number().int().nonnegative(),
                        totalTokens: z.number().int().nonnegative(),
                    })
                    .strict(),
                costs: z
                    .object({
                        input: z.number().nonnegative(),
                        output: z.number().nonnegative(),
                        total: z.number().nonnegative(),
                    })
                    .strict(),
            })
            .strict(),
    })
    .strict();

/**
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageGenerateRequestSchema = z
    .object({
        task: z.literal('generate'),
        prompt: z.string().min(1).max(8000),
        textModel: z.enum(internalImageTextModels),
        imageModel: z.enum(internalImageRenderModels),
        size: z.enum(['1024x1024', '1024x1536', '1536x1024', 'auto']),
        quality: z.enum(['low', 'medium', 'high', 'auto']),
        background: z.enum(['auto', 'transparent', 'opaque']),
        style: z.string().min(1).max(100),
        allowPromptAdjustment: z.boolean(),
        outputFormat: z.enum(supportedImageOutputFormats),
        outputCompression: z.number().int().min(0).max(100),
        user: z
            .object({
                username: z.string().min(1).max(128),
                nickname: z.string().min(1).max(128),
                guildName: z.string().min(1).max(256),
            })
            .strict(),
        followUpResponseId: z.string().min(1).optional(),
        stream: z.boolean().optional(),
        channelContext: z
            .object({
                channelId: z.string().min(1).optional(),
                guildId: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

const InternalImageAnnotationsSchema = z
    .object({
        title: z.string().nullable(),
        description: z.string().nullable(),
        note: z.string().nullable(),
        adjustedPrompt: z.string().nullable().optional(),
    })
    .strict();

/**
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageGenerateResponseSchema = z
    .object({
        task: z.literal('generate'),
        result: z
            .object({
                responseId: z.string().min(1).nullable(),
                textModel: z.enum(internalImageTextModels),
                imageModel: z.enum(internalImageRenderModels),
                revisedPrompt: z.string().nullable(),
                finalStyle: z.string().min(1),
                annotations: InternalImageAnnotationsSchema,
                finalImageBase64: z.string().min(1),
                outputFormat: z.enum(supportedImageOutputFormats),
                outputCompression: z.number().int().min(0).max(100),
                usage: z
                    .object({
                        inputTokens: z.number().int().nonnegative(),
                        outputTokens: z.number().int().nonnegative(),
                        totalTokens: z.number().int().nonnegative(),
                        imageCount: z.number().int().nonnegative(),
                    })
                    .strict(),
                costs: z
                    .object({
                        text: z.number().nonnegative(),
                        image: z.number().nonnegative(),
                        total: z.number().nonnegative(),
                        perImage: z.number().nonnegative(),
                    })
                    .strict(),
                generationTimeMs: z.number().int().nonnegative(),
            })
            .strict(),
    })
    .strict();

/**
 * Endpoint-level request union for trusted internal image tasks. This stays
 * narrow on purpose and currently includes the `generate` task only.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageRequestSchema = z.discriminatedUnion('task', [
    PostInternalImageGenerateRequestSchema,
]);

/**
 * Endpoint-level response union for trusted internal image tasks.
 *
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const PostInternalImageResponseSchema = z.discriminatedUnion('task', [
    PostInternalImageGenerateResponseSchema,
]);

/**
 * @api.operationId: postInternalImageTask
 * @api.path: POST /api/internal/image
 */
export const InternalImageStreamEventSchema = z.discriminatedUnion('type', [
    z
        .object({
            type: z.literal('partial_image'),
            index: z.number().int().nonnegative(),
            base64: z.string().min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal('result'),
            task: z.literal('generate'),
            result: PostInternalImageGenerateResponseSchema.shape.result,
        })
        .strict(),
    z
        .object({
            type: z.literal('error'),
            error: z.string().min(1),
        })
        .strict(),
]);

/**
 * Endpoint-level request union for trusted internal text tasks. This stays
 * narrow on purpose and includes only purpose-built backend helpers.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalTextRequestSchema = z.discriminatedUnion('task', [
    PostInternalNewsTaskRequestSchema,
    PostInternalImageDescriptionTaskRequestSchema,
]);

/**
 * Endpoint-level response union for trusted internal text tasks.
 *
 * @api.operationId: postInternalTextTask
 * @api.path: POST /api/internal/text
 */
export const PostInternalTextResponseSchema = z.discriminatedUnion('task', [
    PostInternalNewsTaskResponseSchema,
    PostInternalImageDescriptionTaskResponseSchema,
]);

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export const PostTracesRequestSchema = z.object(responseMetadataShape).strict();

/**
 * @api.operationId: postTraces
 * @api.path: POST /api/traces
 */
export const PostTracesResponseSchema = z
    .object({
        ok: z.literal(true),
        responseId: z.string().min(1),
    })
    .passthrough();

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export const PostTraceCardRequestSchema = z
    .object({
        responseId: z.string().min(1).optional(),
        temperament: PartialResponseTemperamentSchema.optional(),
        chips: TraceCardChipDataSchema.optional(),
    })
    .strict();

/**
 * @api.operationId: postTraceCards
 * @api.path: POST /api/trace-cards
 */
export const PostTraceCardResponseSchema = z
    .object({
        responseId: z.string().min(1),
        pngBase64: z.string().min(1),
    })
    .passthrough();

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export const PostTraceCardFromTraceRequestSchema = z
    .object({
        responseId: z.string().min(1),
    })
    .strict();

/**
 * @api.operationId: postTraceCardsFromTrace
 * @api.path: POST /api/trace-cards/from-trace
 */
export const PostTraceCardFromTraceResponseSchema = PostTraceCardResponseSchema;

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export const GetTraceResponseSchema = ResponseMetadataSchema;

/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export const GetTraceStaleResponseSchema = z
    .object({
        message: z.literal('Trace is stale'),
        metadata: ResponseMetadataSchema,
    })
    .passthrough();

/**
 * Trace reads can return either live metadata or a stale envelope depending on status.
 */
export const GetTraceApiResponseSchema = z.union([
    GetTraceResponseSchema,
    GetTraceStaleResponseSchema,
]);

/**
 * Shared API error envelope for normalized server-side error responses.
 */
export const ApiErrorResponseSchema = z
    .object({
        error: z.string(),
        details: z.string().optional(),
        retryAfter: z.number().int().nonnegative().optional(),
    })
    .strict();

const IncidentPointersSchema = z
    .object({
        responseId: z.string().min(1).optional(),
        guildId: z.string().min(1).optional(),
        channelId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        modelVersion: z.string().min(1).optional(),
        chainHash: z.string().min(1).optional(),
    })
    .strict();

const IncidentAuditEventSchema = z
    .object({
        action: IncidentAuditActionSchema,
        actorHash: z.string().min(1).nullable().optional(),
        notes: z.string().min(1).nullable().optional(),
        createdAt: z.string().datetime(),
    })
    .strict();

const IncidentRemediationSchema = z
    .object({
        state: IncidentRemediationStateSchema,
        applied: z.boolean(),
        notes: z.string().min(1).nullable().optional(),
        updatedAt: z.string().datetime().nullable().optional(),
    })
    .strict();

const IncidentSummarySchema = z
    .object({
        incidentId: z.string().min(1),
        status: IncidentStatusSchema,
        tags: z.array(z.string().min(1)),
        description: z.string().min(1).nullable().optional(),
        contact: z.string().min(1).nullable().optional(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        consentedAt: z.string().datetime(),
        pointers: IncidentPointersSchema,
        remediation: IncidentRemediationSchema,
    })
    .strict();

const IncidentDetailSchema = IncidentSummarySchema.extend({
    auditEvents: z.array(IncidentAuditEventSchema),
}).strict();

/**
 * @api.operationId: postIncidentReport
 * @api.path: POST /api/incidents/report
 */
export const PostIncidentReportRequestSchema = z
    .object({
        reporterUserId: z.string().min(1),
        guildId: z.string().min(1).optional(),
        channelId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        jumpUrl: z.string().url().optional(),
        responseId: z.string().min(1).optional(),
        chainHash: z.string().min(1).optional(),
        modelVersion: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).max(25).optional(),
        description: z.string().trim().min(1).max(2000).optional(),
        contact: z.string().trim().min(1).max(500).optional(),
        consentedAt: z.string().datetime(),
    })
    .strict();

/**
 * @api.operationId: postIncidentReport
 * @api.path: POST /api/incidents/report
 */
export const PostIncidentReportResponseSchema = z
    .object({
        incident: IncidentDetailSchema,
        remediation: z
            .object({
                state: z.literal('pending'),
            })
            .strict(),
    })
    .strict();

/**
 * @api.operationId: listIncidents
 * @api.path: GET /api/incidents
 */
export const GetIncidentsResponseSchema = z
    .object({
        incidents: z.array(IncidentSummarySchema),
    })
    .strict();

/**
 * @api.operationId: getIncident
 * @api.path: GET /api/incidents/{incidentId}
 */
export const GetIncidentResponseSchema = z
    .object({
        incident: IncidentDetailSchema,
    })
    .strict();

/**
 * @api.operationId: postIncidentStatus
 * @api.path: POST /api/incidents/{incidentId}/status
 */
export const PostIncidentStatusRequestSchema = z
    .object({
        status: IncidentStatusSchema,
        actorUserId: z.string().min(1).optional(),
        notes: z.string().max(2000).optional(),
    })
    .strict();

/**
 * @api.operationId: postIncidentStatus
 * @api.path: POST /api/incidents/{incidentId}/status
 */
export const PostIncidentStatusResponseSchema = GetIncidentResponseSchema;

/**
 * @api.operationId: postIncidentNotes
 * @api.path: POST /api/incidents/{incidentId}/notes
 */
export const PostIncidentNotesRequestSchema = z
    .object({
        actorUserId: z.string().min(1).optional(),
        notes: z.string().trim().min(1).max(2000),
    })
    .strict();

/**
 * @api.operationId: postIncidentNotes
 * @api.path: POST /api/incidents/{incidentId}/notes
 */
export const PostIncidentNotesResponseSchema = GetIncidentResponseSchema;

/**
 * @api.operationId: postIncidentRemediation
 * @api.path: POST /api/incidents/{incidentId}/remediation
 */
export const PostIncidentRemediationRequestSchema = z
    .object({
        actorUserId: z.string().min(1).optional(),
        state: z.enum([
            'applied',
            'already_marked',
            'skipped_not_assistant',
            'failed',
        ]),
        notes: z.string().max(2000).optional(),
    })
    .strict();

/**
 * @api.operationId: postIncidentRemediation
 * @api.path: POST /api/incidents/{incidentId}/remediation
 */
export const PostIncidentRemediationResponseSchema = GetIncidentResponseSchema;

const formatSchemaIssues = (error: z.ZodError): string => {
    const firstIssue = error.issues[0];
    if (!firstIssue) {
        return 'Response payload did not match the expected schema.';
    }

    const issuePath =
        firstIssue.path.length > 0 ? firstIssue.path.join('.') : 'body';
    return `${issuePath}: ${firstIssue.message}`;
};

export const createSchemaResponseValidator =
    <TSchema extends z.ZodTypeAny>(schema: TSchema) =>
    (data: unknown): ApiResponseValidationResult<z.output<TSchema>> => {
        const parsed = schema.safeParse(data);
        if (parsed.success) {
            return {
                success: true,
                data: parsed.data,
            };
        }

        return {
            success: false,
            error: formatSchemaIssues(parsed.error),
        };
    };
