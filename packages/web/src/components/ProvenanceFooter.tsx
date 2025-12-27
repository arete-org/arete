import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { ResponseMetadata, RiskTier, Citation } from '@arete/backend/ethics-core';

interface ProvenanceFooterProps {
  metadata?: ResponseMetadata | null;
}

// Risk tier colors matching the ethics-core constants
const RISK_TIER_COLORS: Record<RiskTier, string> = {
  Low: '#7FDCA4',     // Sage green
  Medium: '#F8E37C',  // Warm gold
  High: '#E27C7C'     // Soft coral
};

const ProvenanceFooter = ({ metadata }: ProvenanceFooterProps): JSX.Element | null => {
  if (!metadata) {
    return null;
  }

  // Extract risk tier color based on riskTier (matching ethics-core)
  const riskTierColor = RISK_TIER_COLORS[metadata.riskTier] || RISK_TIER_COLORS.Low;
  const riskStyle = { '--risk-color': riskTierColor } as CSSProperties;

  // Format confidence as percentage if available
  const formatConfidence = (confidence: number): string => {
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      return 'Confidence data unavailable';
    }
    return `${Math.round(confidence * 100)}% confidence`;
  };

  const confidenceText = formatConfidence(metadata.confidence);

  // Format trade-offs text if any
  const tradeOffsText = metadata.tradeoffCount > 0 ? `${metadata.tradeoffCount} trade-off(s) considered` : '';

  // Process citations with safe URL parsing
  const citations: JSX.Element[] = [];
  if (metadata.citations && metadata.citations.length > 0) {
    metadata.citations.forEach((citation: Citation, index: number) => {
      try {
        const url = citation.url instanceof URL ? citation.url : new URL(citation.url);
        const hostname = url.hostname.replace('www.', '');
        const href = typeof citation.url === 'string' ? citation.url : citation.url.toString();
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
        console.warn('Skipping malformed citation URL:', citation.url, error);
      }
    });
  }

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
        <span className="provenance-confidence">{confidenceText}</span>
        {metadata.riskTier && (
          <>
            <span className="provenance-separator"> • </span>
            <span className="provenance-risktier">{metadata.riskTier} risk</span>
          </>
        )}
        {tradeOffsText && (
          <>
            <span className="provenance-separator"> • </span>
            <span className="provenance-tradeoffs">{tradeOffsText}</span>
          </>
        )}
        {citations.length > 0 && (
          <>
            <span className="provenance-separator"> • </span>
            <span className="provenance-citations-label">Sources: </span>
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
        {metadata.modelVersion && metadata.modelVersion.trim() !== '' && (
          <>
            <span className="provenance-model">{metadata.modelVersion}</span>
            <span className="provenance-separator"> • </span>
          </>
        )}
        {metadata.chainHash && metadata.chainHash.trim() !== '' && (
          <>
            <span className="provenance-hash">{metadata.chainHash}</span>
            <span className="provenance-separator"> • </span>
          </>
        )}
        {metadata.responseId && metadata.responseId.trim() !== '' && (
          <>
            <span className="provenance-id">{metadata.responseId}</span>
            <span className="provenance-separator"> • </span>
          </>
        )}
        {metadata.licenseContext && metadata.licenseContext.trim() !== '' && (
          <span className="provenance-license">{metadata.licenseContext}</span>
        )}
        {metadata.responseId && metadata.responseId.trim() !== '' && (
          <Link 
            to={`/trace/${metadata.responseId}`} 
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

