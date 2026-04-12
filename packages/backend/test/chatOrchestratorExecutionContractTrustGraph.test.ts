/**
 * @description: Verifies Execution Contract TrustGraph runtime integration through chat orchestrator message flow.
 * @footnote-scope: test
 * @footnote-module: ChatOrchestratorExecutionContractTrustGraphTests
 * @footnote-risk: medium - Missing coverage can hide authority drift when advisory evidence is enabled.
 * @footnote-ethics: high - Authority boundary regressions can mislead users about execution governance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRuntime } from '@footnote/agent-runtime';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type { PostChatRequest } from '@footnote/contracts/web';
import { createChatOrchestrator } from '../src/services/chatOrchestrator.js';
import {
    createScopeOwnershipValidatorFromTenancyService,
    StubTrustGraphEvidenceAdapter,
    TrustGraphOwnershipValidationPolicy,
} from '../src/services/executionContractTrustGraph/index.js';
import type {
    EvidenceBundle,
    ScopeTuple,
} from '../src/services/executionContractTrustGraph/index.js';

const PLANNER_TOKEN_SENTINEL = 1200;
const TEST_TIMESTAMP = new Date('2026-04-04T00:00:00.000Z').toISOString();

type TrustGraphMetadata = {
    evidenceMode?: string;
    canBlockExecution?: boolean;
    verificationMode?: string;
    adapterStatus?: string;
    terminalAuthority?: string;
    failOpenBehavior?: string;
    verificationRequired?: boolean;
    scopeValidation?: {
        ok?: boolean;
        normalizedScope?: {
            userId?: string;
            projectId?: string;
        };
    };
    provenanceJoin?: { externalEvidenceBundleId?: string };
    adapterBundle?: unknown;
};

const createMetadata = (): ResponseMetadata => ({
    responseId: 'chat_test_response',
    provenance: 'Inferred',
    safetyTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'abc123def456',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
    trace_target: {},
    trace_final: {},
});

const createChatRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'What changed?',
    conversation: [{ role: 'user', content: 'What changed?' }],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

const createGenerationRuntime = (
    implementation: (
        request: import('@footnote/agent-runtime').GenerationRequest
    ) => Promise<import('@footnote/agent-runtime').GenerationResult>
): GenerationRuntime => ({
    kind: 'test-runtime',
    generate: implementation,
});

const buildEvidenceBundle = (scopeTuple: ScopeTuple): EvidenceBundle => ({
    bundleId: 'bundle_chat_orchestrator_1',
    queryIntent: 'query',
    items: [
        {
            evidenceId: 'ev_1',
            claimText: 'Valid claim',
            sourceRef: 'doc://source/1',
            provenancePathRef: ['trace://path/1'],
            retrievalReason: 'semantic_match',
            confidenceScore: 0.9,
            confidenceMethodId: 'method_v1',
            retrievedAt: TEST_TIMESTAMP,
            collectionScope: 'project',
            adapterVersion: 'test-v1',
        },
    ],
    coverageEstimate: {
        evaluationUnit: 'claim',
        scoreRange: '0..1',
        value: 0.8,
        computationBasis: ['semantic_overlap'],
        comparableAcrossVersions: true,
        adapterVersion: 'test-v1',
    },
    conflictSignals: [],
    traceRefs: ['trace://bundle/1'],
    scopeTuple,
    adapterVersion: 'test-v1',
});

test('orchestrator runtime path integrates advisory TrustGraph metadata without changing message authority', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ maxOutputTokens }) => {
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            safetyTier: 'Low',
                            reasoning: 'Standard message reply.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                return {
                    text: 'message with advisory evidence',
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    citations: [],
                };
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        executionContractTrustGraph: {
            adapter: new StubTrustGraphEvidenceAdapter('success'),
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy:
                TrustGraphOwnershipValidationPolicy.required({
                    policyId: 'chat_orchestrator_runtime_policy',
                }),
            scopeOwnershipValidator,
        },
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            surfaceContext: {
                userId: 'user_1',
                channelId: 'project_1',
            },
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'message with advisory evidence');
    const trustGraph = (
        response.metadata as ResponseMetadata & {
            trustGraph?: Record<string, unknown>;
        }
    ).trustGraph as TrustGraphMetadata | undefined;
    assert.ok(trustGraph);
    assert.equal(trustGraph?.evidenceMode, 'advisory');
    assert.equal(trustGraph?.canBlockExecution, false);
    assert.equal(trustGraph?.adapterStatus, 'success');
    assert.equal(trustGraph?.terminalAuthority, 'backend_execution_contract');
    assert.equal(trustGraph?.failOpenBehavior, 'local_behavior');
    assert.equal(trustGraph?.verificationRequired, true);
    assert.equal(trustGraph?.verificationMode, 'none');
    assert.deepEqual(trustGraph?.scopeValidation, {
        ok: true,
        normalizedScope: {
            userId: '[redacted]',
            projectId: '[redacted]',
        },
    });
    assert.ok(
        typeof trustGraph?.provenanceJoin?.externalEvidenceBundleId === 'string'
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            trustGraph?.provenanceJoin ?? {},
            'scopeTuple'
        ),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(trustGraph ?? {}, 'adapterBundle'),
        false
    );
});

test('orchestrator TrustGraph ON/OFF preserves routing and terminal authority semantics', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });

    const runChat = async (trustGraphEnabled: boolean) => {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(
                async ({ maxOutputTokens }) => {
                    if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                        return {
                            text: JSON.stringify({
                                action: 'message',
                                modality: 'text',
                                safetyTier: 'Low',
                                reasoning: 'Standard message reply.',
                                generation: {
                                    reasoningEffort: 'low',
                                    verbosity: 'low',
                                },
                            }),
                            model: 'gpt-5-mini',
                        };
                    }

                    return {
                        text: 'stable authority response',
                        model: 'gpt-5-mini',
                        provenance: 'Inferred',
                        citations: [],
                    };
                }
            ),
            storeTrace: async () => undefined,
            buildResponseMetadata: () => createMetadata(),
            defaultModel: 'gpt-5-mini',
            recordUsage: () => undefined,
            ...(trustGraphEnabled && {
                executionContractTrustGraph: {
                    adapter: new StubTrustGraphEvidenceAdapter('success'),
                    budget: {
                        timeoutMs: 100,
                        maxCalls: 1,
                    },
                    ownershipValidationPolicy:
                        TrustGraphOwnershipValidationPolicy.required({
                            policyId: 'chat_orchestrator_runtime_policy',
                        }),
                    scopeOwnershipValidator,
                },
            }),
        });

        return orchestrator.runChat(
            createChatRequest({
                surfaceContext: {
                    userId: 'user_1',
                    channelId: 'project_1',
                },
            })
        );
    };

    const withoutTrustGraph = await runChat(false);
    const withTrustGraph = await runChat(true);

    assert.equal(withoutTrustGraph.action, 'message');
    assert.equal(withTrustGraph.action, 'message');
    assert.equal(withoutTrustGraph.message, withTrustGraph.message);
    assert.equal(withoutTrustGraph.metadata.provenance, 'Inferred');
    assert.equal(withTrustGraph.metadata.provenance, 'Inferred');
    assert.equal(
        (
            withoutTrustGraph.metadata as ResponseMetadata & {
                trustGraph?: unknown;
            }
        ).trustGraph,
        undefined
    );
    assert.ok(
        (
            withTrustGraph.metadata as ResponseMetadata & {
                trustGraph?: unknown;
            }
        ).trustGraph
    );
});

test('orchestrator scope builder keeps sessionId correlation-only and uses explicit surface scope fields', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });

    let capturedScopeTuple: ScopeTuple | undefined;
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ maxOutputTokens }) => {
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            safetyTier: 'Low',
                            reasoning: 'Standard message reply.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                return {
                    text: 'message with explicit-scope advisory evidence',
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    citations: [],
                };
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        executionContractTrustGraph: {
            adapter: {
                async getEvidenceBundle(input) {
                    capturedScopeTuple = input.scopeTuple;
                    return buildEvidenceBundle(input.scopeTuple);
                },
            },
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy:
                TrustGraphOwnershipValidationPolicy.required({
                    policyId: 'chat_orchestrator_runtime_policy',
                }),
            scopeOwnershipValidator,
        },
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            sessionId: 'session_should_not_be_project_scope',
            surfaceContext: {
                userId: 'user_1',
                channelId: 'project_1',
            },
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(capturedScopeTuple?.userId, 'user_1');
    assert.equal(capturedScopeTuple?.projectId, 'project_1');
    assert.notEqual(
        capturedScopeTuple?.projectId,
        'session_should_not_be_project_scope'
    );
});

test('orchestrator does not backfill TrustGraph project scope from sessionId when explicit scope fields are absent', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });

    let adapterInvoked = false;
    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ maxOutputTokens }) => {
                if (maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            safetyTier: 'Low',
                            reasoning: 'Standard message reply.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                return {
                    text: 'message without explicit retrieval scope',
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    citations: [],
                };
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        executionContractTrustGraph: {
            adapter: {
                async getEvidenceBundle(input) {
                    adapterInvoked = true;
                    return buildEvidenceBundle(input.scopeTuple);
                },
            },
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy:
                TrustGraphOwnershipValidationPolicy.required({
                    policyId: 'chat_orchestrator_runtime_policy',
                }),
            scopeOwnershipValidator,
        },
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            sessionId: 'session_only_correlation',
            surfaceContext: {
                userId: 'user_1',
            },
        })
    );

    const trustGraph = (
        response.metadata as ResponseMetadata & {
            trustGraph?: {
                adapterStatus?: string;
            };
        }
    ).trustGraph;
    assert.equal(response.action, 'message');
    assert.equal(adapterInvoked, false);
    assert.equal(trustGraph?.adapterStatus, 'scope_denied');
});
