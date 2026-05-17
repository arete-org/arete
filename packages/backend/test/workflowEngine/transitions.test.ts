/**
 * @description: Verifies workflow transition/state invariants used by backend orchestration.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineTransitionTests
 * @footnote-risk: medium - Missing coverage can allow transition regressions.
 * @footnote-ethics: high - Transition checks enforce bounded deliberation behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyStepExecutionToState,
    createInitialWorkflowState,
    isWorkflowTransitionAllowed,
    type WorkflowRunPolicy,
} from '../../src/services/workflowEngine.js';

const permissivePolicy: WorkflowRunPolicy = {
    enablePlanning: true,
    enableToolUse: true,
    enableReplanning: true,
    enableAssessment: true,
    enableRevision: true,
};

const strictPolicy: WorkflowRunPolicy = {
    enablePlanning: false,
    enableToolUse: false,
    enableReplanning: false,
    enableAssessment: false,
    enableRevision: false,
};

test('isWorkflowTransitionAllowed permits only plan/generate from initial state', () => {
    assert.equal(
        isWorkflowTransitionAllowed(null, 'plan', permissivePolicy),
        true
    );
    assert.equal(
        isWorkflowTransitionAllowed(null, 'tool', permissivePolicy),
        true
    );
    assert.equal(
        isWorkflowTransitionAllowed(null, 'generate', permissivePolicy),
        true
    );
    assert.equal(
        isWorkflowTransitionAllowed(null, 'assess', permissivePolicy),
        false
    );
});

test('isWorkflowTransitionAllowed allows plan to generate in permissive policy', () => {
    assert.equal(
        isWorkflowTransitionAllowed('plan', 'generate', permissivePolicy),
        true
    );
});

test('isWorkflowTransitionAllowed enforces policy capability toggles', () => {
    assert.equal(
        isWorkflowTransitionAllowed(null, 'plan', strictPolicy),
        false
    );
    assert.equal(
        isWorkflowTransitionAllowed('generate', 'assess', strictPolicy),
        false
    );
    assert.equal(
        isWorkflowTransitionAllowed('assess', 'revise', strictPolicy),
        false
    );
    assert.equal(
        isWorkflowTransitionAllowed('generate', 'finalize', strictPolicy),
        true
    );
});

test('isWorkflowTransitionAllowed gates plan-to-plan on enableReplanning', () => {
    assert.equal(
        isWorkflowTransitionAllowed('plan', 'plan', {
            ...permissivePolicy,
            enableReplanning: true,
        }),
        true
    );
    assert.equal(
        isWorkflowTransitionAllowed('plan', 'plan', {
            ...permissivePolicy,
            enableReplanning: false,
        }),
        false
    );
});

test('isWorkflowTransitionAllowed makes assess/revise unreachable under generate-only policy', () => {
    const generateOnlyPolicy: WorkflowRunPolicy = {
        enablePlanning: false,
        enableToolUse: false,
        enableReplanning: false,
        enableGeneration: true,
        enableAssessment: false,
        enableRevision: false,
    };

    assert.equal(
        isWorkflowTransitionAllowed('generate', 'assess', generateOnlyPolicy),
        false
    );
    assert.equal(
        isWorkflowTransitionAllowed('assess', 'revise', generateOnlyPolicy),
        false
    );
    assert.equal(
        isWorkflowTransitionAllowed('generate', 'revise', generateOnlyPolicy),
        false
    );
    assert.equal(
        isWorkflowTransitionAllowed(null, 'generate', generateOnlyPolicy),
        true
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

test('applyStepExecutionToState sanitizes invalid deltas and increments stepCount by exactly 1', () => {
    const initial = createInitialWorkflowState({
        workflowId: 'wf_2',
        workflowName: 'workflow_test',
        startedAtMs: 200,
    });
    const nanUpdated = applyStepExecutionToState(
        initial,
        'generate',
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -2
    );
    assert.equal(nanUpdated.stepCount, 1);
    assert.equal(nanUpdated.totalTokens, 0);
    assert.equal(nanUpdated.toolCallCount, 0);
    assert.equal(nanUpdated.deliberationCallCount, 0);

    const fractionalUpdated = applyStepExecutionToState(
        nanUpdated,
        'assess',
        3.9,
        2.2,
        1.8
    );
    assert.equal(fractionalUpdated.stepCount, 2);
    assert.equal(fractionalUpdated.totalTokens, 3);
    assert.equal(fractionalUpdated.toolCallCount, 2);
    assert.equal(fractionalUpdated.deliberationCallCount, 1);
});
