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
 * Returns the user-facing mode label for the receipt.
 *
 * We only read explicit metadata fields. We do not infer from model names or
 * workflow profile IDs. If fields are missing or unknown, we return `null`.
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
 * Returns the review state line for the receipt.
 *
 * Rules:
 * - Show `Reviewed before final answer` only when an `assess` step actually
 *   ran (status is not `skipped`).
 * - Show `Review skipped` when metadata says review was excluded, or when
 *   review was expected but no review step ran.
 * - Return `null` when metadata is missing or not decisive.
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
 * Returns planner fallback status for the receipt.
 *
 * We only emit `Planner fallback` when fallback is explicitly recorded in
 * workflow plan steps or planner execution events. If not explicit, return
 * `null`.
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
 * Builds receipt lines in a stable order for UI rendering.
 *
 * The copy is intentionally conservative and path-focused. It does not claim
 * correctness, verification, or guarantees.
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
 * Joins receipt lines into one summary sentence for markdown surfaces.
 * Returns `null` when no receipt lines are available.
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
