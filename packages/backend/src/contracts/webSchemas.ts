/**
 * @description: Backend runtime validation schemas for reflect and trace routes.
 * @arete-scope: interface
 * @arete-module: BackendWebRouteSchemas
 * @arete-risk: moderate - Schema drift can reject valid requests or admit invalid payloads.
 * @arete-ethics: moderate - Validation quality affects provenance integrity and user trust.
 */

import { z } from 'zod';

// Temporary copy of packages/contracts/src/web/schemas.ts.
// For now, keep both files in sync.
// Later, the backend should use the shared runtime schemas directly.

const ProvenanceSchema = z.enum(['Retrieved', 'Inferred', 'Speculative']);
const RiskTierSchema = z.enum(['Low', 'Medium', 'High']);

const CitationSchema = z
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

// Trace/read payloads stay tolerant so future metadata fields do not break retrieval.
export const ResponseMetadataSchema = z
    .object(responseMetadataShape)
    .passthrough();

// Reflect request payloads are strict to keep the input contract explicit.
export const PostReflectRequestSchema = z
    .object({
        question: z.string().min(1).max(3072),
    })
    .strict();

// Trace upsert payloads are strict so backend only accepts known ingestion fields.
export const PostTracesRequestSchema = z.object(responseMetadataShape).strict();
