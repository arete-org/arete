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
    runBoundedReviewWorkflow,
    type ExecutionLimits,
    type WorkflowPolicy,
} from '../src/services/workflowEngine.js';
import type { GenerationRuntime } from '@footnote/agent-runtime';

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

test('runBoundedReviewWorkflow enforces legality before initial generate execution', async () => {
    let generationCalls = 0;
    let usageCaptures = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            return {
                text: 'should not run',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 10,
                    completionTokens: 5,
                    totalTokens: 15,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const result = await runBoundedReviewWorkflow({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
        },
        messagesWithHints: [{ role: 'user', content: 'hi' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop_v1',
            maxIterations: 2,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: false,
            enableAssessment: true,
            enableRevision: true,
        },
        reviewDecisionPrompt: 'json',
        revisionPromptPrefix: 'revise',
        parseReviewDecision: () => ({
            decision: 'finalize',
            reason: 'done',
        }),
        captureUsage: () => {
            usageCaptures += 1;
            return {
                model: 'gpt-5-mini',
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                estimatedCost: {
                    inputCostUsd: 0,
                    outputCostUsd: 0,
                    totalCostUsd: 0,
                },
            };
        },
    });

    assert.equal(generationCalls, 0);
    assert.equal(usageCaptures, 0);
    assert.equal(result.outcome, 'no_generation');
    assert.equal(
        result.workflowLineage.terminationReason,
        'transition_blocked_by_policy'
    );
    assert.equal(result.workflowLineage.stepCount, 0);
    assert.equal(result.workflowLineage.steps.length, 0);
});

test('runBoundedReviewWorkflow normalizes invalid config bounds and keeps lineage schema-safe', async () => {
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            return {
                text: 'draft',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 10,
                    completionTokens: 5,
                    totalTokens: 15,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const result = await runBoundedReviewWorkflow({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
        },
        messagesWithHints: [{ role: 'user', content: 'hi' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop_v1',
            maxIterations: Number.NaN,
            maxDurationMs: Number.NaN,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        captureUsage: () => ({
            model: 'gpt-5-mini',
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
    });

    assert.equal(result.outcome, 'generated');
    assert.equal(result.workflowLineage.status, 'completed');
    assert.equal(result.workflowLineage.terminationReason, 'goal_satisfied');
    assert.equal(result.workflowLineage.maxSteps, 1);
    assert.ok(result.workflowLineage.maxDurationMs > 0);
    assert.equal(result.workflowLineage.stepCount, 1);
});
