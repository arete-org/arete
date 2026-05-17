/**
 * @description: Verifies workflow execution-limit checks and termination mappings.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineLimitTests
 * @footnote-risk: medium - Limit regressions can cause runaway or premature stops.
 * @footnote-ethics: high - Bound enforcement is core to safe execution control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkExecutionLimits,
    mapLimitExhaustionToTerminationReason,
    type ExecutionLimits,
} from '../../src/services/workflowEngine.js';

const createLimits = (): ExecutionLimits => ({
    maxWorkflowSteps: 5,
    maxToolCalls: 2,
    maxDeliberationCalls: 3,
    maxTokensTotal: 100,
    maxDurationMs: 1000,
});

test('checkExecutionLimits reports each exhausted limit key', () => {
    const limits = createLimits();
    const startedAtMs = 500;
    const withinDurationNowMs = 1200;
    const exhaustedDurationNowMs = 1500;

    const exhaustedBySteps = checkExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'generate',
            stepCount: 5,
            toolCallCount: 0,
            planCallCount: 0,
            reviewCallCount: 0,
            deliberationCallCount: 0,
            totalTokens: 0,
        },
        limits,
        withinDurationNowMs
    );
    assert.equal(exhaustedBySteps.withinLimits, false);
    assert.equal(exhaustedBySteps.exhaustedBy, 'maxWorkflowSteps');

    const exhaustedByTools = checkExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'generate',
            stepCount: 0,
            toolCallCount: 2,
            planCallCount: 0,
            reviewCallCount: 0,
            deliberationCallCount: 0,
            totalTokens: 0,
        },
        limits,
        withinDurationNowMs,
        'tool'
    );
    assert.equal(exhaustedByTools.withinLimits, false);
    assert.equal(exhaustedByTools.exhaustedBy, 'maxToolCalls');

    const exhaustedByDeliberation = checkExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'assess',
            stepCount: 0,
            toolCallCount: 0,
            planCallCount: 1,
            reviewCallCount: 2,
            deliberationCallCount: 3,
            totalTokens: 0,
        },
        limits,
        withinDurationNowMs,
        'assess'
    );
    assert.equal(exhaustedByDeliberation.withinLimits, false);
    assert.equal(exhaustedByDeliberation.exhaustedBy, 'maxDeliberationCalls');

    const exhaustedByTokens = checkExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'assess',
            stepCount: 0,
            toolCallCount: 0,
            planCallCount: 0,
            reviewCallCount: 0,
            deliberationCallCount: 0,
            totalTokens: 100,
        },
        limits,
        withinDurationNowMs
    );
    assert.equal(exhaustedByTokens.withinLimits, false);
    assert.equal(exhaustedByTokens.exhaustedBy, 'maxTokensTotal');

    const exhaustedByDuration = checkExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'assess',
            stepCount: 0,
            toolCallCount: 0,
            planCallCount: 0,
            reviewCallCount: 0,
            deliberationCallCount: 0,
            totalTokens: 0,
        },
        limits,
        exhaustedDurationNowMs
    );
    assert.equal(exhaustedByDuration.withinLimits, false);
    assert.equal(exhaustedByDuration.exhaustedBy, 'maxDurationMs');
});

test('mapLimitExhaustionToTerminationReason maps to expected reasons', () => {
    assert.equal(
        mapLimitExhaustionToTerminationReason('maxWorkflowSteps'),
        'budget_exhausted_steps'
    );
    assert.equal(
        mapLimitExhaustionToTerminationReason('maxToolCalls'),
        'max_tool_calls_reached'
    );
    assert.equal(
        mapLimitExhaustionToTerminationReason('maxDeliberationCalls'),
        'max_deliberation_calls_reached'
    );
    assert.equal(
        mapLimitExhaustionToTerminationReason('maxTokensTotal'),
        'budget_exhausted_tokens'
    );
    assert.equal(
        mapLimitExhaustionToTerminationReason('maxDurationMs'),
        'budget_exhausted_time'
    );
});
