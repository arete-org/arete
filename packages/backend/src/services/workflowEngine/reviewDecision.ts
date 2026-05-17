/**
 * @description: Defines review-decision parsing and normalization for reviewed
 * workflow assess outputs.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineReviewDecision
 * @footnote-risk: medium - Invalid parsing can trigger incorrect fail-open behavior.
 * @footnote-ethics: high - Assess decisions control bounded revision/finalize paths.
 */
import type {
    PartialResponseTemperament,
    TraceAxisScore,
} from '@footnote/contracts/policy';
import { z } from 'zod';
import { sanitizeReviewModuleIds } from '../reviewModules.js';

export type ReviewDecision = {
    reviewDecision: 'finalize' | 'revise';
    reviewReason: string;
    revisionInstruction?: string;
    traceAlignment?: 'aligned' | 'misaligned';
    traceAlignmentReason?: string;
    finalTemperament?: PartialResponseTemperament;
    moduleHints?: string[];
    concerns?: {
        length?: 'too_long' | 'ok';
        style?: 'too_stiff' | 'ok';
        evidence?: 'needs_caution' | 'ok';
    };
};

export const DEFAULT_REVIEW_DECISION_PROMPT = `Return plain JSON only.
Schema:
{
  "reviewDecision": "finalize" | "revise",
  "reviewReason": "one short sentence",
  "revisionInstruction": "required when reviewDecision is revise",
  "traceAlignment": "aligned" | "misaligned",
  "traceAlignmentReason": "required when traceAlignment is misaligned",
  "finalTemperament": {
    "tightness": 1 | 2 | 3 | 4 | 5,
    "rationale": 1 | 2 | 3 | 4 | 5,
    "attribution": 1 | 2 | 3 | 4 | 5,
    "caution": 1 | 2 | 3 | 4 | 5,
    "extent": 1 | 2 | 3 | 4 | 5
  },
  "moduleHints": ["optional review module ids"],
  "concerns": {
    "length": "too_long" | "ok",
    "style": "too_stiff" | "ok",
    "evidence": "needs_caution" | "ok"
  }
}
Choose "finalize" when the draft is complete, accurate, and ready.
Choose "revise" only when one additional revision would materially improve quality.
Provide concise fields and keep revisionInstruction specific and short.
Do not include markdown or extra keys.`;

export const DEFAULT_REVISION_PROMPT_PREFIX =
    'Revise the prior draft using the review guidance while preserving factual grounding and provenance boundaries.';

const TraceAxisScoreSchema: z.ZodType<TraceAxisScore> = z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
]);

const PartialResponseTemperamentSchema = z
    .object({
        tightness: TraceAxisScoreSchema.optional(),
        rationale: TraceAxisScoreSchema.optional(),
        attribution: TraceAxisScoreSchema.optional(),
        caution: TraceAxisScoreSchema.optional(),
        extent: TraceAxisScoreSchema.optional(),
    })
    .strict();

const ReviewDecisionSchema = z
    .object({
        reviewDecision: z.enum(['finalize', 'revise']),
        reviewReason: z.string().min(1),
        revisionInstruction: z.string().optional(),
        traceAlignment: z.enum(['aligned', 'misaligned']).optional(),
        traceAlignmentReason: z.string().optional(),
        finalTemperament: PartialResponseTemperamentSchema.optional(),
        moduleHints: z.array(z.string()).optional(),
        concerns: z
            .object({
                length: z.enum(['too_long', 'ok']).optional(),
                style: z.enum(['too_stiff', 'ok']).optional(),
                evidence: z.enum(['needs_caution', 'ok']).optional(),
            })
            .strict()
            .optional(),
    })
    .passthrough()
    .superRefine((value, context) => {
        const normalizedRevisionInstruction = value.revisionInstruction?.trim();
        if (
            value.reviewDecision === 'revise' &&
            (!normalizedRevisionInstruction ||
                normalizedRevisionInstruction.length === 0)
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['revisionInstruction'],
                message:
                    'revisionInstruction is required when reviewDecision is "revise".',
            });
        }

        const normalizedTraceAlignmentReason =
            value.traceAlignmentReason?.trim();
        const hasFinalTemperamentAxes =
            value.finalTemperament !== undefined &&
            Object.keys(value.finalTemperament).length > 0;
        if (value.traceAlignment === 'misaligned') {
            if (
                !normalizedTraceAlignmentReason ||
                normalizedTraceAlignmentReason.length === 0
            ) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['traceAlignmentReason'],
                    message:
                        'traceAlignmentReason is required when traceAlignment is "misaligned".',
                });
            }
            if (!hasFinalTemperamentAxes) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['finalTemperament'],
                    message:
                        'finalTemperament must include at least one axis when traceAlignment is "misaligned".',
                });
            }
        }
    });

export const parseReviewDecisionOutput = (
    text: string
): ReviewDecision | null => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return null;
    }

    try {
        const parsedPayload = JSON.parse(trimmed) as unknown;
        const parsedDecision = ReviewDecisionSchema.safeParse(parsedPayload);
        if (!parsedDecision.success) {
            return null;
        }

        const normalizedRevisionInstruction =
            parsedDecision.data.revisionInstruction?.trim();
        const moduleHints = parsedDecision.data.moduleHints
            ? sanitizeReviewModuleIds(parsedDecision.data.moduleHints)
            : undefined;
        const normalizedConcerns: NonNullable<ReviewDecision['concerns']> = {
            ...(parsedDecision.data.concerns?.length !== undefined && {
                length: parsedDecision.data.concerns.length,
            }),
            ...(parsedDecision.data.concerns?.style !== undefined && {
                style: parsedDecision.data.concerns.style,
            }),
            ...(parsedDecision.data.concerns?.evidence !== undefined && {
                evidence: parsedDecision.data.concerns.evidence,
            }),
        };

        return {
            reviewDecision: parsedDecision.data.reviewDecision,
            reviewReason: parsedDecision.data.reviewReason.trim(),
            ...(normalizedRevisionInstruction !== undefined && {
                revisionInstruction: normalizedRevisionInstruction,
            }),
            ...(parsedDecision.data.traceAlignment !== undefined && {
                traceAlignment: parsedDecision.data.traceAlignment,
            }),
            ...(parsedDecision.data.traceAlignmentReason !== undefined && {
                traceAlignmentReason:
                    parsedDecision.data.traceAlignmentReason.trim(),
            }),
            ...(parsedDecision.data.finalTemperament !== undefined && {
                finalTemperament: parsedDecision.data.finalTemperament,
            }),
            ...(moduleHints !== undefined && { moduleHints }),
            ...(Object.keys(normalizedConcerns).length > 0 && {
                concerns: normalizedConcerns,
            }),
        };
    } catch {
        return null;
    }
};
