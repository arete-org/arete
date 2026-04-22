/**
 * @description: Displays citations and provenance metadata for web responses.
 * @footnote-scope: web
 * @footnote-module: ProvenanceFooter
 * @footnote-risk: medium - Footer rendering bugs can hide provenance signals or show malformed metadata.
 * @footnote-ethics: high - Provenance visibility directly supports transparency, accountability, and informed trust.
 */

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type {
    ResponseMetadata,
    SafetyTier,
    Citation,
    WorkflowModeId,
} from '@footnote/contracts/ethics-core';
import { formatExecutionTimelineSummary } from '@footnote/contracts/ethics-core';

interface ProvenanceFooterProps {
    metadata?: ResponseMetadata | null;
}

// Safety tier colors matching the ethics-core constants
const SAFETY_TIER_COLORS: Record<SafetyTier, string> = {
    Low: '#7FDCA4', // Sage green
    Medium: '#F8E37C', // Warm gold
    High: '#E27C7C', // Soft coral
};

const WORKFLOW_MODE_LABELS: Record<WorkflowModeId, string> = {
    fast: 'Fast mode',
    balanced: 'Balanced mode',
    grounded: 'Grounded mode',
};

const resolveWorkflowModeLabel = (
    metadata: ResponseMetadata
): string | null => {
    const modeId = metadata.workflowMode?.modeId;
    if (modeId) {
        return WORKFLOW_MODE_LABELS[modeId];
    }

    const presetId = metadata.workflowMode?.behavior.executionContractPresetId;
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

const resolveReviewReceipt = (metadata: ResponseMetadata): string | null => {
    const reviewStepRan =
        metadata.workflow?.steps.some(
            (step) =>
                step.stepKind === 'assess' && step.outcome.status !== 'skipped'
        ) ?? false;
    if (reviewStepRan) {
        return 'Reviewed before final answer';
    }

    const reviewPass = metadata.workflowMode?.behavior.reviewPass;
    if (reviewPass === 'excluded') {
        return 'Review skipped';
    }

    if (
        reviewPass === 'included' &&
        metadata.workflow !== undefined &&
        metadata.workflow.steps.length > 0
    ) {
        return 'Review skipped';
    }

    return null;
};

const resolvePlannerFallbackReceipt = (
    metadata: ResponseMetadata
): string | null => {
    const plannerFallbackInWorkflow =
        metadata.workflow?.steps.some((step) => {
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

const ProvenanceFooter = ({
    metadata,
}: ProvenanceFooterProps): JSX.Element | null => {
    if (!metadata) {
        return null;
    }

    // Extract safety tier color based on safetyTier (matching ethics-core)
    const safetyTierColor =
        SAFETY_TIER_COLORS[metadata.safetyTier] || SAFETY_TIER_COLORS.Low;
    const safetyStyle = { '--safety-color': safetyTierColor } as CSSProperties;

    // Format trade-offs text if any
    const tradeOffsText =
        metadata.tradeoffCount > 0
            ? `${metadata.tradeoffCount} trade-off(s) considered`
            : '';

    // Process citations
    const citations: JSX.Element[] = [];
    if (metadata.citations && metadata.citations.length > 0) {
        metadata.citations.forEach((citation: Citation, index: number) => {
            try {
                const url = new URL(citation.url);
                const hostname = url.hostname.replace('www.', '');
                const href = citation.url;
                citations.push(
                    <a
                        key={index}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="provenance-citation-link"
                        aria-label={`Source: ${hostname}`}
                    >
                        {hostname}
                    </a>
                );
            } catch (error) {
                // Skip malformed citation URLs
                console.warn(
                    'Skipping malformed citation URL:',
                    citation.url,
                    error
                );
            }
        });
    }
    const executionSummary = formatExecutionTimelineSummary(
        metadata.execution,
        metadata.workflow
    );
    const workflowModeLabel = resolveWorkflowModeLabel(metadata);
    const reviewReceipt = resolveReviewReceipt(metadata);
    const plannerFallbackReceipt = resolvePlannerFallbackReceipt(metadata);
    const workflowReceiptItems = [
        workflowModeLabel ? `Answered in ${workflowModeLabel}` : null,
        reviewReceipt,
        plannerFallbackReceipt,
    ].filter((item): item is string => item !== null);
    const evaluatorOutcome = metadata.evaluator;
    const searchUnavailableWarning = metadata.execution?.some(
        (event) =>
            event.kind === 'tool' &&
            event.toolName === 'web_search' &&
            event.status === 'skipped' &&
            event.reasonCode === 'search_not_supported_by_selected_profile'
    );
    const safetyDecision = evaluatorOutcome?.safetyDecision;
    const evaluatorAuthority =
        evaluatorOutcome?.authorityLevel ??
        (evaluatorOutcome?.mode === 'enforced'
            ? 'enforce'
            : safetyDecision?.action !== 'allow'
              ? 'influence'
              : 'observe');
    const hasNonAllowSafetyDecision =
        safetyDecision !== undefined && safetyDecision.action !== 'allow';

    return (
        <aside
            className="provenance-footer"
            role="complementary"
            aria-label="Response provenance and metadata"
            style={safetyStyle}
        >
            <div className="provenance-header">
                Reasoning - {metadata.provenance}
            </div>
            {workflowReceiptItems.length > 0 && (
                <div
                    className="provenance-workflow-receipt"
                    role="status"
                    aria-live="polite"
                >
                    {workflowReceiptItems.map((item, index) => (
                        <span key={item}>
                            {item}
                            {index < workflowReceiptItems.length - 1 && (
                                <span className="provenance-separator">
                                    {' '}
                                    •{' '}
                                </span>
                            )}
                        </span>
                    ))}
                </div>
            )}

            <div className="provenance-main">
                {searchUnavailableWarning && (
                    <>
                        <span
                            className="provenance-risktier"
                            role="status"
                            aria-live="polite"
                        >
                            search unavailable for selected model
                        </span>
                        <span className="provenance-separator"> • </span>
                    </>
                )}
                {metadata.safetyTier && (
                    <>
                        <span className="provenance-risktier">
                            {metadata.safetyTier} safety
                        </span>
                    </>
                )}
                {evaluatorOutcome && (
                    <>
                        <span className="provenance-separator"> • </span>
                        <span className="provenance-tradeoffs">
                            {safetyDecision
                                ? `eval ${evaluatorAuthority}/${safetyDecision.safetyTier}/${evaluatorOutcome.provenance}/${safetyDecision.action}${
                                      hasNonAllowSafetyDecision
                                          ? ` (${safetyDecision.ruleId}/${safetyDecision.reasonCode})`
                                          : ''
                                  }`
                                : 'eval unavailable'}
                        </span>
                    </>
                )}
                {tradeOffsText && (
                    <>
                        <span className="provenance-separator"> • </span>
                        <span className="provenance-tradeoffs">
                            {tradeOffsText}
                        </span>
                    </>
                )}
                {citations.length > 0 && (
                    <>
                        <span className="provenance-separator"> • </span>
                        <span className="provenance-citations-label">
                            Sources:{' '}
                        </span>
                        <span className="provenance-citations">
                            {citations.map((citation, index) => (
                                <span key={index}>
                                    {citation}
                                    {index < citations.length - 1 && ' • '}
                                </span>
                            ))}
                        </span>
                    </>
                )}
            </div>

            <div className="provenance-meta">
                {executionSummary ? (
                    <>
                        <span className="provenance-model">
                            {executionSummary}
                        </span>
                        <span className="provenance-separator"> • </span>
                    </>
                ) : (
                    metadata.modelVersion &&
                    metadata.modelVersion.trim() !== '' && (
                        <>
                            <span className="provenance-model">
                                {metadata.modelVersion}
                            </span>
                            <span className="provenance-separator"> • </span>
                        </>
                    )
                )}
                {metadata.chainHash && metadata.chainHash.trim() !== '' && (
                    <>
                        <span className="provenance-hash">
                            {metadata.chainHash}
                        </span>
                        <span className="provenance-separator"> • </span>
                    </>
                )}
                {metadata.totalDurationMs !== undefined && (
                    <>
                        <span className="provenance-duration">
                            {metadata.totalDurationMs}ms total
                        </span>
                        <span className="provenance-separator"> • </span>
                    </>
                )}
                {metadata.responseId && metadata.responseId.trim() !== '' && (
                    <>
                        <span className="provenance-id">
                            {metadata.responseId}
                        </span>
                        <span className="provenance-separator"> • </span>
                    </>
                )}
                {metadata.licenseContext &&
                    metadata.licenseContext.trim() !== '' && (
                        <span className="provenance-license">
                            {metadata.licenseContext}
                        </span>
                    )}
                {metadata.responseId && metadata.responseId.trim() !== '' && (
                    <Link
                        to={`/api/traces/${metadata.responseId}`}
                        className="provenance-link"
                        aria-label="View full trace for this response"
                    >
                        📜 View Full Trace
                    </Link>
                )}
            </div>
        </aside>
    );
};

export default ProvenanceFooter;
