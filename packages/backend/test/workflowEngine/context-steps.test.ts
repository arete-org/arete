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

test('runBoundedReviewWorkflow does not emit concrete tool steps in current engine-owned review path', async () => {
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate({ messages }) {
            const lastSystemMessage = [...messages]
                .reverse()
                .find((message) => message.role === 'system');
            const isAssessmentCall =
                lastSystemMessage?.content.includes(
                    'Return plain JSON only.'
                ) === true;

            return isAssessmentCall
                ? {
                      text: '{"reviewDecision":"finalize","reviewReason":"done"}',
                      model: 'gpt-5-mini',
                      usage: {
                          promptTokens: 8,
                          completionTokens: 4,
                          totalTokens: 12,
                      },
                      provenance: 'Inferred',
                      citations: [],
                  }
                : {
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
            messages: [{ role: 'user', content: 'Summarize weather' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Summarize weather' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 1,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: true,
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
    assert.equal(
        result.workflowLineage.steps.some((step) => step.stepKind === 'tool'),
        false
    );
});

test('runBoundedReviewWorkflow executes injected context step and records context artifacts before generation', async () => {
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
            messages: [{ role: 'user', content: 'Need weather summary' }],
        },
        messagesWithHints: [
            { role: 'user', content: 'Need weather summary' },
            { role: 'system', content: 'hint' },
        ],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 1,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        contextStepRequests: [
            {
                integrationName: 'weather_forecast',
                requested: true,
                eligible: true,
                input: { location: 'Indianapolis' },
            },
        ],
        contextStepExecutor: async () => ({
            executionContext: {
                toolName: 'weather_forecast',
                status: 'executed',
                durationMs: 4,
            },
            contextMessages: ['weather_context: clear skies'],
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
    const toolStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'tool'
    );
    assert.ok(toolStep);
    assert.equal(toolStep.outcome.status, 'executed');
    assert.deepEqual(toolStep.outcome.artifacts, [
        'weather_context: clear skies',
    ]);
});

test('runBoundedReviewWorkflow executes eligible context steps in parallel and merges emitted context messages', async () => {
    const observedMessages: RuntimeMessage[][] = [];
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(input) {
            observedMessages.push(input.messages);
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
    let weatherStartedAt = 0;
    let webSearchStartedAt = 0;

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Need context' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Need context' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop',
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
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        contextStepRequests: [
            {
                integrationName: 'weather_forecast',
                requested: true,
                eligible: true,
            },
            {
                integrationName: 'web_search',
                requested: true,
                eligible: true,
            },
        ],
        contextStepExecutorRegistry: {
            weather_forecast: async () => {
                weatherStartedAt = Date.now();
                await new Promise((resolve) => setTimeout(resolve, 40));
                return {
                    executionContext: {
                        toolName: 'weather_forecast',
                        status: 'executed',
                    },
                    contextMessages: ['weather_context: clear skies'],
                };
            },
            web_search: async () => {
                webSearchStartedAt = Date.now();
                await new Promise((resolve) => setTimeout(resolve, 40));
                return {
                    executionContext: {
                        toolName: 'web_search',
                        status: 'executed',
                    },
                    contextMessages: ['web_context: top result'],
                };
            },
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
    assert.ok(Math.abs(weatherStartedAt - webSearchStartedAt) < 35);
    assert.equal(result.contextStepResults?.length, 2);
    const firstMessageBatch = observedMessages[0] ?? [];
    const weatherContextMessageIndex = firstMessageBatch.findIndex(
        (message) =>
            message.role === 'system' &&
            message.content === 'weather_context: clear skies'
    );
    const webContextMessageIndex = firstMessageBatch.findIndex(
        (message) =>
            message.role === 'system' &&
            message.content === 'web_context: top result'
    );
    assert.ok(weatherContextMessageIndex >= 0);
    assert.ok(webContextMessageIndex >= 0);
    assert.ok(weatherContextMessageIndex < webContextMessageIndex);
});

test('runBoundedReviewWorkflow records failed injected context step with reason and continues fail-open', async () => {
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
            messages: [{ role: 'user', content: 'Need weather summary' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Need weather summary' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 1,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        contextStepRequests: [
            {
                integrationName: 'weather_forecast',
                requested: true,
                eligible: true,
                input: { location: 'Indianapolis' },
            },
        ],
        contextStepExecutor: async () => ({
            executionContext: {
                toolName: 'weather_forecast',
                status: 'failed',
                reasonCode: 'tool_timeout',
                durationMs: 10,
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
    const toolStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'tool'
    );
    assert.ok(toolStep);
    assert.equal(toolStep.outcome.status, 'failed');
    assert.equal(toolStep.reasonCode, 'tool_timeout');
});

test('runBoundedReviewWorkflow stops before generation when injected context step requires clarification', async () => {
    let generationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
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
            messages: [{ role: 'user', content: 'Need weather summary' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Need weather summary' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_reviewed',
            maxIterations: 0,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        contextStepRequests: [
            {
                integrationName: 'weather_forecast',
                requested: true,
                eligible: true,
                input: { location: 'Springfield' },
            },
        ],
        contextStepExecutor: async () => ({
            executionContext: {
                toolName: 'weather_forecast',
                status: 'executed',
            },
            clarification: {
                reasonCode: 'ambiguous_location',
                question: 'Which Springfield did you mean?',
                options: [
                    { id: '1', label: 'Springfield, Illinois' },
                    { id: '2', label: 'Springfield, Missouri' },
                ],
            },
        }),
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
    const toolStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'tool'
    );
    assert.ok(toolStep);
    assert.equal(toolStep.outcome.status, 'executed');
    assert.equal(
        toolStep.outcome.signals?.clarificationReasonCode,
        'ambiguous_location'
    );
});

test('runBoundedReviewWorkflow returns terminal planner action outcome without generation', async () => {
    let generationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            return {
                text: 'should not run',
                model: 'gpt-5-mini',
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'Send a reaction' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Send a reaction' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'generate-only',
            maxIterations: 0,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: true,
            enableToolUse: false,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: false,
            enableRevision: false,
        },
        plannerStepRequest: {
            workflowId: 'wf_test',
            workflowName: 'generate-only',
            attempt: 1,
            request: {
                surface: 'web',
                trigger: { kind: 'submit' },
                latestUserInput: 'Send a reaction',
                conversation: [{ role: 'user', content: 'Send a reaction' }],
            },
            invocationContext: {
                owner: 'workflow',
                workflowName: 'generate-only',
                stepKind: 'plan',
                purpose: 'chat_orchestrator_action_selection',
            },
            capabilityProfiles: [],
        },
        plannerStepExecutor: async () => ({
            plan: {
                action: 'react',
                modality: 'text',
                reaction: '🔥',
                safetyTier: 'Low',
                reasoning: 'Reaction is sufficient.',
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
        planContinuationBuilder: ({ plannerStepResult }) => ({
            continuation: 'terminal_action',
            terminalAction:
                plannerStepResult.plan.action === 'react'
                    ? { responseAction: 'react', reaction: '🔥' }
                    : { responseAction: 'ignore' },
            plannerSummary: {
                executionPlan: plannerStepResult.plan,
                generationForExecution: plannerStepResult.plan.generation,
                selectedResponseProfile: {
                    id: 'default',
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
                originalSelectedProfileId: 'default',
                effectiveSelectedProfileId: 'default',
                toolRequestContext: {
                    toolName: 'web_search',
                    requested: false,
                    eligible: false,
                    reasonCode: 'tool_not_requested',
                },
                plannerDiagnostics: plannerStepResult.diagnostics,
                plannerApplyOutcome: 'applied',
                plannerMattered: true,
                plannerMatteredControlIds: [],
                fallbackReasons: [],
                fallbackRollupSelectionSource: 'default',
                modality: plannerStepResult.plan.modality,
                safetyTier: plannerStepResult.plan.safetyTier,
                searchRequested: false,
            },
        }),
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

    assert.equal(generationCalls, 0);
    assert.equal(result.outcome, 'terminal_action');
    if (result.outcome !== 'terminal_action') {
        throw new Error('Expected terminal action outcome');
    }
    assert.equal(result.terminalAction.responseAction, 'react');
    assert.equal(result.workflowLineage.terminationReason, 'goal_satisfied');
});

test('runBoundedReviewWorkflow uses web_search hints for one OpenAI native follow-up when enabled', async () => {
    let observedSearch: unknown;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(input) {
            observedSearch = input.search;
            return {
                text: 'draft',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 10,
                    completionTokens: 5,
                    totalTokens: 15,
                },
                provenance: 'Retrieved',
                citations: [{ title: 'source', url: 'https://example.com' }],
            };
        },
    };

    const result = await runBoundedReviewWorkflowForTest({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            provider: 'openai',
            messages: [{ role: 'user', content: 'Need context' }],
        },
        messagesWithHints: [{ role: 'user', content: 'Need context' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop',
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
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: false,
            enableRevision: false,
        },
        openAiNativeSearchFromHintsEnabled: true,
        contextStepRequests: [
            {
                integrationName: 'web_search',
                requested: true,
                eligible: true,
            },
        ],
        contextStepExecutorRegistry: {
            web_search: async () => ({
                executionContext: {
                    toolName: 'web_search',
                    status: 'executed',
                },
                integrationContext: {
                    kind: 'web_search',
                    version: 'v1',
                    payload: {
                        searchHints: [
                            {
                                query: 'latest policy change',
                                intent: 'current_facts',
                                priority: 'high',
                            },
                        ],
                    },
                },
            }),
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
    assert.deepEqual(observedSearch, {
        query: 'latest policy change',
        intent: 'current_facts',
        contextSize: 'low',
    });
});
