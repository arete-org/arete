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
    buildPlannerStepRecord,
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

test('isTransitionAllowed allows plan to generate in permissive policy', () => {
    assert.equal(
        isTransitionAllowed('plan', 'generate', permissivePolicy),
        true
    );
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

test('isTransitionAllowed makes assess/revise unreachable under generate-only policy', () => {
    const generateOnlyPolicy: WorkflowPolicy = {
        enablePlanning: false,
        enableToolUse: false,
        enableReplanning: false,
        enableGeneration: true,
        enableAssessment: false,
        enableRevision: false,
    };

    assert.equal(
        isTransitionAllowed('generate', 'assess', generateOnlyPolicy),
        false
    );
    assert.equal(
        isTransitionAllowed('assess', 'revise', generateOnlyPolicy),
        false
    );
    assert.equal(
        isTransitionAllowed('generate', 'revise', generateOnlyPolicy),
        false
    );
    assert.equal(
        isTransitionAllowed(null, 'generate', generateOnlyPolicy),
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

test('isWithinExecutionLimits reports each exhausted limit key', () => {
    const limits = createLimits();
    const startedAtMs = 500;
    const withinDurationNowMs = 1200;
    const exhaustedDurationNowMs = 1500;

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
        withinDurationNowMs
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
        withinDurationNowMs,
        'tool'
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
        withinDurationNowMs,
        'assess'
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
        withinDurationNowMs
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
        exhaustedDurationNowMs
    );
    assert.equal(exhaustedByDuration.withinLimits, false);
    assert.equal(exhaustedByDuration.exhaustedBy, 'maxDurationMs');
});

test('mapExhaustedLimitToTerminationReason maps to expected reasons', () => {
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
            workflowName: 'message_with_review_loop',
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
            workflowName: 'message_with_review_loop',
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

test('runBoundedReviewWorkflow classifies initial generate runtime failure as no_generation with lineage', async () => {
    let generationCalls = 0;
    let usageCaptures = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            throw new Error('runtime unavailable');
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
            workflowName: 'message_with_review_loop',
            maxIterations: 2,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
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

    assert.equal(generationCalls, 1);
    assert.equal(usageCaptures, 0);
    assert.equal(result.outcome, 'no_generation');
    assert.equal(
        result.workflowLineage.terminationReason,
        'executor_error_fail_open'
    );
    assert.equal(result.workflowLineage.status, 'degraded');
    assert.equal(result.workflowLineage.stepCount, 1);
    assert.equal(result.workflowLineage.steps.length, 1);
    assert.equal(result.workflowLineage.steps[0].stepKind, 'generate');
    assert.equal(result.workflowLineage.steps[0].outcome.status, 'failed');
    assert.equal(
        result.workflowLineage.steps[0].reasonCode,
        'generation_runtime_error'
    );
});

test('runBoundedReviewWorkflow persists assess machine decision and reason in lineage signals', async () => {
    let generationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            if (generationCalls === 1) {
                return {
                    text: 'initial draft',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 20,
                        completionTokens: 10,
                        totalTokens: 30,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }

            if (generationCalls === 2) {
                return {
                    text: '{"decision":"finalize","reason":"Draft is complete and clear."}',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 8,
                        completionTokens: 6,
                        totalTokens: 14,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }

            throw new Error(`Unexpected generation call ${generationCalls}`);
        },
    };

    const result = await runBoundedReviewWorkflow({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Summarize this.' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Summarize this.' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop',
            maxIterations: 2,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        captureUsage: (generationResult, requestedModel) => ({
            model: requestedModel ?? generationResult.model ?? 'gpt-5-mini',
            promptTokens: generationResult.usage?.promptTokens ?? 0,
            completionTokens: generationResult.usage?.completionTokens ?? 0,
            totalTokens: generationResult.usage?.totalTokens ?? 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
    });

    assert.equal(result.outcome, 'generated');
    assert.equal(result.workflowLineage.terminationReason, 'goal_satisfied');
    const assessStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'assess'
    );
    assert.ok(assessStep);
    assert.equal(assessStep.outcome.status, 'executed');
    assert.equal(assessStep.outcome.signals?.reviewDecision, 'finalize');
    assert.equal(
        assessStep.outcome.signals?.reviewReason,
        'Draft is complete and clear.'
    );
    assert.equal(generationCalls, 2);
});

test('buildPlannerStepRecord creates schema-safe plan step with bounded planner summary fields', () => {
    const startedAtMs = Date.now() - 24;
    const finishedAtMs = Date.now();
    const step = buildPlannerStepRecord({
        stepId: 'step_plan_1',
        attempt: 1,
        startedAtMs,
        finishedAtMs,
        summary: {
            status: 'executed',
            purpose: 'chat_orchestrator_action_selection',
            contractType: 'structured',
            applyOutcome: 'applied',
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'openai_text_fast',
            selectedCapabilityProfile: 'openai_text_medium',
            profileId: 'planner_profile',
            originalProfileId: 'planner_profile',
            effectiveProfileId: 'planner_profile',
            provider: 'openai',
            model: 'gpt-5-nano',
            usage: {
                promptTokens: 11,
                completionTokens: 7,
                totalTokens: 18,
            },
            cost: {
                inputCostUsd: 0.000001,
                outputCostUsd: 0.000002,
                totalCostUsd: 0.000003,
            },
            mattered: true,
            matteredControlIds: ['provider_preference'],
        },
    });

    assert.equal(step.stepKind, 'plan');
    assert.equal(step.outcome.status, 'executed');
    assert.equal(step.reasonCode, undefined);
    assert.equal(step.outcome.signals?.applyOutcome, 'applied');
    assert.equal(step.outcome.signals?.action, 'message');
    assert.equal(step.outcome.signals?.modality, 'text');
    assert.equal(
        step.outcome.signals?.requestedCapabilityProfile,
        'openai_text_fast'
    );
    assert.equal(
        step.outcome.signals?.selectedCapabilityProfile,
        'openai_text_medium'
    );
    assert.equal(step.outcome.signals?.profileId, 'planner_profile');
    assert.equal(step.outcome.signals?.provider, 'openai');
    assert.equal(step.outcome.signals?.mattered, true);
    assert.equal(step.outcome.signals?.matteredControlCount, 1);
    assert.equal(step.model, 'gpt-5-nano');
    assert.equal(step.usage?.totalTokens, 18);
    assert.equal(step.cost?.totalCostUsd, 0.000003);
    assert.ok(step.durationMs >= 0);
});

test('buildPlannerStepRecord tolerates missing optional planner fields', () => {
    const step = buildPlannerStepRecord({
        stepId: 'step_plan_2',
        attempt: 1,
        finishedAtMs: Date.now(),
        summary: {
            status: 'failed',
            reasonCode: 'planner_runtime_error',
            purpose: 'chat_orchestrator_action_selection',
            contractType: 'fallback',
            applyOutcome: 'not_applied',
        },
    });

    assert.equal(step.stepKind, 'plan');
    assert.equal(step.outcome.status, 'failed');
    assert.equal(step.reasonCode, 'planner_runtime_error');
    assert.equal(step.model, undefined);
    assert.equal(step.usage, undefined);
    assert.equal(step.cost, undefined);
    assert.equal(step.outcome.signals?.applyOutcome, 'not_applied');
    assert.equal(step.outcome.signals?.action, undefined);
});

test('buildPlannerStepRecord does not include raw or noisy planner internals', () => {
    const noisySummary = {
        status: 'executed',
        purpose: 'chat_orchestrator_action_selection',
        contractType: 'text_json',
        applyOutcome: 'adjusted_by_policy',
        action: 'message',
        modality: 'text',
        model: 'gpt-5-nano',
        rawPrompt: 'do not include',
        rawModelOutput: '{"action":"message"}',
        fullPlannerJson: '{"deep":"payload"}',
        fullRequest: { hidden: true },
    } as unknown as Parameters<typeof buildPlannerStepRecord>[0]['summary'];

    const step = buildPlannerStepRecord({
        stepId: 'step_plan_3',
        attempt: 1,
        finishedAtMs: Date.now(),
        summary: noisySummary,
    });

    assert.equal(
        Object.prototype.hasOwnProperty.call(step, 'rawPrompt'),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(step, 'rawModelOutput'),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(step, 'fullPlannerJson'),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(step, 'fullRequest'),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            step.outcome.signals ?? {},
            'rawPrompt'
        ),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            step.outcome.signals ?? {},
            'rawModelOutput'
        ),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            step.outcome.signals ?? {},
            'fullPlannerJson'
        ),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            step.outcome.signals ?? {},
            'fullRequest'
        ),
        false
    );
});
