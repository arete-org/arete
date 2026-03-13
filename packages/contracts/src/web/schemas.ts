/**
 * @description: Runtime schemas for high-value web API routes (reflect + traces).
 * @footnote-scope: interface
 * @footnote-module: WebContractSchemas
 * @footnote-risk: medium - Schema drift can reject valid traffic or allow invalid payloads.
 * @footnote-ethics: medium - Validation quality affects provenance clarity and user trust.
 */

import { z } from 'zod';
import type { TraceAxisScore } from '../ethics-core';
import type { ApiResponseValidationResult } from './client-core';

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
const ReflectSurfaceSchema = z.enum(['web', 'discord']);
const ReflectTriggerKindSchema = z.enum([
    'submit',
    'direct',
    'invoked',
    'catchup',
]);
const ReflectConversationMessageSchema = z
    .object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
        authorName: z.string().min(1).optional(),
        authorId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        createdAt: z.string().min(1).optional(),
    })
    .strict();
const ReflectAttachmentSchema = z
    .object({
        kind: z.literal('image'),
        url: z.string().url(),
        contentType: z.string().min(1).optional(),
    })
    .strict();
const ReflectCapabilitiesSchema = z
    .object({
        canReact: z.boolean(),
        canGenerateImages: z.boolean(),
        canUseTts: z.boolean(),
    })
    .strict();
const ReflectImageRequestSchema = z
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

const responseMetadataShape = {
    responseId: z.string().min(1),
    provenance: ProvenanceSchema,
    riskTier: RiskTierSchema,
    tradeoffCount: z.number().nonnegative(),
    chainHash: z.string(),
    licenseContext: z.string(),
    modelVersion: z.string(),
    staleAfter: z.string(),
    citations: z.array(CitationSchema),
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
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export const PostReflectRequestSchema = z
    .object({
        surface: ReflectSurfaceSchema,
        trigger: z
            .object({
                kind: ReflectTriggerKindSchema,
                messageId: z.string().min(1).optional(),
            })
            .strict(),
        latestUserInput: z.string().min(1).max(3072),
        conversation: z.array(ReflectConversationMessageSchema).min(1).max(64),
        attachments: z.array(ReflectAttachmentSchema).max(8).optional(),
        capabilities: ReflectCapabilitiesSchema.optional(),
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
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export const PostReflectResponseSchema = z.discriminatedUnion('action', [
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
            imageRequest: ReflectImageRequestSchema,
            metadata: z.null(),
        })
        .passthrough(),
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
        description: z.string().max(2000).optional(),
        contact: z.string().max(500).optional(),
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
