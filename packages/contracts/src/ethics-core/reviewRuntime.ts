/**
 * @description: Normalizes review-runtime path signals into a compact label
 * for UI rendering without inferring semantics from raw workflow steps.
 * @footnote-scope: interface
 * @footnote-module: ReviewRuntimeSummary
 * @footnote-risk: medium - Incorrect label mapping can misstate what runtime path executed.
 * @footnote-ethics: high - Review labels influence user trust, so semantics must stay conservative and path-only.
 */

import type { ResponseMetadata, ReviewRuntimeSummary } from './types.js';

/**
 * Returns true when planner fallback was explicitly recorded in workflow
 * lineage or planner execution events.
 */
const hasPlannerFallbackSignal = (
    metadata: Pick<ResponseMetadata, 'workflow' | 'execution'>
): boolean => {
    const plannerFallbackInWorkflow =
        metadata.workflow?.steps?.some((step) => {
            if (step.stepKind !== 'plan') {
                return false;
            }
            if (
                step.reasonCode === 'planner_runtime_error' ||
                step.reasonCode === 'planner_invalid_output'
            ) {
                return true;
            }
            return step.outcome.signals?.contractType === 'fallback';
        }) ?? false;

    const plannerFallbackInExecution =
        metadata.execution?.some((event) => {
            if (event.kind !== 'planner') {
                return false;
            }
            if (event.contractType === 'fallback') {
                return true;
            }
            return (
                event.reasonCode === 'planner_runtime_error' ||
                event.reasonCode === 'planner_invalid_output'
            );
        }) ?? false;

    return plannerFallbackInWorkflow || plannerFallbackInExecution;
};

/**
 * Returns true when runtime explicitly recorded fail-open generation fallback.
 */
const hasInternalGenerationFallbackSignal = (
    metadata: Pick<ResponseMetadata, 'execution'>
): boolean =>
    metadata.execution?.some(
        (event) =>
            event.kind === 'generation' &&
            (event.profileId === 'workflow_internal_fallback' ||
                event.effectiveProfileId === 'workflow_internal_fallback')
    ) ?? false;

/**
 * Derives a conservative, path-semantics-only review runtime summary for UI.
 *
 * Label semantics:
 * - not_reviewed: no bounded review pass was observed.
 * - reviewed_no_revision: assess step executed and no revise step executed.
 * - revised: review pass executed and at least one revise step executed.
 * - skipped: review pass was expected but did not execute.
 * - fallback: fail-open/fallback path was explicitly recorded.
 */
export const deriveReviewRuntimeSummary = (
    metadata: Pick<ResponseMetadata, 'workflow' | 'workflowMode' | 'execution'>
): ReviewRuntimeSummary => {
    const assessExecuted =
        metadata.workflow?.steps?.some(
            (step) =>
                step.stepKind === 'assess' && step.outcome.status === 'executed'
        ) ?? false;
    const assessSkipped =
        metadata.workflow?.steps?.some(
            (step) =>
                step.stepKind === 'assess' && step.outcome.status === 'skipped'
        ) ?? false;
    const reviseExecuted =
        metadata.workflow?.steps?.some(
            (step) =>
                step.stepKind === 'revise' && step.outcome.status === 'executed'
        ) ?? false;
    const reviewPass = metadata.workflowMode?.behavior?.reviewPass;
    const workflowHasAnyStep = (metadata.workflow?.steps?.length ?? 0) > 0;
    const fallbackObserved =
        metadata.workflow?.terminationReason === 'executor_error_fail_open' ||
        hasPlannerFallbackSignal(metadata) ||
        hasInternalGenerationFallbackSignal(metadata);

    if (fallbackObserved) {
        return { label: 'fallback' };
    }

    if (reviseExecuted) {
        return { label: 'revised' };
    }

    if (assessExecuted) {
        return { label: 'reviewed_no_revision' };
    }

    if (assessSkipped || (reviewPass === 'included' && workflowHasAnyStep)) {
        return { label: 'skipped' };
    }

    return { label: 'not_reviewed' };
};
