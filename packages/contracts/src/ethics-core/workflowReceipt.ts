/**
 * @description: Shared workflow receipt helpers for web and Discord provenance surfaces.
 * @footnote-scope: interface
 * @footnote-module: WorkflowReceiptFormatting
 * @footnote-risk: medium - Incorrect mapping can misstate workflow path details in user-visible receipts.
 * @footnote-ethics: high - Receipt copy influences user trust, so language must remain conservative and non-overclaiming.
 */

import type { ResponseMetadata, WorkflowModeId } from './types.js';

const WORKFLOW_MODE_LABELS: Record<WorkflowModeId, string> = {
    fast: 'Fast mode',
    balanced: 'Balanced mode',
    grounded: 'Grounded mode',
};

/**
 * Resolves user-facing workflow mode label from explicit metadata only.
 *
 * Authority and decision rules:
 * - Primary: `workflowMode.modeId`.
 * - Fallback: `workflowMode.behavior.executionContractPresetId`.
 * - Fail-open: returns `null` for unknown/missing fields.
 */
export const resolveWorkflowModeLabel = (
    metadata: ResponseMetadata
): string | null => {
    const modeId = metadata.workflowMode?.modeId;
    if (modeId) {
        return WORKFLOW_MODE_LABELS[modeId];
    }

    const presetId = metadata.workflowMode?.behavior?.executionContractPresetId;
    if (presetId === 'fast-direct') {
        return WORKFLOW_MODE_LABELS.fast;
    }
    if (presetId === 'balanced') {
        return WORKFLOW_MODE_LABELS.balanced;
    }
    if (presetId === 'quality-grounded') {
        return WORKFLOW_MODE_LABELS.grounded;
    }

    return null;
};

/**
 * Resolves review receipt state from explicit metadata only.
 *
 * Authority and decision rules:
 * - `Reviewed before final answer` only when an `assess` step ran
 *   (`workflow.steps[].stepKind === "assess"` and status is not `skipped`).
 * - `Review skipped` when `workflowMode.behavior.reviewPass === "excluded"`.
 * - `Review skipped` when review pass is included, workflow has steps, and no
 *   review step ran.
 * - Fail-open: returns `null` when metadata is missing/unknown.
 */
export const resolveReviewReceipt = (
    metadata: ResponseMetadata
): string | null => {
    const reviewStepRan =
        metadata.workflow?.steps?.some(
            (step) =>
                step.stepKind === 'assess' && step.outcome.status !== 'skipped'
        ) ?? false;
    if (reviewStepRan) {
        return 'Reviewed before final answer';
    }

    const reviewPass = metadata.workflowMode?.behavior?.reviewPass;
    if (reviewPass === 'excluded') {
        return 'Review skipped';
    }

    const workflowStepCount = metadata.workflow?.steps?.length ?? 0;
    if (reviewPass === 'included' && workflowStepCount > 0) {
        return 'Review skipped';
    }

    return null;
};

/**
 * Resolves planner-fallback receipt state from explicit metadata only.
 *
 * Authority and decision rules:
 * - Emits `Planner fallback` when workflow plan steps or planner execution
 *   events explicitly record fallback via:
 *   - reasonCode: `planner_runtime_error` / `planner_invalid_output`
 *   - contractType: `fallback`
 * - Fail-open: returns `null` when metadata is missing/unknown.
 */
export const resolvePlannerFallbackReceipt = (
    metadata: ResponseMetadata
): string | null => {
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

    return plannerFallbackInWorkflow || plannerFallbackInExecution
        ? 'Planner fallback'
        : null;
};

/**
 * Builds compact user-facing workflow receipt items from explicit metadata.
 *
 * Returned items are conservative and path-semantic:
 * - `Answered in <mode>`
 * - `Reviewed before final answer` / `Review skipped`
 * - `Planner fallback`
 */
export const buildWorkflowReceiptItems = (
    metadata: ResponseMetadata
): string[] =>
    [
        (() => {
            const modeLabel = resolveWorkflowModeLabel(metadata);
            return modeLabel ? `Answered in ${modeLabel}` : null;
        })(),
        resolveReviewReceipt(metadata),
        resolvePlannerFallbackReceipt(metadata),
    ].filter((item): item is string => item !== null);

/**
 * Builds one markdown-friendly summary line from workflow receipt items.
 *
 * Fail-open behavior: returns `null` when no explicit receipt items are
 * available.
 */
export const buildWorkflowReceiptSummary = (
    metadata: ResponseMetadata
): string | null => {
    const workflowReceiptItems = buildWorkflowReceiptItems(metadata);
    if (workflowReceiptItems.length === 0) {
        return null;
    }

    return workflowReceiptItems.join(' • ');
};
