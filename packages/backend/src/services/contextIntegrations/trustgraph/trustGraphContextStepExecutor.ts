/**
 * @description: Executes TrustGraph as a workflow context step before generation.
 * @footnote-scope: core
 * @footnote-module: TrustGraphContextStepExecutor
 * @footnote-risk: medium - Incorrect parsing or mapping can degrade advisory evidence visibility.
 * @footnote-ethics: high - TrustGraph evidence signals can influence response framing and reviewer oversight.
 */
import type { Citation } from '@footnote/contracts/ethics-core';
import { runEvidenceIngestion } from '../../executionContractTrustGraph/trustGraphEvidenceIngestion.js';
import type {
    ScopeTuple,
    TrustGraphEvidenceAdapter,
    TrustGraphEvidenceIngestionResult,
    TrustGraphOwnershipValidationPolicy,
    ScopeOwnershipValidator,
} from '../../executionContractTrustGraph/trustGraphEvidenceTypes.js';
import type { ScopeValidationPolicy } from '../../executionContractTrustGraph/scopeValidator.js';
import type {
    ContextStepExecutor,
    ContextStepResult,
} from '../../workflowEngine.js';

type TrustGraphContextStepInput = {
    queryIntent: unknown;
    scopeTuple: unknown;
};

export type TrustGraphContextStepRuntimeOptions = {
    adapter?: TrustGraphEvidenceAdapter;
    budget: {
        timeoutMs: number;
        maxCalls: number;
    };
    ownershipValidationPolicy: TrustGraphOwnershipValidationPolicy;
    scopeOwnershipValidator?: ScopeOwnershipValidator;
    scopeValidationPolicy?: Partial<
        Pick<
            ScopeValidationPolicy,
            | 'requireProjectOrCollection'
            | 'allowProjectAndCollectionTogether'
            | 'ownershipValidationTimeoutMs'
        >
    >;
};

const parseTrustGraphContextStepInput = (
    input: unknown
): TrustGraphContextStepInput | undefined => {
    if (input === null || typeof input !== 'object') {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    return {
        queryIntent: record.queryIntent,
        scopeTuple: record.scopeTuple,
    };
};

/**
 * Runtime guard for ScopeTuple.
 *
 * TrustGraph scope validation is high-impact: if we pass malformed scope data,
 * ownership checks can degrade silently. Keep this guard strict and fail-open
 * by returning skipped context-step execution when parsing fails.
 */
const isScopeTuple = (input: unknown): input is ScopeTuple => {
    if (input === null || typeof input !== 'object') {
        return false;
    }
    const tuple = input as Record<string, unknown>;
    if (typeof tuple.userId !== 'string' || tuple.userId.trim().length === 0) {
        return false;
    }
    if (
        tuple.projectId !== undefined &&
        (typeof tuple.projectId !== 'string' ||
            tuple.projectId.trim().length === 0)
    ) {
        return false;
    }
    if (
        tuple.collectionId !== undefined &&
        (typeof tuple.collectionId !== 'string' ||
            tuple.collectionId.trim().length === 0)
    ) {
        return false;
    }
    return true;
};

/**
 * Normalizes citation URLs to HTTPS policy.
 *
 * TrustGraph source refs may be canonical URLs or opaque refs. Opaque refs are
 * projected to a stable HTTPS endpoint so trace/citation surfaces do not emit
 * non-HTTP schemes.
 */
function resolveTrustGraphCitationUrl(sourceRef: string): string | undefined {
    const normalized = sourceRef.trim();
    if (/^https?:\/\//i.test(normalized)) {
        return normalized.replace(/^http:\/\//i, 'https://');
    }
    return undefined;
}

/**
 * Maps TrustGraph evidence refs into shared Citation[] shape.
 *
 * We only emit citations when adapter status is `success`; denied/timeout/error
 * cases are represented via execution/provenance metadata instead.
 */
const buildCitations = (
    result: TrustGraphEvidenceIngestionResult
): Citation[] | undefined => {
    if (result.adapterStatus !== 'success') {
        return undefined;
    }
    const refs = result.predicateViews.P_EVID.sourceRefs;
    if (refs.length === 0) {
        return undefined;
    }
    return refs
        .map((ref) => ({
            ref,
            url: resolveTrustGraphCitationUrl(ref),
        }))
        .filter(
            (
                entry
            ): entry is {
                ref: string;
                url: string;
            } => entry.url !== undefined
        )
        .map((entry) => ({
            title: 'TrustGraph evidence',
            url: entry.url,
            snippet: entry.ref,
        }));
};

export const createTrustGraphContextStepExecutor = ({
    runtimeOptions,
    onWarn,
}: {
    runtimeOptions?: TrustGraphContextStepRuntimeOptions;
    onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): ContextStepExecutor => {
    const warn = onWarn ?? (() => undefined);

    /**
     * Context Step executor for TrustGraph.
     *
     * Fail-open guarantees:
     * - malformed input => skipped
     * - runtime failure => failed + reasonCode, generation continues
     *
     * Governance guarantees:
     * - raw TrustGraph output is retained in integrationContext for backend
     *   metadata/provenance mapping, not exposed directly to callers.
     */
    return async ({ request }): Promise<ContextStepResult> => {
        if (runtimeOptions === undefined) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: 'tool_unavailable',
                },
            };
        }
        const parsed = parseTrustGraphContextStepInput(request.input);
        if (
            parsed === undefined ||
            typeof parsed.queryIntent !== 'string' ||
            parsed.queryIntent.trim().length === 0 ||
            !isScopeTuple(parsed.scopeTuple)
        ) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: 'tool_not_requested',
                },
            };
        }
        try {
            const trustGraphResult = await runEvidenceIngestion({
                queryIntent: parsed.queryIntent,
                scopeTuple: parsed.scopeTuple,
                budget: runtimeOptions.budget,
                ownershipValidationPolicy:
                    runtimeOptions.ownershipValidationPolicy,
                scopeOwnershipValidator: runtimeOptions.scopeOwnershipValidator,
                scopeValidationPolicy: runtimeOptions.scopeValidationPolicy,
                adapter: runtimeOptions.adapter,
            });
            return {
                executionContext: {
                    toolName: request.integrationName,
                    // Adapter `error` and `timeout` are treated as failed execution.
                    // Other governance outcomes (for example scope_denied) stay
                    // executed so provenance can report bounded outcomes.
                    status:
                        trustGraphResult.adapterStatus === 'error' ||
                        trustGraphResult.adapterStatus === 'timeout'
                            ? 'failed'
                            : 'executed',
                    reasonCode:
                        trustGraphResult.adapterStatus === 'timeout'
                            ? 'tool_timeout'
                            : trustGraphResult.adapterStatus === 'error'
                              ? 'tool_execution_error'
                              : undefined,
                },
                sources: buildCitations(trustGraphResult),
                integrationContext: {
                    kind: 'trustgraph',
                    version: 'v1',
                    payload: {
                        trustGraphResult,
                    },
                },
            };
        } catch (error) {
            warn(
                'TrustGraph context step failed open; continuing without advisory context.',
                {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'failed',
                    reasonCode: 'tool_execution_error',
                },
            };
        }
    };
};
