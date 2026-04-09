/**
 * @description: Provides a bounded TrustGraph adapter stub for contract testing and prototype wiring.
 * The stub supports success, failure, timeout, and poisoned-evidence simulation modes.
 * @footnote-scope: utility
 * @footnote-module: TrustGraphEvidenceAdapterStub
 * @footnote-risk: low - Stub behavior can skew local prototype tests but is isolated from production routing logic.
 * @footnote-ethics: medium - Test adapter modes must reflect governance boundaries to avoid misleading conclusions.
 */

import type {
    EvidenceBundle,
    ScopeTuple,
    TrustGraphEvidenceAdapter,
} from './trustGraphEvidenceTypes.js';

export type StubTrustGraphAdapterMode =
    | 'success'
    | 'failure'
    | 'timeout'
    | 'poisoned';

const createAbortError = (): Error =>
    new Error('trustgraph_adapter_aborted_by_signal');

const waitWithAbort = async (
    durationMs: number,
    abortSignal?: AbortSignal
): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
            reject(createAbortError());
            return;
        }

        const timer = setTimeout(
            () => {
                cleanup();
                resolve();
            },
            Math.max(1, durationMs)
        );

        const onAbort = (): void => {
            clearTimeout(timer);
            cleanup();
            reject(createAbortError());
        };

        const cleanup = (): void => {
            abortSignal?.removeEventListener('abort', onAbort);
        };

        abortSignal?.addEventListener('abort', onAbort, { once: true });
    });

const buildBaseBundle = (
    queryIntent: string,
    scopeTuple: ScopeTuple
): EvidenceBundle => ({
    bundleId: 'bundle_stub_trustgraph',
    queryIntent,
    items: [
        {
            evidenceId: 'ev_1',
            claimText:
                'The retrieval corpus contains direct supporting evidence.',
            sourceRef: 'doc://policy/source-1',
            provenancePathRef: ['trace://path/a', 'trace://path/b'],
            retrievalReason: 'semantic_match',
            confidenceScore: 0.91,
            confidenceMethodId: 'stub_semantic_v1',
            retrievedAt: new Date('2026-04-04T00:00:00.000Z').toISOString(),
            collectionScope: 'project',
            adapterVersion: 'trustgraph-stub-v1',
        },
    ],
    coverageEstimate: {
        evaluationUnit: 'claim',
        scoreRange: '0..1',
        value: 0.72,
        computationBasis: ['semantic_overlap', 'source_diversity'],
        comparableAcrossVersions: true,
        adapterVersion: 'trustgraph-stub-v1',
    },
    conflictSignals: [],
    traceRefs: ['trace://bundle/stub-1'],
    scopeTuple,
    adapterVersion: 'trustgraph-stub-v1',
});

export class StubTrustGraphEvidenceAdapter implements TrustGraphEvidenceAdapter {
    private readonly mode: StubTrustGraphAdapterMode;

    public constructor(mode: StubTrustGraphAdapterMode) {
        this.mode = mode;
    }

    public async getEvidenceBundle(input: {
        queryIntent: string;
        scopeTuple: ScopeTuple;
        budget: { timeoutMs: number; maxCalls: number };
        abortSignal?: AbortSignal;
    }): Promise<EvidenceBundle> {
        if (this.mode === 'failure') {
            throw new Error(
                'Stub adapter failure for prototype contract testing.'
            );
        }

        if (this.mode === 'timeout') {
            await waitWithAbort(
                Math.max(1, input.budget.timeoutMs + 50),
                input.abortSignal
            );
        }

        const baseBundle = buildBaseBundle(input.queryIntent, input.scopeTuple);
        if (this.mode === 'poisoned') {
            return {
                ...baseBundle,
                items: [
                    ...baseBundle.items,
                    {
                        evidenceId: 'ev_poisoned',
                        claimText: '<script>alert("poison")</script>',
                        sourceRef: 'doc://policy/source-poisoned',
                        provenancePathRef: ['trace://poisoned/path'],
                        retrievalReason: 'poison_test_payload',
                        confidenceScore: 0.99,
                        confidenceMethodId: 'stub_poison_v1',
                        retrievedAt: new Date(
                            '2026-04-04T00:00:00.000Z'
                        ).toISOString(),
                        collectionScope: 'project',
                        adapterVersion: 'trustgraph-stub-v1',
                    },
                ],
            };
        }

        return baseBundle;
    }
}
