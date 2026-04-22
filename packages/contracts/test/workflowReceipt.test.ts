/**
 * @description: Verifies shared workflow receipt helpers stay conservative and fail-open.
 * @footnote-scope: test
 * @footnote-module: WorkflowReceiptTests
 * @footnote-risk: low - Tests only cover deterministic receipt text mapping.
 * @footnote-ethics: high - Receipt wording must avoid overclaims and reflect real workflow state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildWorkflowReceiptItems,
    buildWorkflowReceiptSummary,
    summarizeGroundingEvidence,
    type ResponseMetadata,
} from '../src/ethics-core';

const createBaseMetadata = (): ResponseMetadata => ({
    responseId: 'resp_1',
    provenance: 'Inferred',
    safetyTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'hash_1',
    licenseContext: 'MIT',
    modelVersion: 'gpt-5-mini',
    staleAfter: '2026-04-22T00:00:00.000Z',
    citations: [],
    trace_target: {
        tightness: 3,
        rationale: 3,
        attribution: 3,
        caution: 3,
        extent: 3,
    },
    trace_final: {
        tightness: 3,
        rationale: 3,
        attribution: 3,
        caution: 3,
        extent: 3,
    },
});

test('buildWorkflowReceiptItems renders mode, review, and planner fallback signals', () => {
    const metadata: ResponseMetadata = {
        ...createBaseMetadata(),
        workflowMode: {
            modeId: 'balanced',
            selectedBy: 'requested_mode',
            selectionReason: 'Requested by user.',
            initial_mode: 'balanced',
            behavior: {
                executionContractPresetId: 'balanced',
                workflowProfileClass: 'reviewed',
                workflowProfileId: 'bounded-review',
                workflowExecution: 'policy_gated',
                reviewPass: 'excluded',
                reviseStep: 'allowed',
                evidencePosture: 'balanced',
                maxWorkflowSteps: 6,
                maxDeliberationCalls: 2,
            },
        },
        execution: [
            {
                kind: 'planner',
                status: 'failed',
                purpose: 'chat_orchestrator_action_selection',
                contractType: 'fallback',
                applyOutcome: 'not_applied',
                mattered: false,
                matteredControlIds: [],
                reasonCode: 'planner_runtime_error',
            },
        ],
        reviewRuntime: {
            label: 'fallback',
        },
    };

    assert.deepEqual(buildWorkflowReceiptItems(metadata), [
        'Answered in Balanced mode',
        'Review fallback',
        'Planner fallback',
    ]);
    assert.equal(
        buildWorkflowReceiptSummary(metadata),
        'Answered in Balanced mode • Review fallback • Planner fallback'
    );
});

test('buildWorkflowReceiptItems marks reviewed only when assess step ran', () => {
    const metadata: ResponseMetadata = {
        ...createBaseMetadata(),
        workflowMode: {
            modeId: 'grounded',
            selectedBy: 'requested_mode',
            selectionReason: 'Requested by user.',
            initial_mode: 'grounded',
            behavior: {
                executionContractPresetId: 'quality-grounded',
                workflowProfileClass: 'reviewed',
                workflowProfileId: 'bounded-review',
                workflowExecution: 'always',
                reviewPass: 'included',
                reviseStep: 'allowed',
                evidencePosture: 'strict',
                maxWorkflowSteps: 8,
                maxDeliberationCalls: 3,
            },
        },
        workflow: {
            workflowId: 'wf_1',
            workflowName: 'message_with_review_loop',
            status: 'completed',
            terminationReason: 'goal_satisfied',
            stepCount: 1,
            maxSteps: 8,
            maxDurationMs: 15000,
            steps: [
                {
                    stepId: 'step_assess_1',
                    attempt: 1,
                    stepKind: 'assess',
                    startedAt: '2026-04-22T00:00:00.000Z',
                    finishedAt: '2026-04-22T00:00:00.010Z',
                    durationMs: 10,
                    outcome: {
                        status: 'executed',
                        summary: 'Reviewed draft.',
                    },
                },
            ],
        },
    };

    assert.deepEqual(buildWorkflowReceiptItems(metadata), [
        'Answered in Grounded mode',
        'Reviewed before final answer',
    ]);
});

test('buildWorkflowReceiptItems surfaces explicit missing grounding evidence states', () => {
    const metadata: ResponseMetadata = {
        ...createBaseMetadata(),
        workflowMode: {
            modeId: 'grounded',
            selectedBy: 'requested_mode',
            selectionReason: 'Requested by user.',
            initial_mode: 'grounded',
            behavior: {
                executionContractPresetId: 'quality-grounded',
                workflowProfileClass: 'reviewed',
                workflowProfileId: 'bounded-review',
                workflowExecution: 'always',
                reviewPass: 'included',
                reviseStep: 'allowed',
                evidencePosture: 'strict',
                maxWorkflowSteps: 8,
                maxDeliberationCalls: 3,
            },
        },
        provenanceAssessment: {
            methodId: 'deterministic_multi_signal_v1',
            methodLabel:
                'Deterministic multi-signal provenance classification (backend)',
            signals: {
                citationsPresent: false,
                retrievalRequested: true,
                retrievalUsed: true,
                retrievalToolExecuted: true,
                workflowEvidence: false,
                trustGraphEvidenceAvailable: false,
                trustGraphEvidenceUsed: false,
                assistantDeclaredSpeculative: false,
            },
            conflicts: ['retrieval_used_without_citations'],
            limitations: [
                'Retrieval ran, but no citations were retained after normalization.',
            ],
        },
    };

    assert.deepEqual(buildWorkflowReceiptItems(metadata), [
        'Answered in Grounded mode',
        'No sources available',
    ]);
});

test('buildWorkflowReceiptItems surfaces attached sources when citations are present', () => {
    const metadata: ResponseMetadata = {
        ...createBaseMetadata(),
        citations: [{ title: 'Source', url: 'https://example.com' }],
    };

    assert.deepEqual(buildWorkflowReceiptItems(metadata), [
        'Sources available',
    ]);
});

test('summarizeGroundingEvidence reports search-unavailable copy from execution metadata', () => {
    const metadata: ResponseMetadata = {
        ...createBaseMetadata(),
        execution: [
            {
                kind: 'tool',
                status: 'skipped',
                toolName: 'web_search',
                reasonCode: 'search_not_supported_by_selected_profile',
            },
        ],
    };

    assert.deepEqual(summarizeGroundingEvidence(metadata), {
        status: 'search_unavailable',
        label: 'Search unavailable',
        explanation:
            'Search was unavailable for this mode, so this response has no source links. Treat important claims as unverified.',
    });
});

test('summarizeGroundingEvidence stays conservative when no evidence reason was recorded', () => {
    const metadata: ResponseMetadata = createBaseMetadata();

    assert.deepEqual(summarizeGroundingEvidence(metadata), {
        status: 'not_recorded',
        label: 'No grounding evidence recorded',
        explanation:
            'This trace does not include sources or a recorded reason for missing evidence. Treat important claims as unverified.',
    });
});

test('buildWorkflowReceiptItems reports revised label from normalized review runtime summary', () => {
    const metadata: ResponseMetadata = {
        ...createBaseMetadata(),
        reviewRuntime: {
            label: 'revised',
        },
    };

    assert.deepEqual(buildWorkflowReceiptItems(metadata), [
        'Reviewed and revised before final answer',
    ]);
});

test('buildWorkflowReceiptSummary stays fail-open for legacy partial metadata', () => {
    const partialMetadata = {
        ...createBaseMetadata(),
        workflowMode: {
            modeId: 'fast',
        },
        workflow: {},
    } as unknown as ResponseMetadata;

    assert.equal(
        buildWorkflowReceiptSummary(partialMetadata),
        'Answered in Fast mode'
    );
});

test('buildWorkflowReceiptItems falls back to deterministic review derivation for legacy traces without reviewRuntime', () => {
    const metadata: ResponseMetadata = {
        ...createBaseMetadata(),
        workflowMode: {
            modeId: 'grounded',
            selectedBy: 'requested_mode',
            selectionReason: 'Requested by user.',
            initial_mode: 'grounded',
            behavior: {
                executionContractPresetId: 'quality-grounded',
                workflowProfileClass: 'reviewed',
                workflowProfileId: 'bounded-review',
                workflowExecution: 'always',
                reviewPass: 'included',
                reviseStep: 'allowed',
                evidencePosture: 'strict',
                maxWorkflowSteps: 2,
                maxDeliberationCalls: 1,
            },
        },
        workflow: {
            workflowId: 'wf_legacy_1',
            workflowName: 'message_with_review_loop',
            status: 'degraded',
            terminationReason: 'budget_exhausted_steps',
            stepCount: 1,
            maxSteps: 2,
            maxDurationMs: 5000,
            steps: [
                {
                    stepId: 'step_generate_1',
                    attempt: 1,
                    stepKind: 'generate',
                    startedAt: '2026-04-22T00:00:00.000Z',
                    finishedAt: '2026-04-22T00:00:00.010Z',
                    durationMs: 10,
                    outcome: {
                        status: 'executed',
                        summary: 'Generated initial draft response.',
                    },
                },
            ],
        },
    };

    assert.deepEqual(buildWorkflowReceiptItems(metadata), [
        'Answered in Grounded mode',
        'Review skipped',
    ]);
});
