/**
 * @description: Shared workflow receipt helpers for web and Discord provenance surfaces.
 * @footnote-scope: interface
 * @footnote-module: WorkflowReceiptFormatting
 * @footnote-risk: medium - Incorrect mapping can misstate workflow path details in user-visible receipts.
 * @footnote-ethics: high - Receipt copy influences user trust, so language must remain conservative and non-overclaiming.
 */

import type {
    ExecutionEvent,
    ResponseMetadata,
    ToolExecutionEvent,
    WorkflowModeId,
} from './types.js';
import { deriveReviewRuntimeSummary } from './reviewRuntime.js';

const WORKFLOW_MODE_LABELS: Record<WorkflowModeId, string> = {
    fast: 'Fast mode',
    balanced: 'Balanced mode',
    grounded: 'Grounded mode',
};

export type GroundingEvidenceSummary = {
    status: 'sources_attached' | 'evidence_unavailable' | 'not_recorded';
    label: string;
    explanation: string;
};

const SEARCH_UNSUPPORTED_REASON_CODE =
    'search_not_supported_by_selected_profile';

const isSearchUnsupportedToolEvent = (
    event: ExecutionEvent
): event is ToolExecutionEvent =>
    event.kind === 'tool' &&
    event.toolName === 'web_search' &&
    event.status === 'skipped' &&
    event.reasonCode === SEARCH_UNSUPPORTED_REASON_CODE;

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
 * - Prefer backend-provided normalized reviewRuntime labels.
 * - Fall back to deterministic derivation only for legacy traces.
 * - Keep copy conservative and path-focused.
 */
export const resolveReviewReceipt = (
    metadata: ResponseMetadata
): string | null => {
    const reviewRuntime =
        metadata.reviewRuntime ?? deriveReviewRuntimeSummary(metadata);
    if (reviewRuntime.label === 'reviewed_no_revision') {
        return 'Reviewed before final answer';
    }
    if (reviewRuntime.label === 'revised') {
        return 'Reviewed and revised before final answer';
    }
    if (reviewRuntime.label === 'skipped') {
        return 'Review skipped';
    }
    if (reviewRuntime.label === 'fallback') {
        return 'Review fallback';
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
 * Returns a conservative grounding-evidence summary derived only from
 * citations, provenanceAssessment, and explicit execution reason codes.
 *
 * Rules:
 * - Citations are the clearest user-visible evidence signal, so prefer them.
 * - If metadata explicitly records that retrieval ran without surviving
 *   citations, or that search support was unavailable, surface that as an
 *   evidence-unavailable state.
 * - Otherwise stay conservative and say evidence is not recorded rather than
 *   inferring it from mode names or posture labels.
 */
export const summarizeGroundingEvidence = (
    metadata: ResponseMetadata
): GroundingEvidenceSummary => {
    if (metadata.citations.length > 0) {
        const sourceCount = metadata.citations.length;
        return {
            status: 'sources_attached',
            label: 'Sources attached',
            explanation:
                sourceCount === 1
                    ? 'This trace includes 1 citation for inspection.'
                    : `This trace includes ${sourceCount} citations for inspection.`,
        };
    }

    const provenanceAssessment = metadata.provenanceAssessment;
    const retrievalWithoutCitations =
        provenanceAssessment?.conflicts.includes(
            'retrieval_used_without_citations'
        ) ?? false;
    if (retrievalWithoutCitations) {
        return {
            status: 'evidence_unavailable',
            label: 'Grounding evidence unavailable',
            explanation:
                provenanceAssessment?.limitations.find((limitation) =>
                    limitation
                        .toLowerCase()
                        .includes('no citations were retained')
                ) ??
                'Retrieval ran, but no citations were retained after normalization.',
        };
    }

    const searchUnsupported =
        metadata.execution?.some(isSearchUnsupportedToolEvent) ?? false;
    if (searchUnsupported) {
        return {
            status: 'evidence_unavailable',
            label: 'Grounding evidence unavailable',
            explanation:
                'Search was unavailable for the selected profile, so no source links were attached.',
        };
    }

    const retrievalRequestedButUnused =
        provenanceAssessment?.signals.retrievalRequested === true &&
        provenanceAssessment.signals.retrievalUsed === false;
    if (retrievalRequestedButUnused) {
        return {
            status: 'evidence_unavailable',
            label: 'Grounding evidence unavailable',
            explanation:
                provenanceAssessment?.limitations.find((limitation) =>
                    limitation
                        .toLowerCase()
                        .includes('retrieval was requested but not used')
                ) ??
                'Retrieval was requested but not used by execution, reducing grounding confidence.',
        };
    }

    return {
        status: 'not_recorded',
        label: 'Grounding evidence not recorded',
        explanation:
            'This trace does not include citations or an explicit evidence-unavailable state.',
    };
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
        (() => {
            const groundingEvidenceSummary =
                summarizeGroundingEvidence(metadata);
            if (groundingEvidenceSummary.status === 'not_recorded') {
                return null;
            }

            return groundingEvidenceSummary.label;
        })(),
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
