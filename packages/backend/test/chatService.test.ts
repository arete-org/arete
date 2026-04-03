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
import {
    buildResponseMetadata,
    type ResponseMetadataRetrievalContext,
    type ResponseMetadataRuntimeContext,
} from '../src/services/openaiService.js';
import { createChatService } from '../src/services/chatService.js';
import type { BackendLLMCostRecord } from '../src/services/llmCostRecorder.js';

const createMetadata = (): ResponseMetadata => ({
    responseId: 'chat_test_response',
    provenance: 'Inferred',
    safetyTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'abc123def456',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
});

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

test('runChatMessages forwards execution context into metadata runtime context', async () => {
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
                profileId: 'openai-text-fast',
                provider: 'openai',
                model: 'gpt-5-nano',
            },
            evaluator: {
                status: 'executed',
                outcome: {
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
        profileId: 'openai-text-fast',
        provider: 'openai',
        model: 'gpt-5-nano',
    });
    assert.deepEqual(capturedExecutionContext?.evaluator, {
        status: 'executed',
        outcome: {
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
    assert.equal(capturedWorkflow?.workflowName, 'message_with_review_loop_v1');
    assert.equal(capturedWorkflow?.terminationReason, 'goal_satisfied');
    assert.equal(capturedWorkflow?.status, 'completed');
    assert.ok((capturedWorkflow?.steps.length ?? 0) >= 2);
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
