// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * @description: Verifies workflow-engine transition and limit invariants used by backend orchestration.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineTests
 * @footnote-risk: medium - Missing coverage can allow transition or budget regressions in shared orchestration logic.
 * @footnote-ethics: high - Workflow bounds and legality checks enforce auditable, fail-open-safe model control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyStepExecutionToState,
    buildPlannerStepRecord,
    createInitialWorkflowState,
    isWorkflowTransitionAllowed,
    checkExecutionLimits,
    mapLimitExhaustionToTerminationReason,
    runBoundedReviewWorkflow,
    type ExecutionLimits,
    type WorkflowRunPolicy,
} from '../../src/services/workflowEngine.js';
import type {
    GenerationRuntime,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type { ConversationContextEnvelope } from '../../src/services/conversationContextService.js';

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

const createLimits = (): ExecutionLimits => ({
    maxWorkflowSteps: 5,
    maxToolCalls: 2,
    maxDeliberationCalls: 3,
    maxTokensTotal: 100,
    maxDurationMs: 1000,
});

const TEST_CONTEXT_ENVELOPE: ConversationContextEnvelope = {
    participants: [],
    turns: [],
    diagnostics: {
        surface: 'web',
        totalInputMessages: 0,
        projectedMessageCount: 0,
        trimmedMessageCount: 0,
        sanitizedTimestampCount: 0,
        projectedSpeakerLabelCount: 0,
    },
};

const runBoundedReviewWorkflowForTest = (
    input: Omit<
        Parameters<typeof runBoundedReviewWorkflow>[0],
        'contextEnvelope'
    > & {
        contextEnvelope?: ConversationContextEnvelope;
    }
): ReturnType<typeof runBoundedReviewWorkflow> =>
    runBoundedReviewWorkflow({
        ...input,
        contextEnvelope: input.contextEnvelope ?? TEST_CONTEXT_ENVELOPE,
    });

test('runBoundedReviewWorkflow returns latest safe draft when planner re-entry fails after assess revise', async () => {
    let generationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            if (generationCalls === 1) {
                return {
                    text: 'safe initial draft',
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
                text: '{"reviewDecision":"revise","reviewReason":"Ask planner to refine wording.","revisionInstruction":"Refine wording for clarity."}',
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
            enablePlanning: true,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        plannerStepRequest: {
            workflowId: 'wf_test',
            workflowName: 'message_reviewed',
            attempt: 1,
            request: {
                surface: 'web',
                trigger: { kind: 'submit' },
                latestUserInput: 'Draft answer',
                conversation: [{ role: 'user', content: 'Draft answer' }],
            },
            invocationContext: {
                owner: 'workflow',
                workflowName: 'message_reviewed',
                stepKind: 'plan',
                purpose: 'chat_orchestrator_action_selection',
            },
            capabilityProfiles: [],
        },
        plannerStepExecutor: async (input) => {
            if (input.attempt > 1) {
                throw new Error('planner re-entry failed');
            }
            return {
                plan: {
                    action: 'message',
                    modality: 'text',
                    safetyTier: 'Low',
                    reasoning: 'Continue message flow.',
                    generation: { reasoningEffort: 'low', verbosity: 'low' },
                },
                execution: {
                    status: 'executed',
                    purpose: 'chat_orchestrator_action_selection',
                    contractType: 'structured',
                    durationMs: 1,
                },
                ingestion: {
                    outputApplyOutcome: 'accepted',
                    fallbackTier: 'none',
                    correctionCodes: [],
                    outOfContractFields: [],
                    authorityFieldAttempts: [],
                },
                diagnostics: {
                    rawToolIntentPresent: false,
                    normalizedToolIntentPresent: false,
                    toolIntentRejected: false,
                    toolIntentRejectionReasons: [],
                },
            };
        },
        planContinuationBuilder: ({
            plannerStepResult,
            baseGenerationRequest,
            baseMessagesWithHints,
            contextEnvelope,
        }) => ({
            continuation: 'continue_message',
            messagesWithHints: baseMessagesWithHints,
            generationRequest: baseGenerationRequest,
            conversationSnapshot: 'planner continuation snapshot',
            contextEnvelope,
            plannerSummary: {
                executionPlan: plannerStepResult.plan,
                generationForExecution: plannerStepResult.plan.generation,
                selectedResponseProfile: {
                    id: 'openai-text-fast',
                    provider: 'openai',
                    providerModel: 'gpt-5-mini',
                    capabilities: {
                        supportsReasoningEffort: true,
                        supportsVerbosity: true,
                        canUseSearch: false,
                        canGenerateImage: false,
                        canUseVision: false,
                        canUseAudio: false,
                        canUseStreaming: true,
                    },
                },
                originalSelectedProfileId: 'openai-text-fast',
                effectiveSelectedProfileId: 'openai-text-fast',
                toolRequestContext: {
                    toolName: 'web_search',
                    requested: false,
                    eligible: false,
                    reasonCode: 'tool_not_requested',
                },
                plannerDiagnostics: {
                    rawToolIntentPresent: false,
                    normalizedToolIntentPresent: false,
                    toolIntentRejected: false,
                    toolIntentRejectionReasons: [],
                },
                plannerApplyOutcome: 'applied',
                plannerMattered: true,
                plannerMatteredControlIds: ['provider_preference'],
                fallbackReasons: [],
                fallbackRollupSelectionSource: 'default',
                modality: plannerStepResult.plan.modality,
                safetyTier: plannerStepResult.plan.safetyTier,
                searchRequested: false,
            },
        }),
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
    assert.equal(result.generationResult.text, 'safe initial draft');
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

test('runBoundedReviewWorkflow attaches planner plan step to lineage and links initial generate step to planner root', async () => {
    let generationCalls = 0;
    let generatedMessages:
        | Parameters<GenerationRuntime['generate']>[0]['messages']
        | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(input) {
            generationCalls += 1;
            generatedMessages = input.messages;
            return {
                text: 'initial draft',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 12,
                    completionTokens: 6,
                    totalTokens: 18,
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
            messages: [{ role: 'user', content: 'Summarize this.' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Summarize this.' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 0,
            maxDurationMs: 15000,
            executionLimits: {
                maxWorkflowSteps: 2,
                maxToolCalls: 0,
                maxPlanCycles: 1,
                maxReviewCycles: 0,
                maxDeliberationCalls: 1,
                maxTokensTotal: Number.MAX_SAFE_INTEGER,
                maxDurationMs: 15000,
            },
        },
        workflowPolicy: {
            enablePlanning: true,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        plannerStepRequest: {
            workflowId: 'wf_test',
            workflowName: 'message_reviewed',
            attempt: 1,
            request: {
                surface: 'web',
                trigger: { kind: 'submit' },
                latestUserInput: 'Summarize this.',
                conversation: [{ role: 'user', content: 'Summarize this.' }],
            },
            invocationContext: {
                owner: 'workflow',
                workflowName: 'message_reviewed',
                stepKind: 'plan',
                purpose: 'chat_orchestrator_action_selection',
            },
            capabilityProfiles: [],
        },
        plannerStepExecutor: async () => ({
            plan: {
                action: 'message',
                modality: 'text',
                safetyTier: 'Low',
                reasoning: 'Use normal message flow.',
                generation: { reasoningEffort: 'low', verbosity: 'low' },
            },
            execution: {
                status: 'executed',
                purpose: 'chat_orchestrator_action_selection',
                contractType: 'structured',
                durationMs: 1,
            },
            ingestion: {
                outputApplyOutcome: 'accepted',
                fallbackTier: 'none',
                correctionCodes: [],
                outOfContractFields: [],
                authorityFieldAttempts: [],
            },
            diagnostics: {
                rawToolIntentPresent: false,
                normalizedToolIntentPresent: false,
                toolIntentRejected: false,
                toolIntentRejectionReasons: [],
            },
        }),
        planContinuationBuilder: ({
            plannerStepResult,
            baseGenerationRequest,
            baseMessagesWithHints,
            contextEnvelope,
        }) => ({
            continuation: 'continue_message',
            messagesWithHints: [
                ...baseMessagesWithHints,
                {
                    role: 'system',
                    content: '// adapter-added planner payload',
                },
            ],
            generationRequest: {
                ...baseGenerationRequest,
                model: 'gpt-5-mini',
            },
            conversationSnapshot: 'planner continuation snapshot',
            contextEnvelope,
            plannerSummary: {
                executionPlan: plannerStepResult.plan,
                generationForExecution: plannerStepResult.plan.generation,
                selectedResponseProfile: {
                    id: 'openai-text-fast',
                    provider: 'openai',
                    providerModel: 'gpt-5-mini',
                    capabilities: {
                        supportsReasoningEffort: true,
                        supportsVerbosity: true,
                        canUseSearch: false,
                        canGenerateImage: false,
                        canUseVision: false,
                        canUseAudio: false,
                        canUseStreaming: true,
                    },
                },
                originalSelectedProfileId: 'openai-text-fast',
                effectiveSelectedProfileId: 'openai-text-fast',
                toolRequestContext: {
                    toolName: 'web_search',
                    requested: false,
                    eligible: false,
                    reasonCode: 'tool_not_requested',
                },
                plannerDiagnostics: plannerStepResult.diagnostics,
                plannerApplyOutcome: 'applied',
                plannerMattered: true,
                plannerMatteredControlIds: ['provider_preference'],
                fallbackReasons: [],
                fallbackRollupSelectionSource: 'default',
                modality: plannerStepResult.plan.modality,
                safetyTier: plannerStepResult.plan.safetyTier,
                searchRequested: false,
            },
        }),
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
    assert.equal(result.workflowLineage.stepCount, 2);
    assert.equal(result.workflowLineage.steps[0].stepKind, 'plan');
    assert.equal(result.workflowLineage.steps[1].stepKind, 'generate');
    assert.equal(result.workflowLineage.steps[1].parentStepId, 'step_1');
    assert.equal(generationCalls, 1);
    assert.ok(
        generatedMessages?.some(
            (message) =>
                message.role === 'system' &&
                message.content === '// adapter-added planner payload'
        )
    );
});

test('runBoundedReviewWorkflow preserves failed planner fallback status on injected plan step', async () => {
    let generationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            return {
                text: 'should not run',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 1,
                    completionTokens: 1,
                    totalTokens: 2,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const plannerStep = buildPlannerStepRecord({
        stepId: 'step_1',
        attempt: 1,
        finishedAtMs: Date.now(),
        summary: {
            status: 'failed',
            reasonCode: 'planner_runtime_error',
            purpose: 'chat_orchestrator_action_selection',
            contractType: 'fallback',
            applyOutcome: 'not_applied',
            profileId: 'openai-text-fast',
            provider: 'openai',
            model: 'gpt-5-nano',
            mattered: false,
            matteredControlIds: [],
        },
    });

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
            maxIterations: 1,
            maxDurationMs: 15000,
            executionLimits: {
                maxWorkflowSteps: 4,
                maxToolCalls: 4,
                maxDeliberationCalls: 2,
                maxTokensTotal: 1000,
                maxDurationMs: 15000,
            },
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: false,
            enableAssessment: true,
            enableRevision: true,
        },
        plannerStepRecord: plannerStep,
        captureUsage: () => ({
            model: 'gpt-5-mini',
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
    });

    assert.equal(result.outcome, 'no_generation');
    assert.equal(generationCalls, 0);
    assert.equal(result.workflowLineage.stepCount, 1);
    assert.equal(result.workflowLineage.steps.length, 1);
    assert.equal(result.workflowLineage.steps[0].stepKind, 'plan');
    assert.equal(result.workflowLineage.steps[0].outcome.status, 'failed');
    assert.equal(
        result.workflowLineage.steps[0].reasonCode,
        'planner_runtime_error'
    );
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
