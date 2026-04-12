/**
 * @description: Covers backend cost recording in the shared chat service.
 * @footnote-scope: test
 * @footnote-module: ChatServiceTests
 * @footnote-risk: medium - Missing tests could let backend chat stop recording usage silently.
 * @footnote-ethics: medium - Cost accounting is part of responsible backend AI operation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
    GenerationResult,
    GenerationRuntime,
} from '@footnote/agent-runtime';
import { createVoltAgentRuntime } from '@footnote/agent-runtime';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { ResponseMetadataSchema } from '@footnote/contracts/web';
import { createMetadata } from './fixtures/responseMetadataFixture.js';
import {
    buildResponseMetadata,
    type ResponseMetadataRetrievalContext,
    type ResponseMetadataRuntimeContext,
} from '../src/services/openaiService.js';
import { createChatService } from '../src/services/chatService.js';
import { resolveExecutionContract } from '../src/services/executionContractResolver.js';
import {
    createScopeOwnershipValidatorFromTenancyService,
    StubTrustGraphEvidenceAdapter,
    TrustGraphOwnershipValidationPolicy,
} from '../src/services/executionContractTrustGraph/index.js';
import type { BackendLLMCostRecord } from '../src/services/llmCostRecorder.js';
import type { RunBoundedReviewWorkflowResult } from '../src/services/workflowEngine.js';

const createRuntime = (
    overrides: Partial<GenerationResult> = {}
): GenerationRuntime => ({
    kind: 'test-runtime',
    async generate() {
        return {
            text: 'chat response',
            model: 'gpt-5-mini',
            usage: {
                promptTokens: 120,
                completionTokens: 80,
                totalTokens: 200,
            },
            provenance: 'Inferred',
            citations: [],
            ...overrides,
        };
    },
});

const TEST_TIMESTAMP = new Date('2026-04-04T00:00:00.000Z').toISOString();

test('createChatService records backend token usage and estimated cost', async () => {
    const usageRecords: BackendLLMCostRecord[] = [];
    const chatService = createChatService({
        generationRuntime: createRuntime(),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: (record) => {
            usageRecords.push(record);
        },
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
    });

    const response = await chatService.runChat({
        question: 'What changed?',
    });

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'chat response');
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].feature, 'chat');
    assert.equal(usageRecords[0].model, 'gpt-5-mini');
    assert.equal(usageRecords[0].promptTokens, 120);
    assert.equal(usageRecords[0].completionTokens, 80);
    assert.equal(usageRecords[0].totalTokens, 200);
    assert.equal(usageRecords[0].inputCostUsd, 0.00003);
    assert.equal(usageRecords[0].outputCostUsd, 0.00016);
    assert.equal(usageRecords[0].totalCostUsd, 0.00019);
});

test('createChatService passes the effective model to response metadata building', async () => {
    let capturedRuntimeContextModelVersion: string | null = null;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            model: 'gpt-5.1',
            usage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
            },
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedRuntimeContextModelVersion = runtimeContext.modelVersion;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChat({
        question: 'What changed?',
    });

    assert.equal(capturedRuntimeContextModelVersion, 'gpt-5.1');
});

test('createChatService preserves the caller-requested model when the runtime omits one', async () => {
    const usageRecords: BackendLLMCostRecord[] = [];
    let capturedRuntimeContextModelVersion: string | null = null;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            model: undefined,
            usage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
            },
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedRuntimeContextModelVersion = runtimeContext.modelVersion;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: (record) => {
            usageRecords.push(record);
        },
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
        model: 'gpt-5.1',
    });

    assert.equal(capturedRuntimeContextModelVersion, 'gpt-5.1');
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].model, 'gpt-5.1');
});

test('runChatMessages passes planner temperament into response metadata runtime context', async () => {
    let capturedPlannerTemperament:
        | import('@footnote/contracts/ethics-core').PartialResponseTemperament
        | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            usage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
            },
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedPlannerTemperament = runtimeContext.plannerTemperament;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
        plannerTemperament: {
            tightness: 4,
            attribution: 3,
        },
    });

    assert.deepEqual(capturedPlannerTemperament, {
        tightness: 4,
        attribution: 3,
    });
});

test('runChatMessages passes structured retrieval facts into response metadata runtime context', async () => {
    let capturedRetrieval: ResponseMetadataRetrievalContext | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            usage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
            },
            provenance: 'Retrieved',
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedRetrieval = runtimeContext.retrieval;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed today?' }],
        conversationSnapshot: 'What changed today?',
        provider: 'openai',
        capabilities: {
            canUseSearch: true,
        },
        generation: {
            reasoningEffort: 'medium',
            verbosity: 'medium',
            search: {
                query: 'latest OpenAI policy update',
                contextSize: 'low',
                intent: 'current_facts',
                repoHints: [],
                topicHints: ['policy', 'openai'],
            },
        },
    });

    assert.deepEqual(capturedRetrieval, {
        requested: true,
        used: true,
        intent: 'current_facts',
        contextSize: 'low',
    });
});

test('runChatMessages passes non-retrieval facts for plain VoltAgent-backed runs', async () => {
    let capturedRetrieval: ResponseMetadataRetrievalContext | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            usage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
            },
            provenance: 'Inferred',
            citations: [],
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedRetrieval = runtimeContext.retrieval;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Give me a quick summary.' }],
        conversationSnapshot: 'Give me a quick summary.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
        },
    });

    assert.deepEqual(capturedRetrieval, {
        requested: false,
        used: false,
        intent: undefined,
        contextSize: undefined,
    });
});

test('runChatMessages forwards execution context into metadata runtime context (metadata extension seam)', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime(),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
        executionContext: {
            planner: {
                status: 'executed',
                purpose: 'chat_orchestrator_action_selection',
                contractType: 'structured',
                applyOutcome: 'applied',
                mattered: true,
                matteredControlIds: ['provider_preference'],
                profileId: 'openai-text-fast',
                provider: 'openai',
                model: 'gpt-5-nano',
            },
            evaluator: {
                status: 'executed',
                outcome: {
                    authorityLevel: 'observe',
                    mode: 'observe_only',
                    provenance: 'Inferred',
                    safetyDecision: {
                        action: 'allow',
                        safetyTier: 'Low',
                        ruleId: null,
                    },
                },
            },
            generation: {
                status: 'executed',
                profileId: 'openai-text-medium',
                provider: 'openai',
                model: 'gpt-5-mini',
            },
        },
    });

    assert.deepEqual(capturedExecutionContext?.planner, {
        status: 'executed',
        purpose: 'chat_orchestrator_action_selection',
        contractType: 'structured',
        applyOutcome: 'applied',
        mattered: true,
        matteredControlIds: ['provider_preference'],
        profileId: 'openai-text-fast',
        provider: 'openai',
        model: 'gpt-5-nano',
    });
    assert.deepEqual(capturedExecutionContext?.evaluator, {
        status: 'executed',
        outcome: {
            authorityLevel: 'observe',
            mode: 'observe_only',
            provenance: 'Inferred',
            safetyDecision: {
                action: 'allow',
                safetyTier: 'Low',
                ruleId: null,
            },
        },
    });
    assert.equal(capturedExecutionContext?.generation?.status, 'executed');
    assert.equal(
        capturedExecutionContext?.generation?.profileId,
        'openai-text-medium'
    );
    assert.equal(capturedExecutionContext?.generation?.provider, 'openai');
    assert.equal(capturedExecutionContext?.generation?.model, 'gpt-5-mini');
    assert.ok((capturedExecutionContext?.generation?.durationMs ?? -1) >= 0);
});

test('runChatMessages marks tool execution as executed when retrieval was used', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            provenance: 'Retrieved',
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Search this.' }],
        conversationSnapshot: 'Search this.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            search: {
                query: 'latest updates',
                contextSize: 'low',
                intent: 'current_facts',
            },
        },
    });

    assert.deepEqual(capturedExecutionContext?.tool, {
        toolName: 'web_search',
        status: 'executed',
    });
});

test('runChatMessages preserves non-search tool execution context when search is absent', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            provenance: 'Inferred',
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Weather at these coordinates.' }],
        conversationSnapshot: 'Weather at these coordinates.',
        executionContext: {
            tool: {
                toolName: 'weather_forecast',
                status: 'executed',
                durationMs: 12,
            },
        },
        toolRequest: {
            toolName: 'weather_forecast',
            requested: true,
            eligible: true,
        },
    });

    assert.deepEqual(capturedExecutionContext?.tool, {
        toolName: 'weather_forecast',
        status: 'executed',
        durationMs: 12,
    });
});

test('runChatMessages forwards total orchestration duration when provided', async () => {
    let capturedTotalDurationMs: number | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime(),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedTotalDurationMs = runtimeContext.totalDurationMs;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
        orchestrationStartedAtMs: Date.now() - 25,
    });

    assert.ok((capturedTotalDurationMs ?? -1) >= 0);
});

test('createChatService swallows usage recording failures', async () => {
    const chatService = createChatService({
        generationRuntime: createRuntime({
            usage: {
                promptTokens: 20,
                completionTokens: 10,
                totalTokens: 30,
            },
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => {
            throw new Error('telemetry backend unavailable');
        },
    });

    const response = await chatService.runChat({
        question: 'What changed?',
    });

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'chat response');
    assert.equal(response.metadata.responseId, 'chat_test_response');
});

test('runChatMessages adds a backend repo-explainer response hint', async () => {
    let seenMessages: Array<{ role: string; content: string }> = [];
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate({ messages }) {
            seenMessages = messages;
            return {
                text: 'chat response',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 20,
                    completionTokens: 10,
                    totalTokens: 30,
                },
                provenance: 'Retrieved',
                citations: [],
            };
        },
    };

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        defaultProvider: 'openai',
        defaultCapabilities: {
            canUseSearch: true,
        },
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Explain Footnote architecture.' }],
        conversationSnapshot: 'Explain Footnote architecture.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'medium',
            search: {
                query: 'Footnote architecture overview',
                contextSize: 'medium',
                intent: 'repo_explainer',
                repoHints: ['architecture'],
            },
        },
    });

    assert.equal(
        seenMessages.some((message) =>
            message.content.includes(
                'Planner note: this is a Footnote repo-explanation lookup.'
            )
        ),
        true
    );
});

test('runChatMessages forwards planner-selected generation settings to GenerationRuntime', async () => {
    let seenRequest:
        | import('@footnote/agent-runtime').GenerationRequest
        | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(request) {
            seenRequest = request;
            return {
                text: 'chat response',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 20,
                    completionTokens: 10,
                    totalTokens: 30,
                },
                provenance: 'Retrieved',
                citations: [],
            };
        },
    };

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        defaultProvider: 'openai',
        defaultCapabilities: {
            canUseSearch: true,
        },
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed today?' }],
        conversationSnapshot: 'What changed today?',
        generation: {
            reasoningEffort: 'medium',
            verbosity: 'medium',
            search: {
                query: 'latest OpenAI policy update',
                contextSize: 'low',
                intent: 'current_facts',
                repoHints: [],
                topicHints: ['policy', 'openai'],
            },
        },
    });

    assert.ok(seenRequest?.search);
    assert.equal(seenRequest?.reasoningEffort, 'medium');
    assert.equal(seenRequest?.verbosity, 'medium');
    assert.equal(seenRequest?.provider, 'openai');
    assert.equal(seenRequest?.capabilities?.canUseSearch, true);
    assert.equal(seenRequest?.userId, undefined);
    assert.equal(seenRequest?.search?.query, 'latest OpenAI policy update');
    assert.equal(seenRequest?.search?.intent, 'current_facts');
    assert.deepEqual(seenRequest?.search?.topicHints, ['policy', 'openai']);
});

test('runChatMessages tolerates optional memory retrievals field on runtime results', async () => {
    const chatService = createChatService({
        generationRuntime: createRuntime({
            memoryRetrievals: [],
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
    });

    assert.equal(response.message, 'chat response');
});

test('runChatMessages drops blank search queries before building the runtime request', async () => {
    let seenRequest:
        | import('@footnote/agent-runtime').GenerationRequest
        | undefined;
    let capturedRetrieval: ResponseMetadataRetrievalContext | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(request) {
            seenRequest = request;
            return {
                text: 'chat response',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 20,
                    completionTokens: 10,
                    totalTokens: 30,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedRetrieval = runtimeContext.retrieval;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Give me a quick summary.' }],
        conversationSnapshot: 'Give me a quick summary.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            search: {
                query: '   ',
                contextSize: 'low',
                intent: 'current_facts',
            },
        },
    });

    assert.equal(seenRequest?.search, undefined);
    assert.deepEqual(capturedRetrieval, {
        requested: false,
        used: false,
        intent: undefined,
        contextSize: undefined,
    });
});

test('runChatMessages records usage correctly when VoltAgent handles search directly', async () => {
    const usageRecords: BackendLLMCostRecord[] = [];
    let executorCalled = false;
    const chatService = createChatService({
        generationRuntime: createVoltAgentRuntime({
            defaultModel: 'gpt-5-mini',
            createExecutor: () => ({
                async generateText() {
                    executorCalled = true;
                    return {
                        text: 'search-backed reply',
                        usage: {
                            promptTokens: 50,
                            completionTokens: 25,
                            totalTokens: 75,
                        },
                        response: {
                            modelId: 'openai/gpt-5-mini',
                            body: {
                                output: [{ type: 'web_search_call' }],
                            },
                        },
                        sources: [
                            {
                                title: 'OpenAI Policy Update',
                                url: 'https://example.com/policy',
                            },
                        ],
                    };
                },
            }),
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: (record) => {
            usageRecords.push(record);
        },
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
    });

    await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed today?' }],
        conversationSnapshot: 'What changed today?',
        generation: {
            reasoningEffort: 'medium',
            verbosity: 'medium',
            search: {
                query: 'latest OpenAI policy update',
                contextSize: 'low',
                intent: 'current_facts',
            },
        },
    });

    assert.equal(executorCalled, true);
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].model, 'gpt-5-mini');
    assert.equal(usageRecords[0].promptTokens, 50);
    assert.equal(usageRecords[0].completionTokens, 25);
    assert.equal(usageRecords[0].totalTokens, 75);
});

test('runChatMessages stores evidence and freshness chips for retrieved search replies', async () => {
    let storedMetadata: ResponseMetadata | undefined;

    const chatService = createChatService({
        generationRuntime: createVoltAgentRuntime({
            defaultModel: 'gpt-5-mini',
            createExecutor: () => ({
                async generateText() {
                    return {
                        text: 'search-backed reply',
                        usage: {
                            promptTokens: 50,
                            completionTokens: 25,
                            totalTokens: 75,
                        },
                        response: {
                            modelId: 'openai/gpt-5-mini',
                            body: {
                                output: [{ type: 'web_search_call' }],
                            },
                        },
                        sources: [
                            { title: 'One', url: 'https://example.com/1' },
                            { title: 'Two', url: 'https://example.com/2' },
                        ],
                    };
                },
            }),
        }),
        storeTrace: async (metadata) => {
            storedMetadata = metadata;
        },
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        defaultCapabilities: {
            canUseSearch: true,
        },
        recordUsage: () => undefined,
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed today?' }],
        conversationSnapshot: 'What changed today?',
        generation: {
            reasoningEffort: 'medium',
            verbosity: 'medium',
            search: {
                query: 'latest OpenAI policy update',
                contextSize: 'low',
                intent: 'current_facts',
            },
        },
    });

    assert.equal(response.metadata.provenance, 'Retrieved');
    assert.equal(response.metadata.evidenceScore, 4);
    assert.equal(response.metadata.freshnessScore, 4);
    assert.equal(storedMetadata?.evidenceScore, 4);
    assert.equal(storedMetadata?.freshnessScore, 4);
});

test('runChatMessages executes bounded review loop and forwards workflow lineage', async () => {
    let callCount = 0;
    let capturedWorkflow:
        | ResponseMetadataRuntimeContext['workflow']
        | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(_request) {
            callCount += 1;
            if (callCount === 1) {
                return {
                    text: 'initial draft',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 30,
                        completionTokens: 20,
                        totalTokens: 50,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }

            if (callCount === 2) {
                return {
                    text: '{"decision":"finalize","reason":"Draft is complete and clear."}',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 10,
                        completionTokens: 8,
                        totalTokens: 18,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }

            throw new Error(`Unexpected generation call ${callCount}`);
        },
    };

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedWorkflow = runtimeContext.workflow;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
        },
    });

    assert.equal(response.message, 'initial draft');
    assert.equal(callCount, 2);
    assert.equal(capturedWorkflow?.workflowName, 'message_with_review_loop');
    assert.equal(capturedWorkflow?.terminationReason, 'goal_satisfied');
    assert.equal(capturedWorkflow?.status, 'completed');
    assert.ok((capturedWorkflow?.steps.length ?? 0) >= 2);
    const assessStep = capturedWorkflow?.steps.find(
        (step) => step.stepKind === 'assess'
    );
    assert.equal(assessStep?.outcome.signals?.reviewDecision, 'finalize');
    assert.equal(
        assessStep?.outcome.signals?.reviewReason,
        'Draft is complete and clear.'
    );
});

test('runChatMessages fails open when review output is invalid', async () => {
    let callCount = 0;
    let capturedWorkflow:
        | ResponseMetadataRuntimeContext['workflow']
        | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            callCount += 1;
            if (callCount === 1) {
                return {
                    text: 'draft that should still be returned',
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

            if (callCount === 2) {
                return {
                    text: 'not-json',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 10,
                        completionTokens: 5,
                        totalTokens: 15,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            }

            throw new Error(`Unexpected generation call ${callCount}`);
        },
    };

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedWorkflow = runtimeContext.workflow;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
        },
    });

    assert.equal(response.message, 'draft that should still be returned');
    assert.equal(callCount, 2);
    assert.equal(capturedWorkflow?.status, 'degraded');
    assert.equal(
        capturedWorkflow?.terminationReason,
        'executor_error_fail_open'
    );
});

test('runChatMessages skips review loop when enabled but maxIterations is zero', async () => {
    let callCount = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            callCount += 1;
            return {
                text: 'single pass response',
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 20,
                    completionTokens: 10,
                    totalTokens: 30,
                },
                provenance: 'Inferred',
                citations: [],
            };
        },
    };

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            reviewLoopEnabled: true,
            maxIterations: 0,
            maxDurationMs: 15000,
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
    });

    assert.equal(response.message, 'single pass response');
    assert.equal(callCount, 1);
});

test('runChatMessages falls back to reviewed workflow behavior for unknown workflow mode id', async () => {
    let capturedWorkflow:
        | ResponseMetadataRuntimeContext['workflow']
        | undefined;
    let capturedWorkflowRunConfig:
        | {
              workflowName: string;
              maxIterations: number;
              maxDurationMs: number;
          }
        | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime(),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedWorkflow = runtimeContext.workflow;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            modeId: 'unknown-profile',
            reviewLoopEnabled: true,
            maxIterations: 2,
            maxDurationMs: 15000,
        },
        runReviewWorkflow: async (input) => {
            capturedWorkflowRunConfig = input.workflowConfig;
            return {
                outcome: 'generated',
                generationResult: {
                    text: 'bounded-review fallback response',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 10,
                        completionTokens: 5,
                        totalTokens: 15,
                    },
                    provenance: 'Inferred',
                    citations: [],
                },
                workflowLineage: {
                    workflowId: 'wf_unknown_profile_fallback',
                    workflowName: input.workflowConfig.workflowName,
                    status: 'completed',
                    terminationReason: 'goal_satisfied',
                    stepCount: 1,
                    maxSteps: 3,
                    maxDurationMs: input.workflowConfig.maxDurationMs,
                    steps: [],
                },
            } satisfies RunBoundedReviewWorkflowResult;
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
    });

    assert.equal(response.message, 'bounded-review fallback response');
    assert.equal(
        capturedWorkflowRunConfig?.workflowName,
        'message_with_review_loop'
    );
    assert.equal(capturedWorkflowRunConfig?.maxIterations, 2);
    assert.equal(capturedWorkflow?.workflowName, 'message_with_review_loop');
});

test('runChatMessages executes fast workflow mode as direct generation without workflow lineage', async () => {
    let generationCalls = 0;
    let capturedWorkflow:
        | ResponseMetadataRuntimeContext['workflow']
        | undefined;
    let capturedWorkflowRunConfig:
        | {
              workflowName: string;
              maxIterations: number;
              maxDurationMs: number;
          }
        | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            return {
                text: 'generate-only response',
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

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedWorkflow = runtimeContext.workflow;
            return createMetadata();
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: false,
            maxIterations: 9,
            maxDurationMs: 15000,
        },
        runReviewWorkflow: async (input) => {
            capturedWorkflowRunConfig = input.workflowConfig;
            return {
                outcome: 'generated',
                generationResult: await generationRuntime.generate(
                    input.generationRequest
                ),
                workflowLineage: {
                    workflowId: 'wf_generate_only',
                    workflowName: input.workflowConfig.workflowName,
                    status: 'completed',
                    terminationReason: 'goal_satisfied',
                    stepCount: 1,
                    maxSteps: 1,
                    maxDurationMs: input.workflowConfig.maxDurationMs,
                    steps: [
                        {
                            stepId: 'step_1',
                            attempt: 1,
                            stepKind: 'generate',
                            startedAt: new Date().toISOString(),
                            finishedAt: new Date().toISOString(),
                            durationMs: 1,
                            outcome: {
                                status: 'executed',
                                summary: 'Generated initial draft response.',
                            },
                        },
                    ],
                },
            } satisfies RunBoundedReviewWorkflowResult;
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
    });

    assert.equal(response.message, 'generate-only response');
    assert.equal(generationCalls, 1);
    assert.equal(capturedWorkflowRunConfig, undefined);
    assert.equal(capturedWorkflow, undefined);
});

test('runChatMessages handles surfaced no-generation reasons without runtime fallback generation', async () => {
    const surfacedReasons: Array<
        Extract<
            import('@footnote/contracts/ethics-core').WorkflowTerminationReason,
            'transition_blocked_by_policy' | 'executor_error_fail_open'
        >
    > = ['transition_blocked_by_policy', 'executor_error_fail_open'];

    for (const terminationReason of surfacedReasons) {
        let generationCalls = 0;
        let traceMetadata: ResponseMetadata | undefined;
        const usageRecords: BackendLLMCostRecord[] = [];
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

        const chatService = createChatService({
            generationRuntime,
            storeTrace: async (metadata) => {
                traceMetadata = metadata;
            },
            buildResponseMetadata,
            defaultModel: 'gpt-5-mini',
            recordUsage: (record) => {
                usageRecords.push(record);
            },
            chatWorkflowConfig: {
                reviewLoopEnabled: true,
                maxIterations: 1,
                maxDurationMs: 15000,
            },
            runReviewWorkflow: async () =>
                ({
                    outcome: 'no_generation',
                    workflowLineage: {
                        workflowId: `wf_surface_${terminationReason}`,
                        workflowName: 'message_with_review_loop',
                        status: 'degraded',
                        terminationReason,
                        stepCount: 0,
                        maxSteps: 3,
                        maxDurationMs: 15000,
                        steps: [],
                    },
                }) satisfies RunBoundedReviewWorkflowResult,
        });

        const response = await chatService.runChatMessages({
            messages: [{ role: 'user', content: 'Summarize this.' }],
            conversationSnapshot: 'Summarize this.',
        });

        assert.equal(generationCalls, 0);
        assert.equal(usageRecords.length, 0);
        assert.equal(
            response.message,
            'I could not generate a response for this request.'
        );
        assert.equal(
            response.metadata.workflow?.terminationReason,
            terminationReason
        );
        assert.equal(
            traceMetadata?.workflow?.terminationReason,
            terminationReason
        );
        const fallbackExecution = response.metadata.execution?.find(
            (event) =>
                event.kind === 'generation' &&
                event.profileId === 'workflow_internal_fallback'
        );
        assert.equal(fallbackExecution, undefined);
    }
});

test('runChatMessages handles internal no-generation reasons with fallback generation marker and preserved lineage', async () => {
    const internalReasons: Array<
        Extract<
            import('@footnote/contracts/ethics-core').WorkflowTerminationReason,
            | 'budget_exhausted_steps'
            | 'budget_exhausted_tokens'
            | 'budget_exhausted_time'
        >
    > = [
        'budget_exhausted_steps',
        'budget_exhausted_tokens',
        'budget_exhausted_time',
    ];

    for (const terminationReason of internalReasons) {
        let generationCalls = 0;
        const usageRecords: BackendLLMCostRecord[] = [];
        let traceMetadata: ResponseMetadata | undefined;
        const generationRuntime: GenerationRuntime = {
            kind: 'test-runtime',
            async generate() {
                generationCalls += 1;
                return {
                    text: 'fallback single-pass response',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 18,
                        completionTokens: 9,
                        totalTokens: 27,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            },
        };

        const chatService = createChatService({
            generationRuntime,
            storeTrace: async (metadata) => {
                traceMetadata = metadata;
            },
            buildResponseMetadata,
            defaultModel: 'gpt-5-mini',
            recordUsage: (record) => {
                usageRecords.push(record);
            },
            chatWorkflowConfig: {
                reviewLoopEnabled: true,
                maxIterations: 1,
                maxDurationMs: 15000,
            },
            runReviewWorkflow: async () =>
                ({
                    outcome: 'no_generation',
                    workflowLineage: {
                        workflowId: `wf_internal_${terminationReason}`,
                        workflowName: 'message_with_review_loop',
                        status: 'degraded',
                        terminationReason,
                        stepCount: 0,
                        maxSteps: 3,
                        maxDurationMs: 15000,
                        steps: [],
                    },
                }) satisfies RunBoundedReviewWorkflowResult,
        });

        const response = await chatService.runChatMessages({
            messages: [{ role: 'user', content: 'Summarize this.' }],
            conversationSnapshot: 'Summarize this.',
        });

        assert.equal(generationCalls, 1);
        assert.equal(usageRecords.length, 1);
        assert.equal(response.message, 'fallback single-pass response');
        assert.equal(
            response.metadata.workflow?.terminationReason,
            terminationReason
        );
        assert.equal(
            traceMetadata?.workflow?.terminationReason,
            terminationReason
        );
        const fallbackExecution = response.metadata.execution?.find(
            (event) =>
                event.kind === 'generation' &&
                event.profileId === 'workflow_internal_fallback' &&
                event.provider === 'internal'
        );
        assert.ok(fallbackExecution);
    }
});

test('runChatMessages keeps no-generation surfaced when execution policy disables fallback generation', async () => {
    let generationCalls = 0;
    let traceMetadata: ResponseMetadata | undefined;
    const usageRecords: BackendLLMCostRecord[] = [];
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            generationCalls += 1;
            return {
                text: 'should not run when fail-open fallback is disabled',
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

    const ExecutionContract = resolveExecutionContract({
        presetId: 'quality-grounded',
        overrides: {
            failOpen: {
                authority: 'backend',
                allowFallbackGeneration: false,
                fallbackTemperature: 'deterministic',
            },
        },
    }).policyContract;

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async (metadata) => {
            traceMetadata = metadata;
        },
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        recordUsage: (record) => {
            usageRecords.push(record);
        },
        chatWorkflowConfig: {
            reviewLoopEnabled: true,
            maxIterations: 1,
            maxDurationMs: 15000,
        },
        runReviewWorkflow: async () =>
            ({
                outcome: 'no_generation',
                workflowLineage: {
                    workflowId: 'wf_internal_budget_exhausted_steps',
                    workflowName: 'message_with_review_loop',
                    status: 'degraded',
                    terminationReason: 'budget_exhausted_steps',
                    stepCount: 0,
                    maxSteps: 3,
                    maxDurationMs: 15000,
                    steps: [],
                },
            }) satisfies RunBoundedReviewWorkflowResult,
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
        ExecutionContract,
    });

    assert.equal(generationCalls, 0);
    assert.equal(usageRecords.length, 0);
    assert.equal(
        response.message,
        'I could not generate a response for this request.'
    );
    assert.equal(
        response.metadata.workflow?.terminationReason,
        'budget_exhausted_steps'
    );
    assert.equal(
        traceMetadata?.workflow?.terminationReason,
        'budget_exhausted_steps'
    );
    const fallbackExecution = response.metadata.execution?.find(
        (event) =>
            event.kind === 'generation' &&
            event.profileId === 'workflow_internal_fallback'
    );
    assert.equal(fallbackExecution, undefined);
});

test('runChatMessages keeps workflow execution policy gated by the execution contract response mode', async () => {
    const runWithPolicyPreset = async (
        presetId: 'fast-direct' | 'quality-grounded'
    ): Promise<{
        reviewWorkflowCalls: number;
        directGenerationCalls: number;
        message: string;
    }> => {
        let reviewWorkflowCalls = 0;
        let directGenerationCalls = 0;
        const ExecutionContract = resolveExecutionContract({
            presetId,
        }).policyContract;
        const generationRuntime: GenerationRuntime = {
            kind: 'test-runtime',
            async generate() {
                directGenerationCalls += 1;
                return {
                    text: 'direct runtime generation',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 11,
                        completionTokens: 7,
                        totalTokens: 18,
                    },
                    provenance: 'Inferred',
                    citations: [],
                };
            },
        };

        const chatService = createChatService({
            generationRuntime,
            storeTrace: async () => undefined,
            buildResponseMetadata,
            defaultModel: 'gpt-5-mini',
            recordUsage: () => undefined,
            chatWorkflowConfig: {
                modeId: 'grounded',
                reviewLoopEnabled: false,
                maxIterations: 2,
                maxDurationMs: 15000,
            },
            runReviewWorkflow: async (input) => {
                reviewWorkflowCalls += 1;
                return {
                    outcome: 'generated',
                    generationResult: {
                        text: 'workflow generated',
                        model: input.generationRequest.model,
                        usage: {
                            promptTokens: 21,
                            completionTokens: 9,
                            totalTokens: 30,
                        },
                        provenance: 'Inferred',
                        citations: [],
                    },
                    workflowLineage: {
                        workflowId: `wf_${presetId}`,
                        workflowName: input.workflowConfig.workflowName,
                        status: 'completed',
                        terminationReason: 'goal_satisfied',
                        stepCount: 1,
                        maxSteps:
                            input.workflowConfig.executionLimits
                                ?.maxWorkflowSteps ?? 1,
                        maxDurationMs: input.workflowConfig.maxDurationMs,
                        steps: [
                            {
                                stepId: 'step_1',
                                attempt: 1,
                                stepKind: 'generate',
                                startedAt: new Date().toISOString(),
                                finishedAt: new Date().toISOString(),
                                durationMs: 1,
                                outcome: {
                                    status: 'executed',
                                    summary:
                                        'Generated response through workflow path.',
                                },
                            },
                        ],
                    },
                } satisfies RunBoundedReviewWorkflowResult;
            },
        });

        const response = await chatService.runChatMessages({
            messages: [{ role: 'user', content: 'Summarize this.' }],
            conversationSnapshot: 'Summarize this.',
            ExecutionContract,
        });

        return {
            reviewWorkflowCalls,
            directGenerationCalls,
            message: response.message,
        };
    };

    const qualityGrounded = await runWithPolicyPreset('quality-grounded');
    const fastDirect = await runWithPolicyPreset('fast-direct');

    assert.deepEqual(qualityGrounded, {
        reviewWorkflowCalls: 1,
        directGenerationCalls: 0,
        message: 'workflow generated',
    });
    assert.deepEqual(fastDirect, {
        reviewWorkflowCalls: 0,
        directGenerationCalls: 1,
        message: 'direct runtime generation',
    });
});

test('runChatMessages records workflow mode decision in metadata and applies fast behavior', async () => {
    let reviewWorkflowCalls = 0;
    let directGenerationCalls = 0;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            directGenerationCalls += 1;
            return {
                text: 'direct mode response',
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
    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: true,
            maxIterations: 3,
            maxDurationMs: 15000,
        },
        runReviewWorkflow: async () => {
            reviewWorkflowCalls += 1;
            throw new Error(
                'runReviewWorkflow should not execute in fast mode'
            );
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
    });

    assert.equal(response.message, 'direct mode response');
    assert.equal(directGenerationCalls, 1);
    assert.equal(reviewWorkflowCalls, 0);
    assert.equal(response.metadata.workflowMode?.modeId, 'fast');
    assert.equal(response.metadata.workflowMode?.initial_mode, 'fast');
    assert.equal(
        response.metadata.workflowMode?.behavior.workflowExecution,
        'disabled'
    );
    assert.equal(
        response.metadata.workflowMode?.behavior.evidencePosture,
        'minimal'
    );
});

test('runChatMessages can emit bounded workflow escalation attachment metadata', async () => {
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            return {
                text: 'escalated path response',
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
    const chatService = createChatService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            modeId: 'fast',
            reviewLoopEnabled: true,
            maxIterations: 3,
            maxDurationMs: 15000,
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
        workflowModeEscalationRequest: {
            targetModeId: 'grounded',
            reason: 'insufficient evidence confidence for fast mode',
        },
    });

    assert.equal(response.metadata.workflowMode?.initial_mode, 'fast');
    assert.equal(response.metadata.workflowMode?.escalated_mode, 'grounded');
    assert.equal(
        response.metadata.workflowMode?.escalation_reason,
        'insufficient evidence confidence for fast mode'
    );
    assert.equal(response.metadata.workflowMode?.modeId, 'grounded');
    assert.equal(
        response.metadata.workflowMode?.selectedBy,
        'workflow_mode_escalation'
    );
});

test('runChatMessages emits schema-safe workflow metadata bounds under invalid injected config values', async () => {
    let callCount = 0;
    let capturedMetadata: ResponseMetadata | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate() {
            callCount += 1;
            if (callCount === 1) {
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

            return {
                text: '{"decision":"finalize","reason":"Done."}',
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

    const chatService = createChatService({
        generationRuntime,
        storeTrace: async (metadata) => {
            capturedMetadata = metadata;
        },
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        chatWorkflowConfig: {
            reviewLoopEnabled: true,
            maxIterations: Number.POSITIVE_INFINITY,
            maxDurationMs: Number.NaN,
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'Summarize this.' }],
        conversationSnapshot: 'Summarize this.',
    });

    const parseResult = ResponseMetadataSchema.safeParse(response.metadata);
    assert.equal(parseResult.success, true);
    assert.equal(callCount, 2);
    assert.ok((response.metadata.workflow?.maxSteps ?? 0) > 0);
    assert.ok((response.metadata.workflow?.maxDurationMs ?? 0) > 0);
    assert.equal(
        ResponseMetadataSchema.safeParse(capturedMetadata).success,
        true
    );
});

test('runChatMessages integrates advisory TrustGraph evidence into metadata without exposing raw adapter payload', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });
    let storedMetadata: ResponseMetadata | undefined;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            provenance: 'Inferred',
            citations: [],
            usage: {
                promptTokens: 20,
                completionTokens: 10,
                totalTokens: 30,
            },
        }),
        storeTrace: async (metadata) => {
            storedMetadata = metadata;
        },
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        executionContractTrustGraph: {
            adapter: new StubTrustGraphEvidenceAdapter('success'),
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy:
                TrustGraphOwnershipValidationPolicy.required({
                    policyId: 'chat_service_runtime_policy',
                }),
            scopeOwnershipValidator,
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
        executionContractTrustGraphContext: {
            queryIntent: 'What changed?',
            scopeTuple: {
                userId: 'user_1',
                projectId: 'project_1',
            },
        },
    });

    const trustGraph = (
        response.metadata as ResponseMetadata & {
            trustGraph?: Record<string, unknown>;
        }
    ).trustGraph as
        | {
              adapterStatus?: string;
              terminalAuthority?: string;
              failOpenBehavior?: string;
              verificationRequired?: boolean;
              provenanceJoin?: { externalEvidenceBundleId?: string };
              sufficiencyView?: { coverageValue?: number };
              adapterBundle?: unknown;
          }
        | undefined;
    assert.ok(trustGraph);
    assert.equal(trustGraph?.adapterStatus, 'success');
    assert.equal(trustGraph?.terminalAuthority, 'backend_execution_contract');
    assert.equal(trustGraph?.failOpenBehavior, 'local_behavior');
    assert.equal(trustGraph?.verificationRequired, true);
    assert.deepEqual(
        (trustGraph as { scopeValidation?: unknown })?.scopeValidation,
        {
            ok: true,
            normalizedScope: {
                userId: '[redacted]',
                projectId: '[redacted]',
            },
        }
    );
    assert.ok(
        typeof trustGraph?.provenanceJoin?.externalEvidenceBundleId === 'string'
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            trustGraph?.provenanceJoin ?? {},
            'scopeTuple'
        ),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(trustGraph ?? {}, 'adapterBundle'),
        false
    );
    assert.ok((response.metadata.evidenceScore ?? 0) >= 1);
    assert.equal(
        (
            storedMetadata as ResponseMetadata & {
                trustGraph?: Record<string, unknown>;
            }
        )?.trustGraph !== undefined,
        true
    );
});

test('runChatMessages trustgraph ON/OFF does not change local execution authority surface', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });

    const runWithTrustGraph = async (enabled: boolean) => {
        const chatService = createChatService({
            generationRuntime: createRuntime({
                text: 'chat response',
                provenance: 'Inferred',
                citations: [],
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata,
            defaultModel: 'gpt-5-mini',
            recordUsage: () => undefined,
            ...(enabled && {
                executionContractTrustGraph: {
                    adapter: new StubTrustGraphEvidenceAdapter('success'),
                    budget: {
                        timeoutMs: 100,
                        maxCalls: 1,
                    },
                    ownershipValidationPolicy:
                        TrustGraphOwnershipValidationPolicy.required({
                            policyId: 'chat_service_runtime_policy',
                        }),
                    scopeOwnershipValidator,
                },
            }),
        });

        return await chatService.runChatMessages({
            messages: [{ role: 'user', content: 'What changed?' }],
            conversationSnapshot: 'What changed?',
            ...(enabled && {
                executionContractTrustGraphContext: {
                    queryIntent: 'What changed?',
                    scopeTuple: {
                        userId: 'user_1',
                        projectId: 'project_1',
                    },
                },
            }),
        });
    };

    const withoutTrustGraph = await runWithTrustGraph(false);
    const withTrustGraph = await runWithTrustGraph(true);

    assert.equal(withoutTrustGraph.message, withTrustGraph.message);
    assert.equal(withoutTrustGraph.metadata.provenance, 'Inferred');
    assert.equal(withTrustGraph.metadata.provenance, 'Inferred');
    assert.equal(
        (
            withoutTrustGraph.metadata as ResponseMetadata & {
                trustGraph?: unknown;
            }
        ).trustGraph,
        undefined
    );
    assert.ok(
        (
            withTrustGraph.metadata as ResponseMetadata & {
                trustGraph?: unknown;
            }
        ).trustGraph
    );
});

test('runChatMessages preserves local response authority when TrustGraph ownership denies under Execution Contract policy carriage', async () => {
    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: false,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:deny'],
                    denialReason: 'tenant_mismatch',
                    details: 'scope is outside tenant boundary',
                }),
            },
        });

    const ExecutionContract = resolveExecutionContract({
        presetId: 'quality-grounded',
    }).policyContract;

    const chatService = createChatService({
        generationRuntime: createRuntime({
            text: 'local response despite ownership deny',
            provenance: 'Inferred',
            citations: [],
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
        executionContractTrustGraph: {
            adapter: new StubTrustGraphEvidenceAdapter('success'),
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy:
                TrustGraphOwnershipValidationPolicy.required({
                    policyId: 'chat_service_runtime_policy',
                }),
            scopeOwnershipValidator,
        },
    });

    const response = await chatService.runChatMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
        ExecutionContract,
        executionContractTrustGraphContext: {
            queryIntent: 'What changed?',
            scopeTuple: {
                userId: 'user_1',
                projectId: 'project_1',
            },
        },
    });

    const trustGraph = (
        response.metadata as ResponseMetadata & {
            trustGraph?: {
                adapterStatus?: string;
                terminalAuthority?: string;
                failOpenBehavior?: string;
            };
        }
    ).trustGraph;

    assert.equal(response.message, 'local response despite ownership deny');
    assert.equal(response.metadata.provenance, 'Inferred');
    assert.equal(trustGraph?.adapterStatus, 'scope_denied');
    assert.equal(trustGraph?.terminalAuthority, 'backend_execution_contract');
    assert.equal(trustGraph?.failOpenBehavior, 'local_behavior');
});
