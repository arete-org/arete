/**
 * TracePage displays the full provenance trace for a bot response, including metadata,
 * citations, and technical details. Handles various states including loading, errors,
 * stale traces, and integrity check failures.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
// Define the actual server response metadata structure
interface ServerMetadata {
  responseId?: string;
  id: string;
  timestamp: string;
  model: string;
  modelVersion?: string;
  provenance?: string;
  riskTier?: string;
  chainHash?: string;
  licenseContext?: string;
  reasoningEffort: string;
  runtimeContext: {
    modelVersion: string;
    conversationSnapshot: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  finishReason?: string;
  staleAfter: string;
  confidence?: number;
  tradeoffCount?: number;
  citations?: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
}

// Reuse the shared provenance contracts, but model the transport layer differences so the
// React page can consume the JSON payload without re-defining the entire schema.
type SerializableResponseMetadata = ServerMetadata;

// Helper to extract payload from 410 (stale) responses
const extractPayload = (data: unknown): ServerMetadata | null => {
  if (data && typeof data === 'object' && 'metadata' in data) {
    const obj = data as { metadata?: ServerMetadata };
    return obj.metadata || null;
  }
  return null;
};

type LoadingState = 'loading' | 'success' | 'error' | 'not-found' | 'stale' | 'hash-mismatch';

// Risk tier colors matching the server constants
const RISK_TIER_COLORS: Record<string, string> = {
  low: '#7FDCA4',    // Low reasoning effort - sage green
  medium: '#F8E37C', // Medium reasoning effort - warm gold  
  high: '#E27C7C'    // High reasoning effort - soft coral
};

const TracePage = (): JSX.Element => {
  const { responseId } = useParams<{ responseId: string }>();
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [traceData, setTraceData] = useState<ServerMetadata | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    if (!responseId) {
      setLoadingState('error');
      setErrorMessage('Trace is missing a response identifier.');
      return;
    }

    let isMounted = true;

    const loadTrace = async () => {
      setLoadingState('loading');
      setErrorMessage('');
      setTraceData(null);

      try {
        console.log('=== Trace Page - Making Request ===');
        console.log('Request URL:', `/trace/${responseId}.json`);
        const response = await fetch(`/trace/${responseId}.json`);
        console.log('Response status:', response.status);
        console.log('Response ok:', response.ok);
        console.log('Response headers:', Object.fromEntries(response.headers.entries()));

        if (response.status === 200) {
          const payload = (await response.json()) as SerializableResponseMetadata;

          // Debug logging
          console.log('=== Trace Page Debug ===');
          console.log('Response ID:', responseId);
          console.log('Payload received:', JSON.stringify(payload, null, 2));
          console.log('Payload confidence:', payload?.confidence);
          console.log('Payload confidence type:', typeof payload?.confidence);
          console.log('Has confidence property:', 'confidence' in payload);
          console.log('Payload keys:', Object.keys(payload));
          console.log('========================');

          if (!isMounted) {
            return;
          }

          console.log('About to set traceData with payload:', payload);
          console.log('Payload confidence before setting:', payload?.confidence);
          setTraceData(payload);
          console.log('traceData state set, confidence should be:', payload?.confidence);
          setLoadingState('success');
          return;
        }

        if (response.status === 404) {
          if (!isMounted) {
            return;
          }

          setLoadingState('not-found');
          return;
        }

        if (response.status === 410) {
          const payload = extractPayload(await response.json().catch(() => null));

          if (!isMounted) {
            return;
          }

          if (payload) {
            setTraceData(payload);
          }

          setLoadingState('stale');
          return;
        }

        if (response.status === 409) {
          if (!isMounted) {
            return;
          }

          setLoadingState('hash-mismatch');
          return;
        }

        const message = await response.text();

        if (!isMounted) {
          return;
        }

        setErrorMessage(message || 'Failed to load trace.');
        setLoadingState('error');

      } catch (error) {
        console.error('=== Trace Page - Error ===');
        console.error('Error:', error);
        console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error);
        console.error('Error message:', error instanceof Error ? error.message : String(error));
        console.error('===========================');
        
        if (!isMounted) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : 'Failed to load trace.');
        setLoadingState('error');
      }
    };

    void loadTrace();

    return () => {
      isMounted = false;
    };
  }, [responseId]);

  // Debug: log traceData whenever it changes
  useEffect(() => {
    console.log('=== traceData State Changed ===');
    console.log('traceData:', traceData);
    console.log('traceData?.confidence:', traceData?.confidence);
    console.log('traceData?.confidence type:', typeof traceData?.confidence);
    if (traceData) {
      console.log('All traceData keys:', Object.keys(traceData));
      console.log('Raw traceData JSON:', JSON.stringify(traceData, null, 2));
    }
    console.log('================================');
  }, [traceData]);

  if (loadingState === 'loading') {
    return (
      <section className="interaction-status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p>Loading trace...</p>
      </section>
    );
  }

  if (loadingState === 'not-found') {
    return (
      <section className="site-section">
        <article className="card">
          <h1>Trace Not Found</h1>
          <p>
            We couldn&apos;t locate a provenance record for response <code>{responseId}</code>.
          </p>
          <Link to="/" className="button-link">
            Back to home
          </Link>
        </article>
      </section>
    );
  }

  if (loadingState === 'error') {
    return (
      <section className="site-section">
        <article className="card">
          <h1>Trace Unavailable</h1>
          <p>{errorMessage || 'Something went wrong while loading this trace.'}</p>
          <Link to="/" className="button-link">
            Back to home
          </Link>
        </article>
      </section>
    );
  }

  if (loadingState === 'stale') {
    return (
      <section className="site-section">
        <article className="card">
          <h1>Trace Stale</h1>
          <p>
            This trace has expired and may no longer be accurate. The information below is displayed for reference only.
          </p>
          <Link to="/" className="button-link">
            Back to home
          </Link>
        </article>
        {traceData && (
          <>
            <header className="site-header" aria-live="polite">
              <div className="site-mark">
                <h1>Response Trace</h1>
                <code>{traceData.id ?? responseId}</code>
              </div>
              <Link to="/" className="button-link">
                Back to home
              </Link>
            </header>
            <article className="card" aria-label="Trace summary">
              <h2>Summary</h2>
              <p>
                <strong>Model:</strong> {traceData.model || 'Unspecified'}
              </p>
              <p>
                <strong>Generated:</strong> {traceData.timestamp ? new Date(traceData.timestamp).toLocaleString() : 'N/A'}
              </p>
            </article>
          </>
        )}
      </section>
    );
  }

  if (loadingState === 'hash-mismatch') {
    return (
      <section className="site-section">
        <article className="card">
          <h1>Trace Integrity Check Failed</h1>
          <p>
            The trace data failed an integrity verification check and may have been tampered with.
          </p>
          <Link to="/" className="button-link">
            Back to home
          </Link>
        </article>
      </section>
    );
  }

  if (!traceData) {
    return (
      <section className="site-section">
        <article className="card">
          <h1>Trace Unavailable</h1>
          <p>No trace data available.</p>
          <Link to="/" className="button-link">
            Back to home
          </Link>
        </article>
      </section>
    );
  }

  const rawRiskTier = traceData?.riskTier || 'low';
  const normalizedRiskTier = typeof rawRiskTier === 'string' ? rawRiskTier.toLowerCase() : 'low';
  const riskTier = rawRiskTier || 'low';
  const riskColor = RISK_TIER_COLORS[normalizedRiskTier] ?? '#6b7280';
  const provenance = traceData?.provenance || traceData?.reasoningEffort || 'Unknown';
  const model = traceData?.model || traceData?.modelVersion || 'Unspecified';
  const riskLabel = riskTier || 'Unspecified';
  const chainHash = traceData?.chainHash || traceData?.chainHash === '' ? traceData.chainHash : undefined;
  
  // Format confidence as percentage if available
  const formatConfidence = (confidence?: number): string => {
    console.log('=== Formatting Confidence ===');
    console.log('Input confidence value:', confidence);
    console.log('Input type:', typeof confidence);
    console.log('traceData object:', traceData);
    console.log('traceData.confidence:', traceData?.confidence);
    
    if (typeof confidence === 'number' && !isNaN(confidence) && confidence >= 0 && confidence <= 1) {
      const result = `${Math.round(confidence * 100)}%`;
      console.log('Confidence formatted as:', result);
      return result;
    }
    console.log('Confidence validation failed - returning unavailable');
    console.log('Confidence value that failed:', confidence);
    console.log('Is number?', typeof confidence === 'number');
    console.log('Is NaN?', isNaN(confidence as number));
    console.log('Range check:', confidence !== undefined ? `${confidence} >= 0 && ${confidence} <= 1 = ${(confidence as number) >= 0 && (confidence as number) <= 1}` : 'undefined');
    return 'Confidence data unavailable';
  };
  const confidence = formatConfidence(traceData?.confidence);
  console.log('=== Final Confidence Result ===');
  console.log('Final confidence string:', confidence);
  const tradeoffCount = traceData?.tradeoffCount ?? 0;
  const staleAfter = traceData?.staleAfter
    ? new Date(traceData.staleAfter).toLocaleString()
    : 'N/A';
  const displayId = traceData?.id || traceData?.responseId || responseId;

  return (
    <section className="site-section">

      <header className="site-header" aria-live="polite">
        <div className="site-mark">
          <h1>Response Trace</h1>
          <code>{displayId}</code>
        </div>
        <Link to="/" className="button-link">
          Back to home
        </Link>
      </header>

      <article className="card" style={{ borderLeft: `4px solid ${riskColor}` }} aria-label="Trace summary">
        <h2>Summary</h2>
        <p>
          <strong>Provenance:</strong> {provenance}
        </p>
        <p>
          <strong>Confidence:</strong> {confidence}
        </p>
        <p>
          <strong>Risk Tier:</strong>{' '}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                width: '0.75rem',
                height: '0.75rem',
                borderRadius: '9999px',
                backgroundColor: riskColor,
                display: 'inline-block',
              }}
            />
            {riskLabel}
          </span>
        </p>
        <p>
          <strong>Model:</strong> {model}
        </p>
      </article>

      <article className="card" aria-label="Citations">
        <h2>Citations</h2>
        {traceData?.citations && traceData.citations.length > 0 ? (
          <ul>
            {traceData.citations.map((citation, index) => {
              const urlString = typeof citation.url === 'string' 
                ? citation.url 
                : String(citation.url || '');
              return (
                <li key={index}>
                  <a
                    href={urlString}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {citation.title || 'Untitled'}
                  </a>
                  {citation.snippet && (
                    <p style={{ marginTop: '0.25rem', fontSize: '0.875rem', color: '#6b7280' }}>
                      {citation.snippet}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>No citations available for this response.</p>
        )}
      </article>

      <article className="card" aria-label="Technical details">
        <h2>Technical Details</h2>
        <dl>
          <div>
            <dt>Tradeoff Count</dt>
            <dd>{tradeoffCount}</dd>
          </div>
          <div>
            <dt>Chain Hash</dt>
            <dd>
              <code>{chainHash ?? 'Unavailable'}</code>
            </dd>
          </div>
          <div>
            <dt>Stale After</dt>
            <dd>{staleAfter}</dd>
          </div>
          <div>
            <dt>License Context</dt>
            <dd>
              <span>See license strategy for reuse details.</span>{' '}
              <a
                href="https://github.com/arete-org/arete/blob/main/docs/LICENSE_STRATEGY.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                License strategy
              </a>
            </dd>
          </div>
        </dl>
      </article>
    </section>
  );
};

export default TracePage;
