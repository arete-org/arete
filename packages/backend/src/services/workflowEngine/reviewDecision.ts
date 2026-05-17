/**
 * @description: Defines review-decision parsing and normalization for reviewed
 * workflow assess outputs.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineReviewDecision
 * @footnote-risk: medium - Invalid parsing can trigger incorrect fail-open behavior.
 * @footnote-ethics: high - Assess decisions control bounded revision/finalize paths.
 */
import { sanitizeReviewModuleIds } from '../reviewModules.js';

export type ReviewDecision = {
    reviewDecision: 'finalize' | 'revise';
    reviewReason: string;
    revisionInstruction?: string;
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

export const parseReviewDecisionOutput = (
    text: string
): ReviewDecision | null => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmed) as {
            reviewDecision?: unknown;
            reviewReason?: unknown;
            revisionInstruction?: unknown;
            moduleHints?: unknown;
            concerns?: unknown;
        };
        if (
            parsed.reviewDecision !== 'finalize' &&
            parsed.reviewDecision !== 'revise'
        ) {
            return null;
        }
        if (
            typeof parsed.reviewReason !== 'string' ||
            parsed.reviewReason.trim().length === 0
        ) {
            return null;
        }
        const rawRevisionInstruction =
            typeof parsed.revisionInstruction === 'string'
                ? parsed.revisionInstruction.trim()
                : undefined;
        if (
            parsed.reviewDecision === 'revise' &&
            (!rawRevisionInstruction || rawRevisionInstruction.length === 0)
        ) {
            return null;
        }
        const moduleHints = Array.isArray(parsed.moduleHints)
            ? sanitizeReviewModuleIds(
                  parsed.moduleHints.filter(
                      (hint): hint is string => typeof hint === 'string'
                  )
              )
            : undefined;
        const concerns =
            parsed.concerns && typeof parsed.concerns === 'object'
                ? (parsed.concerns as Record<string, unknown>)
                : undefined;
        const normalizedConcerns: NonNullable<ReviewDecision['concerns']> = {
            ...(concerns?.length === 'too_long' || concerns?.length === 'ok'
                ? { length: concerns.length as 'too_long' | 'ok' }
                : {}),
            ...(concerns?.style === 'too_stiff' || concerns?.style === 'ok'
                ? { style: concerns.style as 'too_stiff' | 'ok' }
                : {}),
            ...(concerns?.evidence === 'needs_caution' ||
            concerns?.evidence === 'ok'
                ? {
                      evidence: concerns.evidence as 'needs_caution' | 'ok',
                  }
                : {}),
        };

        return {
            reviewDecision: parsed.reviewDecision,
            reviewReason: parsed.reviewReason.trim(),
            ...(rawRevisionInstruction !== undefined && {
                revisionInstruction: rawRevisionInstruction,
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
