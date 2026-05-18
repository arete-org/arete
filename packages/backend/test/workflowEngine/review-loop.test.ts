/**
 * @description: Verifies reviewed workflow generation/assess/revise loop behavior.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineReviewLoopTests
 * @footnote-risk: medium - Loop regressions can change termination/fail-open behavior.
 * @footnote-ethics: high - Reviewed loop shapes safety and auditability outcomes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerationRuntime } from '@footnote/agent-runtime';
import type { ModelProfile } from '@footnote/contracts';
import { runBoundedReviewWorkflowForTest } from './helpers.js';

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

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
        },
        messagesWithHints: [{ role: 'user', content: 'hi' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
            reviewDecision: 'finalize',
            reviewReason: 'done',
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

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
        },
        messagesWithHints: [{ role: 'user', content: 'hi' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
    assert.deepEqual(result.workflowLineage.limitStop, {
        stoppedByLimit: false,
        terminationReason: 'goal_satisfied',
    });
    const tokensLimit = result.workflowLineage.effectiveLimits?.find(
        (limit) => limit.key === 'maxTokensTotal'
    );
    assert.ok(tokensLimit);
    assert.equal(tokensLimit.state, 'unavailable');
    assert.equal(tokensLimit.value, undefined);
});

test('runBoundedReviewWorkflow marks configured-inactive limits when their workflow paths are disabled', async () => {
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

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
        },
        messagesWithHints: [{ role: 'user', content: 'hi' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 0,
            maxDurationMs: 15000,
            executionLimits: {
                maxWorkflowSteps: 2,
                maxToolCalls: 0,
                maxDeliberationCalls: 0,
                maxTokensTotal: Number.MAX_SAFE_INTEGER,
                maxDurationMs: 15000,
            },
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: false,
            enableRevision: false,
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

    const toolLimit = result.workflowLineage.effectiveLimits?.find(
        (limit) => limit.key === 'maxToolCalls'
    );
    const deliberationLimit = result.workflowLineage.effectiveLimits?.find(
        (limit) => limit.key === 'maxDeliberationCalls'
    );
    assert.ok(toolLimit);
    assert.equal(toolLimit.state, 'configured_inactive');
    assert.equal(toolLimit.value, 0);
    assert.equal(toolLimit.stoppedRun, false);
    assert.ok(deliberationLimit);
    assert.equal(deliberationLimit.state, 'configured_inactive');
    assert.equal(deliberationLimit.value, 0);
    assert.equal(deliberationLimit.stoppedRun, false);
});

test('runBoundedReviewWorkflow records explicit limit stop attribution for exhausted limits', async () => {
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

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
        },
        messagesWithHints: [{ role: 'user', content: 'hi' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 2,
            maxDurationMs: 15000,
            executionLimits: {
                maxWorkflowSteps: 4,
                maxToolCalls: 1,
                maxDeliberationCalls: 1,
                maxTokensTotal: 500,
                maxDurationMs: 15000,
            },
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
        parseReviewDecision: () => ({
            reviewDecision: 'revise',
            reviewReason: 'One revision pass is required.',
            revisionInstruction: 'Tighten wording and remove redundancy.',
        }),
    });

    assert.equal(result.outcome, 'generated');
    assert.equal(
        result.workflowLineage.terminationReason,
        'budget_exhausted_steps'
    );
    assert.deepEqual(result.workflowLineage.limitStop, {
        stoppedByLimit: true,
        terminationReason: 'budget_exhausted_steps',
        exhaustedLimitKey: 'maxWorkflowSteps',
    });
    const stepsLimit = result.workflowLineage.effectiveLimits?.find(
        (limit) => limit.key === 'maxWorkflowSteps'
    );
    assert.ok(stepsLimit);
    assert.equal(stepsLimit.state, 'enforced');
    assert.equal(stepsLimit.stoppedRun, true);
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

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'hi' }],
        },
        messagesWithHints: [{ role: 'user', content: 'hi' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
                    text: '{"reviewDecision":"finalize","reviewReason":"Draft is complete and clear."}',
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

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Summarize this.' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Summarize this.' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
    assert.equal(assessStep.outcome.signals?.traceAlignment, 'aligned');
    assert.equal(generationCalls, 2);
});

test('runBoundedReviewWorkflow executes engine-bounded refinement path without revise step kind', async () => {
    let generationCalls = 0;
    const generationInputs: Parameters<GenerationRuntime['generate']>[0][] = [];
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(input) {
            generationInputs.push(input);
            generationCalls += 1;
            if (generationCalls === 1) {
                return {
                    text: 'initial draft',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 10,
                        completionTokens: 10,
                        totalTokens: 20,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            if (generationCalls === 2) {
                return {
                    text: '{"reviewDecision":"revise","reviewReason":"Need tighter wording.","revisionInstruction":"Trim and soften the phrasing.","moduleHints":["natural_human_style","unknown_module"],"concerns":{"style":"too_stiff","length":"too_long"}}',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 5,
                        completionTokens: 5,
                        totalTokens: 10,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            if (generationCalls === 3) {
                return {
                    text: 'refined draft',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 8,
                        completionTokens: 8,
                        totalTokens: 16,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            return {
                text: '{"reviewDecision":"finalize","reviewReason":"Now complete."}',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 5,
                    completionTokens: 5,
                    totalTokens: 10,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Draft answer' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Draft answer' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 3,
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
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
            promptTokens: generationResult.usage?.promptTokens ?? 0,
            completionTokens: generationResult.usage?.completionTokens ?? 0,
            totalTokens: generationResult.usage?.totalTokens ?? 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
        reviewModuleIds: ['concise_answer', 'natural_human_style'],
    });

    assert.equal(result.outcome, 'generated');
    assert.equal(result.workflowLineage.status, 'completed');
    assert.equal(result.workflowLineage.terminationReason, 'goal_satisfied');
    assert.equal(
        result.workflowLineage.steps.some((step) => step.stepKind === 'revise'),
        false
    );
    const assessReviseStep = result.workflowLineage.steps.find(
        (step) =>
            step.stepKind === 'assess' &&
            step.outcome.signals?.reviewDecision === 'revise'
    );
    assert.ok(assessReviseStep);
    assert.equal(assessReviseStep.outcome.signals?.refinementRequested, true);
    assert.equal(
        assessReviseStep.outcome.signals?.revisionInstruction,
        'Trim and soften the phrasing.'
    );
    assert.equal(assessReviseStep.outcome.signals?.traceAlignment, 'aligned');
    assert.equal(assessReviseStep.outcome.signals?.moduleHintCount, 1);
    assert.equal(
        assessReviseStep.outcome.signals?.moduleHintIdsCsv,
        'natural_human_style'
    );
    assert.equal(assessReviseStep.outcome.signals?.styleConcern, 'too_stiff');
    assert.equal(assessReviseStep.outcome.signals?.lengthConcern, 'too_long');
    const refinementGenerateStep = result.workflowLineage.steps.find(
        (step) =>
            step.stepKind === 'generate' &&
            step.outcome.signals?.refinementApplied === true
    );
    assert.ok(refinementGenerateStep);
    assert.equal(
        refinementGenerateStep.outcome.signals?.refinementSourceStepId,
        assessReviseStep.stepId
    );
    assert.equal(refinementGenerateStep.outcome.signals?.appliedModuleCount, 1);
    assert.equal(
        refinementGenerateStep.outcome.signals?.appliedModuleIdsCsv,
        'natural_human_style'
    );
    const refineInput = generationInputs[2];
    assert.ok(refineInput);
    const refineSystemMessage = refineInput.messages
        .filter((message) => message.role === 'system')
        .at(-1);
    assert.ok(refineSystemMessage);
    assert.match(refineSystemMessage.content, /Revision instruction:/);
    assert.match(refineSystemMessage.content, /Trim and soften the phrasing\./);
    assert.equal(refineSystemMessage.content.includes('unknown_module'), false);
});

test('runBoundedReviewWorkflow marks requested-but-blocked refinement without refinementApplied signals', async () => {
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
                        promptTokens: 10,
                        completionTokens: 10,
                        totalTokens: 20,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            return {
                text: '{"reviewDecision":"revise","reviewReason":"Need one refinement.","revisionInstruction":"Shorten and clarify."}',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 5,
                    completionTokens: 5,
                    totalTokens: 10,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Draft answer' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Draft answer' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 2,
            maxDurationMs: 15000,
            executionLimits: {
                maxWorkflowSteps: 8,
                maxToolCalls: 0,
                maxPlanCycles: 2,
                maxReviewCycles: 2,
                maxDeliberationCalls: 6,
                maxTokensTotal: Number.MAX_SAFE_INTEGER,
                maxDurationMs: 15000,
            },
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: false,
        },
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
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
    assert.equal(result.workflowLineage.status, 'degraded');
    assert.equal(
        result.workflowLineage.terminationReason,
        'transition_blocked_by_policy'
    );
    assert.equal(
        result.workflowLineage.steps.some(
            (step) => step.outcome.signals?.refinementApplied === true
        ),
        false
    );
});

test('runBoundedReviewWorkflow fail-opens when assess revise omits required revisionInstruction', async () => {
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
                        promptTokens: 10,
                        completionTokens: 10,
                        totalTokens: 20,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            return {
                text: '{"reviewDecision":"revise","reviewReason":"Need one refinement."}',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 5,
                    completionTokens: 5,
                    totalTokens: 10,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Draft answer' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Draft answer' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
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
    assert.equal(result.generationResult.text, 'initial draft');
    assert.equal(result.workflowLineage.status, 'degraded');
    assert.equal(
        result.workflowLineage.terminationReason,
        'executor_error_fail_open'
    );
    assert.equal(
        result.workflowLineage.steps.some(
            (step) => step.outcome.signals?.refinementApplied === true
        ),
        false
    );
});

test('runBoundedReviewWorkflow persists assess TRACE alignment signals when provided', async () => {
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
                        promptTokens: 10,
                        completionTokens: 10,
                        totalTokens: 20,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }

            return {
                text: '{"reviewDecision":"finalize","reviewReason":"Ready to ship.","traceAlignment":"misaligned","traceAlignmentReason":"Need tighter caution tone.","finalTemperament":{"caution":4}}',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 5,
                    completionTokens: 5,
                    totalTokens: 10,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Draft answer' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Draft answer' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
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
    const assessStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'assess'
    );
    assert.ok(assessStep);
    assert.equal(assessStep.outcome.status, 'executed');
    assert.equal(assessStep.outcome.signals?.traceAlignment, 'misaligned');
    assert.equal(
        assessStep.outcome.signals?.traceAlignmentReason,
        'Need tighter caution tone.'
    );
    assert.equal(assessStep.outcome.signals?.finalTemperamentCaution, 4);
});

test('runBoundedReviewWorkflow can use independent generate and assess model chains', async () => {
    const seenModels: string[] = [];
    let generationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(input) {
            seenModels.push(input.model ?? 'unknown-model');
            generationCalls += 1;
            if (generationCalls === 1) {
                return {
                    text: 'initial draft',
                    model: input.model,
                    usage: {
                        promptTokens: 10,
                        completionTokens: 10,
                        totalTokens: 20,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            return {
                text: '{"reviewDecision":"finalize","reviewReason":"Done."}',
                model: input.model,
                usage: {
                    promptTokens: 5,
                    completionTokens: 5,
                    totalTokens: 10,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const generateProfile: ModelProfile = {
        id: 'openai-text-medium',
        description: 'Generate profile',
        provider: 'openai',
        providerModel: 'gpt-5.4-mini',
        enabled: true,
        tierBindings: ['text-medium'],
        capabilities: { canUseSearch: true },
    };
    const assessProfile: ModelProfile = {
        id: 'ollama-text-gptoss',
        description: 'Assess profile',
        provider: 'ollama',
        providerModel: 'gpt-oss:20b-cloud',
        enabled: true,
        tierBindings: ['text-medium'],
        capabilities: { canUseSearch: false },
    };
    const enabledProfilesById = new Map<string, ModelProfile>([
        [generateProfile.id, generateProfile],
        [assessProfile.id, assessProfile],
    ]);

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Draft answer' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Draft answer' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
            promptTokens: generationResult.usage?.promptTokens ?? 0,
            completionTokens: generationResult.usage?.completionTokens ?? 0,
            totalTokens: generationResult.usage?.totalTokens ?? 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
        stepRoutingChainSet: {
            enabledProfilesById,
            generateCandidates: [
                {
                    profileId: generateProfile.id,
                    chooseOneUsed: false,
                },
            ],
            assessCandidates: [
                {
                    profileId: assessProfile.id,
                    chooseOneUsed: false,
                },
            ],
        },
    });

    assert.equal(result.outcome, 'generated');
    assert.equal(seenModels[0], 'gpt-5.4-mini');
    assert.equal(seenModels[1], 'gpt-oss:20b-cloud');
});

test('runBoundedReviewWorkflow applies assess hints to revision routing order', async () => {
    const seenModels: string[] = [];
    let generationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(input) {
            seenModels.push(input.model ?? 'unknown-model');
            generationCalls += 1;
            if (generationCalls === 1) {
                return {
                    text: 'initial draft',
                    model: input.model,
                    usage: {
                        promptTokens: 10,
                        completionTokens: 10,
                        totalTokens: 20,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            if (generationCalls === 2) {
                return {
                    text: '{"reviewDecision":"revise","reviewReason":"Need less AI-speak and more precise logic.","revisionInstruction":"Apply style and logic edits.","routingHints":["style.ai_speak_down","logic.precision_up"]}',
                    model: input.model,
                    usage: {
                        promptTokens: 5,
                        completionTokens: 5,
                        totalTokens: 10,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }
            return {
                text: 'refined draft',
                model: input.model,
                usage: {
                    promptTokens: 6,
                    completionTokens: 6,
                    totalTokens: 12,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const openAiGenerateProfile: ModelProfile = {
        id: 'openai-text-medium',
        description: 'OpenAI generate profile',
        provider: 'openai',
        providerModel: 'gpt-5.4-mini',
        enabled: true,
        tierBindings: ['text-medium'],
        capabilities: { canUseSearch: true },
        costClass: 'medium',
    };
    const ollamaGenerateProfile: ModelProfile = {
        id: 'ollama-text-gptoss',
        description: 'Ollama style profile',
        provider: 'ollama',
        providerModel: 'gpt-oss:20b-cloud',
        enabled: true,
        tierBindings: ['text-medium'],
        capabilities: { canUseSearch: false },
        costClass: 'low',
    };
    const assessProfile: ModelProfile = {
        id: 'openai-json-optimized',
        description: 'Assess profile',
        provider: 'openai',
        providerModel: 'gpt-5.4-nano',
        enabled: true,
        tierBindings: [],
        capabilities: { canUseSearch: true },
        costClass: 'low',
    };
    const enabledProfilesById = new Map<string, ModelProfile>([
        [openAiGenerateProfile.id, openAiGenerateProfile],
        [ollamaGenerateProfile.id, ollamaGenerateProfile],
        [assessProfile.id, assessProfile],
    ]);

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Draft answer' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Draft answer' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
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
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
            promptTokens: generationResult.usage?.promptTokens ?? 0,
            completionTokens: generationResult.usage?.completionTokens ?? 0,
            totalTokens: generationResult.usage?.totalTokens ?? 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
        stepRoutingChainSet: {
            enabledProfilesById,
            generateCandidates: [
                {
                    profileId: ollamaGenerateProfile.id,
                    chooseOneUsed: true,
                },
                {
                    profileId: openAiGenerateProfile.id,
                    chooseOneUsed: false,
                },
            ],
            assessCandidates: [
                {
                    profileId: assessProfile.id,
                    chooseOneUsed: false,
                },
            ],
        },
    });

    assert.equal(result.outcome, 'generated');
    assert.equal(seenModels[0], 'gpt-oss:20b-cloud');
    assert.equal(seenModels[1], 'gpt-5.4-nano');
    // logic + style hints => logic precedence => OpenAI first for revision
    assert.equal(seenModels[2], 'gpt-5.4-mini');

    const revisionStep = result.workflowLineage.steps.find(
        (step) =>
            step.stepKind === 'generate' &&
            step.outcome.signals?.refinementApplied === true
    );
    assert.ok(revisionStep);
    assert.equal(
        revisionStep.outcome.signals?.routingHintApplied,
        'openai_first_logic'
    );
    assert.equal(
        revisionStep.outcome.signals?.routingHintConflictResolved,
        'logic_over_style'
    );
});
