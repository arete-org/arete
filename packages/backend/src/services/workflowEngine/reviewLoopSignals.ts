/**
 * @description: Signal shaping helpers for reviewed assess-loop lineage events.
 * @footnote-scope: core
 * @footnote-module: WorkflowEngineReviewLoopSignals
 * @footnote-risk: low - Signal drift affects observability only.
 * @footnote-ethics: medium - Signal quality influences audit interpretation.
 */
import type { BoundedReviewAssessSignals } from '@footnote/contracts/policy';
import type { ReviewDecision } from './reviewDecision.js';
import { toAssessFinalTemperamentSignals } from '../traceAlignmentSignals.js';

export const buildAssessSignals = (
    decision: ReviewDecision
): BoundedReviewAssessSignals => ({
    reviewDecision: decision.reviewDecision,
    reviewReason: decision.reviewReason,
    // Keep assess signals schema-compatible even when model output omits TRACE
    // alignment details so trace retrieval remains fail-open.
    traceAlignment: decision.traceAlignment ?? 'aligned',
    ...(decision.traceAlignmentReason !== undefined && {
        traceAlignmentReason: decision.traceAlignmentReason,
    }),
    ...toAssessFinalTemperamentSignals(decision.finalTemperament),
    ...(decision.reviewDecision === 'revise' && {
        refinementRequested: true,
        ...(decision.revisionInstruction !== undefined && {
            revisionInstruction: decision.revisionInstruction,
        }),
    }),
    ...(decision.concerns?.length !== undefined && {
        lengthConcern: decision.concerns.length,
    }),
    ...(decision.concerns?.style !== undefined && {
        styleConcern: decision.concerns.style,
    }),
    ...(decision.concerns?.evidence !== undefined && {
        evidenceConcern: decision.concerns.evidence,
    }),
    ...(decision.moduleHints !== undefined && {
        moduleHintCount: decision.moduleHints.length,
    }),
    ...(decision.moduleHints !== undefined &&
        decision.moduleHints.length > 0 && {
            moduleHintIdsCsv: decision.moduleHints.join(','),
        }),
});
