/**
 * @description: Runtime schemas for high-value web API routes (reflect + traces).
 * @footnote-scope: interface
 * @footnote-module: WebContractSchemas
 * @footnote-risk: moderate - Schema drift can reject valid traffic or allow invalid payloads.
 * @footnote-ethics: moderate - Validation quality affects provenance clarity and user trust.
 */

import { z } from 'zod';
import type { ApiResponseValidationResult } from './client-core';

const ProvenanceSchema = z.enum(['Retrieved', 'Inferred', 'Speculative']);
const RiskTierSchema = z.enum(['Low', 'Medium', 'High']);

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
} as const;

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
        question: z.string().min(1).max(3072),
    })
    .strict();

/**
 * @api.operationId: postReflect
 * @api.path: POST /api/reflect
 */
export const PostReflectResponseSchema = z
    .object({
        message: z.string(),
        metadata: ResponseMetadataSchema,
    })
    .passthrough();

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

