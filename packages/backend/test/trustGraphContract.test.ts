/**
 * @description: Verifies contract boundaries for TrustGraph advisory evidence intake under Execution Contract authority.
 * These tests enforce governance, scope safety, ownership policy hardening, timeout cancellation, and provenance completeness.
 * @footnote-scope: test
 * @footnote-module: TrustGraphContractTests
 * @footnote-risk: high - Missing contract tests can let adapter behavior drift into authority-critical Execution Contract paths.
 * @footnote-ethics: high - These tests protect reviewer trust in provenance, scope safety, and verification discipline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createBackendTenancyOwnershipHttpService,
    createScopeOwnershipValidatorFromTenancyService,
    TrustGraphOwnershipBypassCapability,
    TrustGraphOwnershipValidationPolicy,
    TRUST_GRAPH_APPROVED_FIELDS,
    TRUST_GRAPH_APPROVED_PREDICATE_CONSUMERS,
    TRUST_GRAPH_FORBIDDEN_DIRECT_CONTROL_FIELDS,
    runBenchmarkTriplet,
    runEvidenceIngestion,
    StubTrustGraphEvidenceAdapter,
    validateTrustGraphScope,
} from '../src/services/executionContractTrustGraph/index.js';
import type {
    EvidenceBundle,
    ScopeTuple,
    TrustGraphEvidenceAdapter,
    TrustGraphMappingRegistryEntry,
    TrustGraphScopeOwnershipValidationResult,
} from '../src/services/executionContractTrustGraph/index.js';

const TEST_TIMESTAMP = new Date('2026-04-04T00:00:00.000Z').toISOString();

const requiredPolicy = (): TrustGraphOwnershipValidationPolicy =>
    TrustGraphOwnershipValidationPolicy.required({
        policyId: 'test_required_policy',
    });

const bypassPolicy = (): TrustGraphOwnershipValidationPolicy =>
    TrustGraphOwnershipValidationPolicy.explicitlyNoneForNonProduction({
        policyId: 'test_bypass_policy',
        justificationCode: 'unit_test',
        bypassCapability:
            TrustGraphOwnershipBypassCapability.forIntegrationTest(),
    });

const buildBundle = (input: {
    scopeTuple: ScopeTuple;
    evidenceId?: string;
    claimText?: string;
    coverage?: number;
    conflictSignals?: string[];
}): EvidenceBundle => ({
    bundleId: 'bundle_test_1',
    queryIntent: 'query',
    items: [
        {
            evidenceId: input.evidenceId ?? 'ev_1',
            claimText: input.claimText ?? 'Valid claim',
            sourceRef: 'doc://source/1',
            provenancePathRef: ['trace://path/1'],
            retrievalReason: 'semantic_match',
            confidenceScore: 0.99,
            confidenceMethodId: 'method_v1',
            retrievedAt: TEST_TIMESTAMP,
            collectionScope: 'project',
            adapterVersion: 'test-v1',
        },
    ],
    coverageEstimate: {
        evaluationUnit: 'claim',
        scoreRange: '0..1',
        value: input.coverage ?? 0.8,
        computationBasis: ['semantic_overlap'],
        comparableAcrossVersions: true,
        adapterVersion: 'test-v1',
    },
    conflictSignals: input.conflictSignals ?? [],
    traceRefs: ['trace://bundle/1'],
    scopeTuple: input.scopeTuple,
    adapterVersion: 'test-v1',
});

const allowOwnership = (): TrustGraphScopeOwnershipValidationResult => ({
    decision: 'allow',
    validatorId: 'tenant_service_v1',
    checkedAt: TEST_TIMESTAMP,
    evidence: ['ownership_lookup:allow'],
});

const denyOwnership = (): TrustGraphScopeOwnershipValidationResult => ({
    decision: 'deny',
    validatorId: 'tenant_service_v1',
    checkedAt: TEST_TIMESTAMP,
    denialReason: 'tenant_mismatch',
    details: 'User does not own requested project scope.',
    evidence: ['ownership_lookup:deny'],
});

test('Success path returns governed predicate views and hides raw adapter payload', async () => {
    const result = await runEvidenceIngestion({
        queryIntent: 'find supporting evidence',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: bypassPolicy(),
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'success');
    assert.equal(result.scopeValidation.ok, true);
    assert.equal(result.terminalAuthority, 'backend_execution_contract');
    assert.equal(result.verificationRequired, true);
    assert.ok(result.predicateViews.P_SUFF.coverageValue !== undefined);
    assert.ok(result.predicateViews.P_EVID.sourceRefs.length > 0);
    assert.equal(
        Object.prototype.hasOwnProperty.call(result, 'adapterBundle'),
        false
    );
});

test('Adapter bundle scope mismatch is denied and advisory evidence is rejected', async () => {
    const adapter: TrustGraphEvidenceAdapter = {
        async getEvidenceBundle(): Promise<EvidenceBundle> {
            return buildBundle({
                scopeTuple: {
                    userId: 'different_user',
                    projectId: 'different_project',
                },
            });
        },
    };

    const result = await runEvidenceIngestion({
        queryIntent: 'scope mismatch should be denied',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: bypassPolicy(),
        adapter,
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(result.advisoryEvidenceItemCount, 0);
    assert.equal(result.provenanceJoin, undefined);
    assert.equal(
        result.provenanceReasonCodes.includes('adapter_scope_mismatch'),
        true
    );
});

test('Registry exports are immutable at runtime', () => {
    assert.throws(() => {
        (
            TRUST_GRAPH_APPROVED_FIELDS as unknown as TrustGraphMappingRegistryEntry[]
        ).push({
            path: 'fake.path',
            consumers: ['P_SUFF'],
            notes: 'mutation',
        });
    });
    assert.throws(() => {
        (
            TRUST_GRAPH_FORBIDDEN_DIRECT_CONTROL_FIELDS as unknown as string[]
        ).push('new_forbidden_field');
    });
    assert.equal(
        TRUST_GRAPH_APPROVED_PREDICATE_CONSUMERS.includes('P_SUFF'),
        true
    );
});

test('Unregistered and forbidden fields remain inert in governed views', async () => {
    const adapter: TrustGraphEvidenceAdapter = {
        async getEvidenceBundle(): Promise<EvidenceBundle> {
            const rawBundle = {
                ...buildBundle({
                    scopeTuple: {
                        userId: 'user_1',
                        projectId: 'project_1',
                    },
                }),
                anyRawAdapterRanking: 0.999,
                hiddenDecisionHint: 'route_terminal_directly',
            };

            return rawBundle as unknown as EvidenceBundle;
        },
    };

    const result = await runEvidenceIngestion({
        queryIntent: 'ungoverned fields test',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: bypassPolicy(),
        adapter,
    });

    assert.equal(
        Object.prototype.hasOwnProperty.call(
            result.predicateViews.P_SUFF,
            'confidenceScore'
        ),
        false
    );
    assert.equal(
        result.provenanceJoin?.consumedGovernedFieldPaths.includes(
            'anyRawAdapterRanking'
        ),
        false
    );
    assert.equal(
        result.provenanceJoin?.consumedGovernedFieldPaths.includes(
            'hiddenDecisionHint'
        ),
        false
    );
});

test('Scope validation rejects missing, ambiguous, and invalid tuples', async () => {
    const missing = await validateTrustGraphScope(
        {
            userId: 'user_1',
        },
        {
            requireProjectOrCollection: true,
            allowProjectAndCollectionTogether: false,
            ownershipValidationMode: 'explicitly_none',
        }
    );
    assert.equal(missing.ok, false);

    const ambiguous = await validateTrustGraphScope(
        {
            userId: 'user_1',
            projectId: 'project_1',
            collectionId: 'collection_1',
        },
        {
            requireProjectOrCollection: true,
            allowProjectAndCollectionTogether: false,
            ownershipValidationMode: 'explicitly_none',
        }
    );
    assert.equal(ambiguous.ok, false);

    const invalid = await validateTrustGraphScope(
        {
            userId: 'user_1',
            projectId: 'project/invalid',
        },
        {
            requireProjectOrCollection: true,
            allowProjectAndCollectionTogether: false,
            ownershipValidationMode: 'explicitly_none',
        }
    );
    assert.equal(invalid.ok, false);
});

test('Validator required but missing denies retrieval and does not call adapter', async () => {
    let adapterCalls = 0;
    const adapter: TrustGraphEvidenceAdapter = {
        async getEvidenceBundle(): Promise<EvidenceBundle> {
            adapterCalls += 1;
            return buildBundle({
                scopeTuple: { userId: 'user_1', projectId: 'project_1' },
            });
        },
    };

    const result = await runEvidenceIngestion({
        queryIntent: 'missing ownership validator',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        adapter,
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(adapterCalls, 0);
});

test('Validator provided and pass allows retrieval', async () => {
    const result = await runEvidenceIngestion({
        queryIntent: 'ownership validator pass',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeOwnershipValidator: {
            validatorSource: 'backend_tenancy_service',
            validatorId: 'tenant_service_v1',
            validateOwnership: async () => allowOwnership(),
        },
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'success');
    assert.ok(result.advisoryEvidenceItemCount > 0);
});

test('Validator provided and fail denies retrieval', async () => {
    const result = await runEvidenceIngestion({
        queryIntent: 'ownership validator fail',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeOwnershipValidator: {
            validatorSource: 'backend_tenancy_service',
            validatorId: 'tenant_service_v1',
            validateOwnership: async () => denyOwnership(),
        },
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(
        result.scopeValidation.ok
            ? ''
            : result.scopeValidation.details.includes('tenant_mismatch'),
        true
    );
});

test('bypass mode cannot be enabled by NODE_ENV alone without trusted bypass capability', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    let result: Awaited<ReturnType<typeof runEvidenceIngestion>>;
    try {
        result = await runEvidenceIngestion({
            queryIntent: 'explicit bypass without capability',
            scopeTuple: {
                userId: 'user_1',
                projectId: 'project_1',
            },
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy: {
                mode: 'explicitly_none',
                policySource: 'trusted_backend_policy',
                policyId: 'bad_policy',
                justificationCode: 'unit_test',
            } as unknown as TrustGraphOwnershipValidationPolicy,
            adapter: new StubTrustGraphEvidenceAdapter('success'),
        });
    } finally {
        if (previousNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = previousNodeEnv;
        }
    }

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(
        result.scopeValidation.ok
            ? false
            : result.scopeValidation.details.includes(
                  'TrustGraphOwnershipValidationPolicy'
              ),
        true
    );
});

test('bypass mode requires trusted bypass capability even with trusted policy shape', async () => {
    const forgedPolicy = Object.assign(
        Object.create(TrustGraphOwnershipValidationPolicy.prototype),
        {
            mode: 'explicitly_none',
            policySource: 'trusted_backend_policy',
            policyId: 'forged_policy',
            justificationCode: 'unit_test',
        }
    ) as TrustGraphOwnershipValidationPolicy;

    const result = await runEvidenceIngestion({
        queryIntent: 'forged bypass policy without capability',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: forgedPolicy,
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(
        result.scopeValidation.ok
            ? false
            : result.scopeValidation.details.includes(
                  'requires trusted bypass capability'
              ),
        true
    );
});

test('Ownership validation policy must be an explicit policy object instance', async () => {
    const allowed = await runEvidenceIngestion({
        queryIntent: 'explicit bypass allowed',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: bypassPolicy(),
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });
    assert.equal(allowed.adapterStatus, 'success');

    const deniedPlainObjectPolicy = await runEvidenceIngestion({
        queryIntent: 'plain-object policy should be rejected',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: {
            mode: 'explicitly_none',
            policySource: 'trusted_backend_policy',
            policyId: 'plain_object',
            justificationCode: 'unit_test',
        } as unknown as TrustGraphOwnershipValidationPolicy,
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });
    assert.equal(deniedPlainObjectPolicy.adapterStatus, 'scope_denied');
});

test('Ownership validator throws => fail closed', async () => {
    const result = await runEvidenceIngestion({
        queryIntent: 'ownership validator throws',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeOwnershipValidator: {
            validatorSource: 'backend_tenancy_service',
            validatorId: 'tenant_service_v1',
            validateOwnership: async () => {
                throw new Error('tenancy service unavailable');
            },
        },
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(
        result.scopeValidation.ok
            ? ''
            : result.scopeValidation.details.includes('validator_error'),
        true
    );
});

test('Ownership validator timeout fails closed and prevents adapter invocation', async () => {
    let adapterCalls = 0;
    let ownershipAbortObserved = false;
    const adapter: TrustGraphEvidenceAdapter = {
        async getEvidenceBundle(): Promise<EvidenceBundle> {
            adapterCalls += 1;
            return buildBundle({
                scopeTuple: {
                    userId: 'user_1',
                    projectId: 'project_1',
                },
            });
        },
    };

    const result = await runEvidenceIngestion({
        queryIntent: 'ownership timeout',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeValidationPolicy: {
            ownershipValidationTimeoutMs: 10,
        },
        scopeOwnershipValidator: {
            validatorSource: 'backend_tenancy_service',
            validatorId: 'tenant_service_v1',
            validateOwnership: async (_scope, options) =>
                await new Promise<TrustGraphScopeOwnershipValidationResult>(
                    (_resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(
                                new Error(
                                    'ownership validator should have timed out first'
                                )
                            );
                        }, 200);

                        options?.abortSignal?.addEventListener(
                            'abort',
                            () => {
                                ownershipAbortObserved = true;
                                clearTimeout(timeout);
                                reject(
                                    new Error('ownership_validator_aborted')
                                );
                            },
                            { once: true }
                        );
                    }
                ),
        },
        adapter,
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(adapterCalls, 0);
    assert.equal(ownershipAbortObserved, true);
    assert.equal(
        result.scopeValidation.ok
            ? false
            : result.scopeValidation.details.includes('timed out'),
        true
    );
});

test('Ownership validator deny result with unsupported denialReason fails closed', async () => {
    const result = await runEvidenceIngestion({
        queryIntent: 'unsupported ownership denial reason',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeOwnershipValidator: {
            validatorSource: 'backend_tenancy_service',
            validatorId: 'tenant_service_v1',
            validateOwnership: async () =>
                ({
                    decision: 'deny',
                    validatorId: 'tenant_service_v1',
                    checkedAt: TEST_TIMESTAMP,
                    denialReason: 'unknown_denial_reason',
                    details: 'unexpected denial reason',
                    evidence: ['ownership_lookup:deny'],
                }) as unknown as TrustGraphScopeOwnershipValidationResult,
        },
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(
        result.scopeValidation.ok
            ? ''
            : result.scopeValidation.details.includes(
                  'unsupported denialReason'
              ),
        true
    );
});

test('Malformed ownership validator result fails closed', async () => {
    const malformedValidator = {
        validatorSource: 'backend_tenancy_service' as const,
        validatorId: 'tenant_service_v1',
        validateOwnership: async () =>
            ({
                decision: 'allow',
                validatorId: '',
                checkedAt: 'bad-date',
                evidence: [''],
            }) as unknown as TrustGraphScopeOwnershipValidationResult,
    };

    const result = await runEvidenceIngestion({
        queryIntent: 'malformed validator result',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeOwnershipValidator: malformedValidator,
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(
        result.scopeValidation.ok
            ? ''
            : result.scopeValidation.details.includes(
                  'Ownership validator result'
              ),
        true
    );
});

test('Tenancy service adapter maps authoritative ownership checks to validator contract', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['sql:ownership_lookup'],
                }),
            },
        });

    const result = await runEvidenceIngestion({
        queryIntent: 'tenancy adapter seam',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeOwnershipValidator,
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'success');
});

test('HTTP tenancy ownership service enforces timeout and abort semantics', async () => {
    const originalFetch = global.fetch;
    let abortObserved = false;
    global.fetch = (async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
                'abort',
                () => {
                    abortObserved = true;
                    const abortedError = new Error('aborted');
                    abortedError.name = 'AbortError';
                    reject(abortedError);
                },
                { once: true }
            );
        })) as typeof fetch;

    const service = createBackendTenancyOwnershipHttpService({
        endpointUrl: 'https://example.invalid/ownership',
        timeoutMs: 10,
    });

    try {
        await assert.rejects(
            () =>
                service.validateScopeOwnership({
                    userId: 'user_1',
                    projectId: 'project_1',
                }),
            /ownership_validator_timeout/
        );
        assert.equal(abortObserved, true);
    } finally {
        global.fetch = originalFetch;
    }
});

test('Untrusted custom validator is denied when ownership validation is required', async () => {
    const result = await runEvidenceIngestion({
        queryIntent: 'custom untrusted validator',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: requiredPolicy(),
        scopeOwnershipValidator: {
            validatorSource: 'custom_untrusted_validator',
            validatorId: 'custom_inline_v1',
            validateOwnership: async () => allowOwnership(),
        },
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.equal(result.adapterStatus, 'scope_denied');
    assert.equal(
        result.scopeValidation.ok
            ? ''
            : result.scopeValidation.details.includes(
                  'not trusted backend tenancy service'
              ),
        true
    );
});

test('Timeout path requests adapter cancellation and records timeout provenance', async () => {
    let cancellationObserved = false;
    const cancellationAwareAdapter: TrustGraphEvidenceAdapter = {
        async getEvidenceBundle(input): Promise<EvidenceBundle> {
            await new Promise<void>((_, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('adapter_should_have_timed_out'));
                }, 200);
                input.abortSignal?.addEventListener(
                    'abort',
                    () => {
                        cancellationObserved = true;
                        clearTimeout(timer);
                        reject(
                            new Error('trustgraph_adapter_aborted_by_signal')
                        );
                    },
                    { once: true }
                );
            });
            throw new Error('unreachable_after_abort');
        },
    };

    const result = await runEvidenceIngestion({
        queryIntent: 'timeout case',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 10,
            maxCalls: 1,
        },
        ownershipValidationPolicy: bypassPolicy(),
        adapter: cancellationAwareAdapter,
    });

    assert.equal(result.adapterStatus, 'timeout');
    assert.equal(cancellationObserved, true);
    assert.equal(result.terminalAuthority, 'backend_execution_contract');
    assert.equal(
        result.provenanceReasonCodes.includes(
            'adapter_timeout_cancellation_requested'
        ),
        true
    );
});

test('Poisoned/invalid evidence neutralizes aggregate signals and removes stale influence', async () => {
    const poisonedOnlyAdapter: TrustGraphEvidenceAdapter = {
        async getEvidenceBundle(): Promise<EvidenceBundle> {
            return buildBundle({
                scopeTuple: {
                    userId: 'user_1',
                    projectId: 'project_1',
                },
                evidenceId: 'ev_poisoned',
                claimText: '<script>alert("x")</script>',
                coverage: 0.98,
                conflictSignals: ['conflict_from_poisoned_bundle'],
            });
        },
    };

    const result = await runEvidenceIngestion({
        queryIntent: 'poisoned evidence test',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: bypassPolicy(),
        adapter: poisonedOnlyAdapter,
    });

    assert.equal(result.adapterStatus, 'success');
    assert.equal(result.advisoryEvidenceItemCount, 0);
    assert.equal(result.droppedEvidenceCount, 1);
    assert.equal(
        result.provenanceReasonCodes.includes(
            'aggregate_signals_neutralized_after_filtering'
        ),
        true
    );
    assert.equal(result.predicateViews.P_SUFF.coverageValue, undefined);
    assert.deepEqual(result.predicateViews.P_SUFF.conflictSignals, []);
    assert.deepEqual(result.predicateViews.P_EVID.conflictSignals, []);
});

test('Provenance join records governed field influence and drop metadata', async () => {
    const result = await runEvidenceIngestion({
        queryIntent: 'provenance join test',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        budget: {
            timeoutMs: 100,
            maxCalls: 1,
        },
        ownershipValidationPolicy: bypassPolicy(),
        adapter: new StubTrustGraphEvidenceAdapter('success'),
    });

    assert.ok(result.provenanceJoin !== undefined);
    assert.equal(
        result.provenanceJoin?.consumedGovernedFieldPaths.includes(
            'items[].sourceRef'
        ),
        true
    );
    assert.equal(
        result.provenanceJoin?.consumedByConsumers.includes('P_EVID'),
        true
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            result.provenanceJoin ?? {},
            'scopeTuple'
        ),
        false
    );
    assert.deepEqual(result.provenanceJoin?.droppedEvidenceIds, []);
});

test('Repeated ON/OFF runs preserve authority semantics', async () => {
    for (let i = 0; i < 6; i += 1) {
        const withAdapter = i % 2 === 0;
        const result = await runEvidenceIngestion({
            queryIntent: `run_${i}`,
            scopeTuple: {
                userId: 'user_1',
                projectId: 'project_1',
            },
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy: bypassPolicy(),
            adapter: withAdapter
                ? new StubTrustGraphEvidenceAdapter('success')
                : undefined,
            evaluateLocalExecutionContractOutcome: () => 'degraded',
        });

        assert.equal(result.terminalAuthority, 'backend_execution_contract');
        assert.equal(result.failOpenBehavior, 'local_behavior');
        assert.equal(result.localTerminalOutcome, 'degraded');
        assert.equal(result.verificationRequired, true);
    }
});

test('Benchmark harness returns OFF/ON/ON_FAIL rows with conformance checks', async () => {
    const rows = await runBenchmarkTriplet({
        caseId: 'case_001',
        caseType: 'straightforward',
        queryIntent: 'benchmark row generation',
        scopeTuple: {
            userId: 'user_1',
            projectId: 'project_1',
        },
        expectedLocalTerminalOutcome: 'complete',
    });

    assert.equal(rows.length, 3);
    assert.deepEqual(
        rows.map((row) => row.adapterMode),
        ['OFF', 'ON', 'ON_FAIL']
    );
    assert.equal(rows[0].terminalOutcome, 'complete');
    assert.equal(rows[1].terminalOutcome, 'complete');
    assert.equal(rows[2].terminalOutcome, 'complete');
    assert.deepEqual(rows[1].conformanceFailures, []);
});

test('Confidence remains advisory and forbidden fields stay outside approved mapping', () => {
    assert.equal(
        TRUST_GRAPH_APPROVED_FIELDS.some(
            (entry) => entry.path === 'items[].confidenceScore'
        ),
        false
    );
    assert.equal(
        TRUST_GRAPH_FORBIDDEN_DIRECT_CONTROL_FIELDS.includes(
            'items[].confidenceScore'
        ),
        true
    );
});
