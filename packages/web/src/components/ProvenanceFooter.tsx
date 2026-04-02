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

const ProvenanceFooter = ({
    metadata,
}: ProvenanceFooterProps): JSX.Element | null => {
    if (!metadata) {
        return null;
    }

    // Extract safety tier color based on safetyTier (matching ethics-core)
    const safetyTierColor =
        SAFETY_TIER_COLORS[metadata.safetyTier] || SAFETY_TIER_COLORS.Low;
    const riskStyle = { '--risk-color': safetyTierColor } as CSSProperties;

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
    const executionSummary = formatExecutionTimelineSummary(metadata.execution);
    const evaluatorOutcome = metadata.evaluator;
    const searchUnavailableWarning = metadata.execution?.some(
        (event) =>
            event.kind === 'tool' &&
            event.toolName === 'web_search' &&
            event.status === 'skipped' &&
            event.reasonCode === 'search_not_supported_by_selected_profile'
    );
    const safetyDecision = evaluatorOutcome?.safetyDecision;
    const hasNonAllowSafetyDecision =
        safetyDecision !== undefined && safetyDecision.action !== 'allow';

    return (
        <aside
            className="provenance-footer"
            role="complementary"
            aria-label="Response provenance and metadata"
            style={riskStyle}
        >
            <div className="provenance-header">
                Reasoning - {metadata.provenance}
            </div>

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
                                ? `eval ${safetyDecision.safetyTier}/${evaluatorOutcome.provenance}/${safetyDecision.action}${
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
