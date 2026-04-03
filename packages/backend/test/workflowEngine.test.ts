/**
 * @description: Verifies workflow-engine transition and limit invariants used by backend orchestration.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineTests
 * @footnote-risk: medium - Missing coverage can allow transition or budget regressions in shared orchestration logic.
 * @footnote-ethics: high - Workflow bounds and legality checks enforce auditable, fail-open-safe model control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyStepExecutionToState,
    createInitialWorkflowState,
    isTransitionAllowed,
    isWithinExecutionLimits,
    mapExhaustedLimitToTerminationReason,
    type ExecutionLimits,
    type WorkflowPolicy,
} from '../src/services/workflowEngine.js';

const permissivePolicy: WorkflowPolicy = {
    enablePlanning: true,
    enableToolUse: true,
    enableReplanning: true,
    enableAssessment: true,
    enableRevision: true,
};

const strictPolicy: WorkflowPolicy = {
    enablePlanning: false,
    enableToolUse: false,
    enableReplanning: false,
    enableAssessment: false,
    enableRevision: false,
};

const createLimits = (): ExecutionLimits => ({
    maxWorkflowSteps: 5,
    maxToolCalls: 2,
    maxDeliberationCalls: 3,
    maxTokensTotal: 100,
    maxDurationMs: 1000,
});

test('isTransitionAllowed permits only plan/generate from initial state', () => {
    assert.equal(isTransitionAllowed(null, 'plan', permissivePolicy), true);
    assert.equal(isTransitionAllowed(null, 'generate', permissivePolicy), true);
    assert.equal(isTransitionAllowed(null, 'assess', permissivePolicy), false);
});

test('isTransitionAllowed enforces policy capability toggles', () => {
    assert.equal(isTransitionAllowed(null, 'plan', strictPolicy), false);
    assert.equal(
        isTransitionAllowed('generate', 'assess', strictPolicy),
        false
    );
    assert.equal(isTransitionAllowed('assess', 'revise', strictPolicy), false);
    assert.equal(
        isTransitionAllowed('generate', 'finalize', strictPolicy),
        true
    );
});

test('isTransitionAllowed gates plan-to-plan on enableReplanning', () => {
    assert.equal(
        isTransitionAllowed('plan', 'plan', {
            ...permissivePolicy,
            enableReplanning: true,
        }),
        true
    );
    assert.equal(
        isTransitionAllowed('plan', 'plan', {
            ...permissivePolicy,
            enableReplanning: false,
        }),
        false
    );
});

test('applyStepExecutionToState increments counters deterministically', () => {
    const initial = createInitialWorkflowState({
        workflowId: 'wf_1',
        workflowName: 'workflow_test',
        startedAtMs: 100,
    });
    const updated = applyStepExecutionToState(initial, 'assess', 33, 1, 1);

    assert.equal(updated.currentStepKind, 'assess');
    assert.equal(updated.stepCount, 1);
    assert.equal(updated.toolCallCount, 1);
    assert.equal(updated.deliberationCallCount, 1);
    assert.equal(updated.totalTokens, 33);
});

test('isWithinExecutionLimits reports each exhausted limit key', () => {
    const limits = createLimits();
    const startedAtMs = 500;
    const nowMs = 1500;

    const exhaustedBySteps = isWithinExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'generate',
            stepCount: 5,
            toolCallCount: 0,
            deliberationCallCount: 0,
            totalTokens: 0,
        },
        limits,
        nowMs
    );
    assert.equal(exhaustedBySteps.withinLimits, false);
    assert.equal(exhaustedBySteps.exhaustedBy, 'maxWorkflowSteps');

    const exhaustedByTools = isWithinExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'generate',
            stepCount: 0,
            toolCallCount: 2,
            deliberationCallCount: 0,
            totalTokens: 0,
        },
        limits,
        nowMs
    );
    assert.equal(exhaustedByTools.withinLimits, false);
    assert.equal(exhaustedByTools.exhaustedBy, 'maxToolCalls');

    const exhaustedByDeliberation = isWithinExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'assess',
            stepCount: 0,
            toolCallCount: 0,
            deliberationCallCount: 3,
            totalTokens: 0,
        },
        limits,
        nowMs
    );
    assert.equal(exhaustedByDeliberation.withinLimits, false);
    assert.equal(exhaustedByDeliberation.exhaustedBy, 'maxDeliberationCalls');

    const exhaustedByTokens = isWithinExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'assess',
            stepCount: 0,
            toolCallCount: 0,
            deliberationCallCount: 0,
            totalTokens: 100,
        },
        limits,
        nowMs
    );
    assert.equal(exhaustedByTokens.withinLimits, false);
    assert.equal(exhaustedByTokens.exhaustedBy, 'maxTokensTotal');

    const exhaustedByDuration = isWithinExecutionLimits(
        {
            workflowId: 'wf_1',
            workflowName: 'workflow_test',
            startedAtMs,
            currentStepKind: 'assess',
            stepCount: 0,
            toolCallCount: 0,
            deliberationCallCount: 0,
            totalTokens: 0,
        },
        limits,
        nowMs
    );
    assert.equal(exhaustedByDuration.withinLimits, false);
    assert.equal(exhaustedByDuration.exhaustedBy, 'maxDurationMs');
});

test('mapExhaustedLimitToTerminationReason maps to canonical reasons', () => {
    assert.equal(
        mapExhaustedLimitToTerminationReason('maxWorkflowSteps'),
        'budget_exhausted_steps'
    );
    assert.equal(
        mapExhaustedLimitToTerminationReason('maxToolCalls'),
        'max_tool_calls_reached'
    );
    assert.equal(
        mapExhaustedLimitToTerminationReason('maxDeliberationCalls'),
        'max_deliberation_calls_reached'
    );
    assert.equal(
        mapExhaustedLimitToTerminationReason('maxTokensTotal'),
        'budget_exhausted_tokens'
    );
    assert.equal(
        mapExhaustedLimitToTerminationReason('maxDurationMs'),
        'budget_exhausted_time'
    );
});
