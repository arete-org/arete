/**
 * @description: Renders the trace view for a response, including provenance metadata, citations, and integrity/status states.
 * @footnote-scope: web
 * @footnote-module: TracePage
 * @footnote-risk: medium - Trace rendering errors can hide provenance signals and mislead users reviewing outputs.
 * @footnote-ethics: high - Provenance visibility directly supports transparency, accountability, and informed trust.
 */
/**
 * TracePage displays the full provenance trace for a bot response, including metadata,
 * citations, and technical details. Handles various states including loading, errors,
 * stale traces, and integrity check failures.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatExecutionTimelineSummary } from '@footnote/contracts/ethics-core';
import type {
    GetTraceResponse,
    GetTraceStaleResponse,
} from '@footnote/contracts/web';
import type {
    ExecutionEvent,
    WorkflowStepKind,
} from '@footnote/contracts/ethics-core';
import { api, isApiClientError } from '../utils/api';
import { createScopedLogger } from '../utils/logger';
import { buildRunOutcomeSummary } from '../utils/traceOutcome';
// Define the actual server response metadata structure
type ServerMetadata = GetTraceResponse & {
    timestamp?: string;
    model?: string;
    reasoningEffort?: string;
    runtimeContext?: {
        modelVersion: string;
        conversationSnapshot: string;
    };
    usage?: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
    };
    finishReason?: string;
};

// Reuse the shared provenance contracts, but model the transport layer differences so the
// React page can consume the JSON payload without re-defining the entire schema.
type SerializableResponseMetadata = ServerMetadata;

type DisplayTrace = {
    responseId: string | null;
    timestamp: string | null;
    provenance: string | null;
    safetyTier: ServerMetadata['safetyTier'] | null;
    modelVersion: string | null;
    tradeoffCount: number | null;
    staleAfter: string | null;
    citationCount: number;
    executionCount: number;
    citations: ServerMetadata['citations'];
    execution: ServerMetadata['execution'];
    evaluator: ServerMetadata['evaluator'] | null;
    runtimeContext: {
        modelVersion: string | null;
        conversationSnapshot: string | null;
    } | null;
};

type SummarySignal = {
    label: string;
    value: string;
    explanation: string;
};

const resolveTraceModelLabel = (traceData: ServerMetadata): string => {
    // Prefer canonical generation event model first, then legacy mirrors.
    const generationEventModel = traceData.execution
        ?.filter((event) => event.kind === 'generation')
        .at(-1)?.model;
    return (
        generationEventModel ||
        traceData.model ||
        traceData.modelVersion ||
        'Unspecified'
    );
};

const resolveExecutionSummary = (traceData: ServerMetadata): string | null =>
    formatExecutionTimelineSummary(traceData.execution, traceData.workflow);

const PROVENANCE_EXPLANATIONS: Record<string, string> = {
    Retrieved:
        'This answer is classified as grounded in retrieved or workflow evidence recorded in this trace.',
    Inferred:
        'This answer combines model reasoning with available context; verify key claims when stakes are high.',
    Speculative:
        'This answer may include uncertain reasoning; treat it as a starting point and verify before relying on it.',
};

const WORKFLOW_MODE_LABELS: Record<string, string> = {
    fast: 'Fast mode',
    balanced: 'Balanced mode',
    grounded: 'Grounded mode',
};

const getProvenanceExplanation = (provenance: string): string =>
    PROVENANCE_EXPLANATIONS[provenance] ??
    'This is the runtime provenance label recorded for this response.';

const getModeSummary = (
    traceData: ServerMetadata
): Pick<SummarySignal, 'value' | 'explanation'> => {
    const modeId = traceData.workflowMode?.modeId;
    if (modeId) {
        const modeValue = WORKFLOW_MODE_LABELS[modeId] ?? modeId;
        const reviewPass = traceData.workflowMode?.behavior.reviewPass;
        const evidencePosture =
            traceData.workflowMode?.behavior.evidencePosture;
        const reviewText =
            reviewPass === 'included'
                ? 'is configured to include a review pass'
                : 'is configured without a review pass';
        const evidenceText = evidencePosture
            ? `and uses a ${evidencePosture} evidence posture`
            : '';
        return {
            value: modeValue,
            explanation: `${modeValue} ran for this response, ${reviewText}${evidenceText}.`,
        };
    }

    if (traceData.workflow?.workflowName) {
        return {
            value: traceData.workflow.workflowName,
            explanation:
                'A workflow record exists, but no explicit mode decision was attached.',
        };
    }

    return {
        value: 'Not recorded',
        explanation:
            'This trace does not include workflow mode metadata, which is common in older records.',
    };
};

const getSourceSummary = (
    traceData: ServerMetadata
): Pick<SummarySignal, 'value' | 'explanation'> => {
    const citationCount = traceData.citations?.length ?? 0;
    if (citationCount > 0) {
        return {
            value:
                citationCount === 1
                    ? '1 source linked'
                    : `${citationCount} sources linked`,
            explanation:
                'Source links are available below for direct inspection.',
        };
    }

    const toolEvents = (traceData.execution ?? []).filter(
        (event): event is ExecutionEvent & { kind: 'tool' } =>
            event.kind === 'tool' && event.toolName === 'web_search'
    );
    const searchUnsupported = toolEvents.some(
        (event) =>
            event.status === 'skipped' &&
            event.reasonCode === 'search_not_supported_by_selected_profile'
    );

    if (searchUnsupported) {
        return {
            value: 'No sources linked',
            explanation:
                'Search was unavailable for the selected profile, so no source links were attached.',
        };
    }

    if (toolEvents.length > 0) {
        return {
            value: 'No sources linked',
            explanation:
                'A tool/search step is recorded, but no source links were attached.',
        };
    }

    return {
        value: 'No sources linked',
        explanation:
            'No source links were attached in this trace. Treat unsupported claims as unverified.',
    };
};

const getSafetySummary = (
    traceData: ServerMetadata,
    safetyLabel: string
): Pick<SummarySignal, 'value' | 'explanation'> => {
    const safetyDecision = traceData.evaluator?.safetyDecision;
    if (safetyDecision) {
        const action =
            safetyDecision.action === 'allow'
                ? 'allowed'
                : `resolved with "${safetyDecision.action}"`;
        return {
            value: `${safetyLabel} (${action})`,
            explanation:
                'Safety tier and evaluator action come from runtime policy checks captured in the trace.',
        };
    }

    return {
        value: safetyLabel,
        explanation:
            'Safety tier is recorded, but detailed evaluator decision metadata is not present on this trace.',
    };
};

const getWorkflowSummary = (
    traceData: ServerMetadata
): Pick<SummarySignal, 'value' | 'explanation'> => {
    const workflow = traceData.workflow;
    if (!workflow) {
        return {
            value: 'No workflow record',
            explanation:
                'This trace has no workflow lineage attached, which can happen for older or direct runs.',
        };
    }

    const reviewStepKinds: WorkflowStepKind[] = ['assess', 'revise'];
    const hasReviewStep = workflow.steps.some((step) =>
        reviewStepKinds.includes(step.stepKind)
    );

    return {
        value: `${workflow.workflowName} (${workflow.status})`,
        explanation: hasReviewStep
            ? 'Review-related workflow steps are present in this trace.'
            : 'Workflow metadata is present, but no explicit review step is recorded.',
    };
};

const buildDisplayTrace = (traceData: ServerMetadata): DisplayTrace => ({
    responseId: traceData.responseId ?? null,
    timestamp: traceData.timestamp ?? null,
    provenance: traceData.provenance ?? null,
    safetyTier: traceData.safetyTier ?? null,
    modelVersion: traceData.modelVersion ?? null,
    tradeoffCount: traceData.tradeoffCount ?? null,
    staleAfter: traceData.staleAfter ?? null,
    citationCount: traceData.citations?.length ?? 0,
    executionCount: traceData.execution?.length ?? 0,
    citations: traceData.citations ?? [],
    execution: traceData.execution ?? [],
    evaluator: traceData.evaluator ?? null,
    runtimeContext: traceData.runtimeContext
        ? {
              modelVersion: traceData.runtimeContext.modelVersion ?? null,
              conversationSnapshot: traceData.runtimeContext
                  .conversationSnapshot
                  ? `[redacted:${traceData.runtimeContext.conversationSnapshot.length} chars]`
                  : null,
          }
        : null,
});

const tracePageLogger = createScopedLogger('TracePage');

// Helper to extract payload from 410 (stale) responses
const extractPayload = (data: unknown): ServerMetadata | null => {
    if (data && typeof data === 'object' && 'metadata' in data) {
        const stalePayload = data as GetTraceStaleResponse;
        return (stalePayload.metadata as ServerMetadata) || null;
    }
    return null;
};

const toSafeExternalUrl = (value: unknown): string | null => {
    const candidate =
        typeof value === 'string' ? value : String(value ?? '').trim();
    if (candidate.length === 0) {
        return null;
    }

    try {
        const parsed = new URL(candidate);
        const protocol = parsed.protocol.toLowerCase();
        if (protocol === 'http:' || protocol === 'https:') {
            return parsed.toString();
        }
    } catch {
        return null;
    }

    return null;
};

type LoadingState =
    | 'loading'
    | 'success'
    | 'error'
    | 'not-found'
    | 'stale'
    | 'hash-mismatch';

// Safety tier colors matching the server constants
const SAFETY_TIER_COLORS: Record<string, string> = {
    low: '#7FDCA4', // Low safety tier - sage green
    medium: '#F8E37C', // Medium safety tier - warm gold
    high: '#E27C7C', // High safety tier - soft coral
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
                const traceResult = await api.getTrace(responseId);

                if (traceResult.status === 200) {
                    const payload =
                        traceResult.data as SerializableResponseMetadata;
                    const payloadKeys = Object.keys(payload);
                    const payloadApproxBytes = JSON.stringify(payload).length;
                    tracePageLogger.debug('Trace loaded successfully.', {
                        responseId,
                        status: traceResult.status,
                        payloadKeyCount: payloadKeys.length,
                        payloadKeys: payloadKeys.slice(0, 12),
                        payloadApproxBytes,
                    });

                    if (!isMounted) {
                        return;
                    }
                    setTraceData(payload);
                    setLoadingState('success');
                    return;
                }

                if (traceResult.status === 410) {
                    const payload = extractPayload(traceResult.data);

                    if (!isMounted) {
                        return;
                    }

                    if (payload) {
                        setTraceData(payload);
                    }

                    setLoadingState('stale');
                    return;
                }
            } catch (error) {
                tracePageLogger.error('Trace load failed.', {
                    responseId,
                    errorType:
                        error instanceof Error
                            ? error.constructor.name
                            : typeof error,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                    apiStatus: isApiClientError(error) ? error.status : null,
                });

                if (!isMounted) {
                    return;
                }

                if (isApiClientError(error)) {
                    if (error.status === 404) {
                        setLoadingState('not-found');
                        return;
                    }

                    if (error.status === 409) {
                        setLoadingState('hash-mismatch');
                        return;
                    }

                    setErrorMessage(
                        error.details ||
                            error.message ||
                            'Failed to load trace.'
                    );
                    setLoadingState('error');
                    return;
                }

                const errorLike =
                    typeof error === 'object' && error !== null
                        ? (error as { message?: unknown })
                        : null;
                setErrorMessage(
                    errorLike && typeof errorLike.message === 'string'
                        ? errorLike.message
                        : 'Failed to load trace.'
                );
                setLoadingState('error');
            }
        };

        void loadTrace();

        return () => {
            isMounted = false;
        };
    }, [responseId]);

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
                        We couldn&apos;t locate a provenance record for response{' '}
                        <code>{responseId}</code>.
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
                    <p>
                        {errorMessage ||
                            'Something went wrong while loading this trace.'}
                    </p>
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
                        This trace has expired and may no longer be accurate.
                        The information below is displayed for reference only.
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
                                <code>
                                    {traceData.responseId ?? responseId}
                                </code>
                            </div>
                            <Link to="/" className="button-link">
                                Back to home
                            </Link>
                        </header>
                        <article className="card" aria-label="Trace summary">
                            <h2>Summary</h2>
                            <p>
                                <strong>Model:</strong>{' '}
                                {traceData.model || 'Unspecified'}
                            </p>
                            <p>
                                <strong>Generated:</strong>{' '}
                                {traceData.timestamp
                                    ? new Date(
                                          traceData.timestamp
                                      ).toLocaleString()
                                    : 'N/A'}
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
                        The trace data failed an integrity verification check
                        and may have been tampered with.
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

    const rawSafetyTier = traceData?.safetyTier;
    const normalizedSafetyTier =
        typeof rawSafetyTier === 'string' ? rawSafetyTier.toLowerCase() : 'low';
    const safetyColor = SAFETY_TIER_COLORS[normalizedSafetyTier] ?? '#6b7280';
    const provenance =
        traceData?.provenance || traceData?.reasoningEffort || 'Unknown';
    const model = resolveTraceModelLabel(traceData);
    const executionSummary = resolveExecutionSummary(traceData);
    const sanitizedTraceData = buildDisplayTrace(traceData);
    const safetyLabel = rawSafetyTier ?? 'Unspecified';
    const chainHash =
        traceData?.chainHash || traceData?.chainHash === ''
            ? traceData.chainHash
            : undefined;

    const tradeoffCount = traceData?.tradeoffCount ?? 0;
    const staleAfter = traceData?.staleAfter
        ? new Date(traceData.staleAfter).toLocaleString()
        : 'N/A';
    const displayId = traceData?.responseId || responseId;
    const timestampDisplay = traceData.timestamp
        ? new Date(traceData.timestamp).toLocaleString()
        : 'N/A';
    const provenanceExplanation = getProvenanceExplanation(provenance);
    const modeSummary = getModeSummary(traceData);
    const sourceSummary = getSourceSummary(traceData);
    const safetySummary = getSafetySummary(traceData, safetyLabel);
    const workflowSummary = getWorkflowSummary(traceData);
    const runOutcomeSummary = buildRunOutcomeSummary(traceData);
    const summarySignals: SummarySignal[] = [
        {
            label: 'Mode',
            value: modeSummary.value,
            explanation: modeSummary.explanation,
        },
        {
            label: 'Sources',
            value: sourceSummary.value,
            explanation: sourceSummary.explanation,
        },
        {
            label: 'Safety',
            value: safetySummary.value,
            explanation: safetySummary.explanation,
        },
        {
            label: 'Workflow',
            value: workflowSummary.value,
            explanation: workflowSummary.explanation,
        },
    ];
    const hasWorkflowPlanStep =
        traceData.workflow?.steps.some((step) => step.stepKind === 'plan') ??
        false;
    const showDataCaveats = !hasWorkflowPlanStep || !traceData.trustGraph;

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

            <article
                className="card"
                style={{ borderLeft: `4px solid ${safetyColor}` }}
                aria-label="Trace summary"
            >
                <h2>What happened</h2>
                <p>
                    This page summarizes how this answer was produced and where
                    you can inspect evidence next.
                </p>
                {runOutcomeSummary && (
                    <>
                        <p>
                            <strong>Run outcome:</strong>{' '}
                            {runOutcomeSummary.headline}
                        </p>
                        <p>{runOutcomeSummary.explanation}</p>
                        {runOutcomeSummary.reasonCode && (
                            <p>
                                <strong>Recorded reason:</strong>{' '}
                                <code>{runOutcomeSummary.reasonCode}</code>
                            </p>
                        )}
                        {runOutcomeSummary.secondaryReasonCode && (
                            <p>
                                <strong>Additional signal:</strong>{' '}
                                <code>
                                    {runOutcomeSummary.secondaryReasonCode}
                                </code>
                            </p>
                        )}
                    </>
                )}
                <p>
                    <strong>Provenance label:</strong> {provenance}
                </p>
                <p>{provenanceExplanation}</p>
                <p>
                    <strong>Generated:</strong> {timestampDisplay}
                </p>
                <ul>
                    {summarySignals.map((signal) => (
                        <li key={signal.label}>
                            <strong>{signal.label}:</strong> {signal.value}
                            <br />
                            {signal.explanation}
                        </li>
                    ))}
                </ul>
                <p>
                    <strong>Next:</strong>{' '}
                    <a href="#trace-sources">Check sources</a>,{' '}
                    <a href="#trace-runtime">review model/runtime details</a>,
                    or <a href="#trace-raw">open raw trace JSON</a>.
                </p>
            </article>

            <article className="card" id="trace-sources" aria-label="Sources">
                <h2>Sources and Evidence</h2>
                {traceData?.citations && traceData.citations.length > 0 ? (
                    <ul>
                        {traceData.citations.map(
                            (
                                citation: {
                                    title: string;
                                    url: string;
                                    snippet?: string;
                                },
                                index: number
                            ) => {
                                const safeUrl = toSafeExternalUrl(citation.url);
                                return (
                                    <li key={index}>
                                        {safeUrl ? (
                                            <a
                                                href={safeUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                {citation.title || 'Untitled'}
                                            </a>
                                        ) : (
                                            <span>
                                                {citation.title || 'Untitled'}
                                            </span>
                                        )}
                                        {citation.snippet && (
                                            <p
                                                style={{
                                                    marginTop: '0.25rem',
                                                    fontSize: '0.875rem',
                                                    color: '#6b7280',
                                                }}
                                            >
                                                {citation.snippet}
                                            </p>
                                        )}
                                    </li>
                                );
                            }
                        )}
                    </ul>
                ) : (
                    <p>
                        No citations are attached to this response. Use this as
                        an unsupported answer unless you can verify key claims
                        independently.
                    </p>
                )}
                <details style={{ marginTop: '0.75rem' }}>
                    <summary>How source status was determined</summary>
                    <p style={{ marginTop: '0.5rem' }}>
                        Citation links are shown when present in trace metadata.
                        Execution events are used as secondary context only.
                    </p>
                </details>
            </article>

            <article
                className="card"
                id="trace-runtime"
                aria-label="Runtime and workflow details"
            >
                <h2>Runtime and Workflow Details</h2>
                <p>
                    <strong>Model:</strong> {model}
                </p>
                {executionSummary && (
                    <p>
                        <strong>Execution summary:</strong> {executionSummary}
                    </p>
                )}
                {traceData.totalDurationMs !== undefined && (
                    <p>
                        <strong>Total duration:</strong>{' '}
                        {traceData.totalDurationMs}ms
                    </p>
                )}
                {traceData.usage && (
                    <p>
                        <strong>Token usage:</strong> input{' '}
                        {traceData.usage.input_tokens}, output{' '}
                        {traceData.usage.output_tokens}, total{' '}
                        {traceData.usage.total_tokens}
                    </p>
                )}
                <details style={{ marginTop: '0.75rem' }}>
                    <summary>Safety and evaluator details</summary>
                    <dl style={{ marginTop: '0.75rem' }}>
                        <div>
                            <dt>Safety Tier</dt>
                            <dd>
                                <span
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.5rem',
                                    }}
                                >
                                    <span
                                        style={{
                                            width: '0.75rem',
                                            height: '0.75rem',
                                            borderRadius: '9999px',
                                            backgroundColor: safetyColor,
                                            display: 'inline-block',
                                        }}
                                    />
                                    {safetyLabel}
                                </span>
                            </dd>
                        </div>
                        <div>
                            <dt>Evaluator Mode</dt>
                            <dd>
                                {traceData.evaluator?.mode ?? 'Unavailable'}
                            </dd>
                        </div>
                        <div>
                            <dt>Evaluator Authority</dt>
                            <dd>
                                {traceData.evaluator?.authorityLevel ??
                                    'Unavailable'}
                            </dd>
                        </div>
                        <div>
                            <dt>Safety Action</dt>
                            <dd>
                                {traceData.evaluator?.safetyDecision.action ??
                                    'Unavailable'}
                            </dd>
                        </div>
                    </dl>
                </details>
                <details style={{ marginTop: '0.75rem' }}>
                    <summary>Technical fields</summary>
                    <dl style={{ marginTop: '0.75rem' }}>
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
                            <dt>Runtime Model Version</dt>
                            <dd>
                                {traceData.runtimeContext?.modelVersion ??
                                    'Unavailable'}
                            </dd>
                        </div>
                        <div>
                            <dt>Conversation Snapshot</dt>
                            <dd>
                                {sanitizedTraceData.runtimeContext
                                    ?.conversationSnapshot ?? 'Unavailable'}
                            </dd>
                        </div>
                        <div>
                            <dt>License Context</dt>
                            <dd>
                                <span>
                                    See license strategy for reuse details.
                                </span>{' '}
                                <a
                                    href="https://github.com/footnote-ai/footnote/blob/main/docs/LICENSE_STRATEGY.md"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    License strategy
                                </a>
                            </dd>
                        </div>
                    </dl>
                </details>
            </article>

            <article
                className="card"
                id="trace-raw"
                aria-label="Raw trace data"
            >
                <h2>Raw Trace Data</h2>
                <p>
                    This is the redacted debug payload used to render the page.
                </p>
                <details style={{ marginTop: '0.75rem' }}>
                    <summary>Raw JSON</summary>
                    <pre
                        style={{
                            marginTop: '0.75rem',
                            overflowX: 'auto',
                            maxHeight: '24rem',
                            whiteSpace: 'pre-wrap',
                        }}
                    >
                        {JSON.stringify(sanitizedTraceData, null, 2)}
                    </pre>
                </details>
            </article>

            {showDataCaveats && (
                <article className="card" aria-label="Data caveats">
                    <h2>Data Caveats</h2>
                    <dl>
                        {!hasWorkflowPlanStep && (
                            <div>
                                <dt>Planner lineage</dt>
                                <dd>
                                    Planner steps appear only when real `plan`
                                    steps exist in workflow metadata.
                                </dd>
                            </div>
                        )}
                        {!traceData.trustGraph && (
                            <div>
                                <dt>TrustGraph signals</dt>
                                <dd>
                                    TrustGraph evidence appears only when this
                                    trace includes TrustGraph metadata.
                                </dd>
                            </div>
                        )}
                    </dl>
                </article>
            )}
        </section>
    );
};

export default TracePage;
