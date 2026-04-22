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
    };

    assert.deepEqual(buildWorkflowReceiptItems(metadata), [
        'Answered in Balanced mode',
        'Review skipped',
        'Planner fallback',
    ]);
    assert.equal(
        buildWorkflowReceiptSummary(metadata),
        'Answered in Balanced mode • Review skipped • Planner fallback'
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
