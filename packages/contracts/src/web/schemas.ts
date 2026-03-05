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
 * TRACE temperament profile captured as five named integer axes:
 * T = tightness, R = rationale, A = attribution, C = caution, E = extent.
 *
 * Axis meanings:
 * - tightness: concision and structural efficiency
 * - rationale: amount of visible rationale and trade-off explanation
 * - attribution: clarity of sourced vs inferred boundaries
 * - caution: safeguard posture and overclaim restraint
 * - extent: breadth of viable options and perspectives
 *
 * Note: runtime schema validation is still required for dynamic payloads.
 *
 * TODO(TRACE-rollout): Make this required once TRACE generation and rendering
 * are fully validated across surfaces.
 */
const TraceAxisScoreSchema: z.ZodType<TraceAxisScore> = z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
    z.literal(9),
    z.literal(10),
]);

// We use literal values (1..10) instead of a broad number schema so Zod output
// matches the TraceAxisScore contract type exactly. Runtime validation still
// protects us from untrusted payloads.
const ResponseTemperamentSchema = z
    .object({
        tightness: TraceAxisScoreSchema,
        rationale: TraceAxisScoreSchema,
        attribution: TraceAxisScoreSchema,
        caution: TraceAxisScoreSchema,
        extent: TraceAxisScoreSchema,
    })
    .strict();

const responseMetadataShape = {
    responseId: z.string().min(1),
    provenance: ProvenanceSchema,
    confidence: z.number().min(0).max(1),
    riskTier: RiskTierSchema,
    tradeoffCount: z.number().nonnegative(),
    chainHash: z.string(),
    licenseContext: z.string(),
    modelVersion: z.string(),
    staleAfter: z.string(),
    citations: z.array(CitationSchema),
    imageDescriptions: z.array(z.string()).optional(),
    temperament: ResponseTemperamentSchema.optional(),
} as const;

const TraceCardChipDataSchema = z
    .object({
        evidenceScore: z.number().min(1).max(5),
        freshnessScore: z.number().min(1).max(5),
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
        conversation: z
            .array(ReflectConversationMessageSchema)
            .min(1)
            .max(64),
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
        temperament: ResponseTemperamentSchema,
        chips: TraceCardChipDataSchema,
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
        chips: TraceCardChipDataSchema,
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
    (
        data: unknown
    ): ApiResponseValidationResult<z.output<TSchema>> => {
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

