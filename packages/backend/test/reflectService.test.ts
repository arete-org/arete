/**
 * @description: Covers backend cost recording in the shared reflect service.
 * @footnote-scope: test
 * @footnote-module: ReflectServiceTests
 * @footnote-risk: medium - Missing tests could let backend reflect stop recording usage silently.
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
import {
    buildResponseMetadata,
    type ResponseMetadataRetrievalContext,
} from '../src/services/openaiService.js';
import { createReflectService } from '../src/services/reflectService.js';
import type { BackendLLMCostRecord } from '../src/services/llmCostRecorder.js';

const createMetadata = (): ResponseMetadata => ({
    responseId: 'reflect_test_response',
    provenance: 'Inferred',
    riskTier: 'Low',
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
            text: 'reflect response',
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

test('createReflectService records backend token usage and estimated cost', async () => {
    const usageRecords: BackendLLMCostRecord[] = [];
    const reflectService = createReflectService({
        generationRuntime: createRuntime(),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: (record) => {
            usageRecords.push(record);
        },
    });

    const response = await reflectService.runReflect({
        question: 'What changed?',
    });

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'reflect response');
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].feature, 'reflect');
    assert.equal(usageRecords[0].model, 'gpt-5-mini');
    assert.equal(usageRecords[0].promptTokens, 120);
    assert.equal(usageRecords[0].completionTokens, 80);
    assert.equal(usageRecords[0].totalTokens, 200);
    assert.equal(usageRecords[0].inputCostUsd, 0.00003);
    assert.equal(usageRecords[0].outputCostUsd, 0.00016);
    assert.equal(usageRecords[0].totalCostUsd, 0.00019);
});

test('createReflectService passes the effective model to response metadata building', async () => {
    let capturedRuntimeContextModelVersion: string | null = null;

    const reflectService = createReflectService({
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

    await reflectService.runReflect({
        question: 'What changed?',
    });

    assert.equal(capturedRuntimeContextModelVersion, 'gpt-5.1');
});

test('createReflectService preserves the caller-requested model when the runtime omits one', async () => {
    const usageRecords: BackendLLMCostRecord[] = [];
    let capturedRuntimeContextModelVersion: string | null = null;

    const reflectService = createReflectService({
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

    await reflectService.runReflectMessages({
        messages: [{ role: 'user', content: 'What changed?' }],
        conversationSnapshot: 'What changed?',
        model: 'gpt-5.1',
    });

    assert.equal(capturedRuntimeContextModelVersion, 'gpt-5.1');
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].model, 'gpt-5.1');
});

test('runReflectMessages passes planner temperament into response metadata runtime context', async () => {
    let capturedPlannerTemperament:
        | import('@footnote/contracts/ethics-core').PartialResponseTemperament
        | undefined;

    const reflectService = createReflectService({
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

    await reflectService.runReflectMessages({
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

test('runReflectMessages passes structured retrieval facts into response metadata runtime context', async () => {
    let capturedRetrieval: ResponseMetadataRetrievalContext | undefined;

    const reflectService = createReflectService({
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

    await reflectService.runReflectMessages({
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

test('runReflectMessages passes non-retrieval facts for plain VoltAgent-backed runs', async () => {
    let capturedRetrieval: ResponseMetadataRetrievalContext | undefined;

    const reflectService = createReflectService({
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

    await reflectService.runReflectMessages({
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

test('createReflectService swallows usage recording failures', async () => {
    const reflectService = createReflectService({
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

    const response = await reflectService.runReflect({
        question: 'What changed?',
    });

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'reflect response');
    assert.equal(response.metadata.responseId, 'reflect_test_response');
});

test('runReflectMessages adds a backend repo-explainer response hint', async () => {
    let seenMessages: Array<{ role: string; content: string }> = [];
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate({ messages }) {
            seenMessages = messages;
            return {
                text: 'reflect response',
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

    const reflectService = createReflectService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await reflectService.runReflectMessages({
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

test('runReflectMessages forwards planner-selected generation settings to GenerationRuntime', async () => {
    let seenRequest:
        | import('@footnote/agent-runtime').GenerationRequest
        | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(request) {
            seenRequest = request;
            return {
                text: 'reflect response',
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

    const reflectService = createReflectService({
        generationRuntime,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await reflectService.runReflectMessages({
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
            },
        },
    });

    assert.ok(seenRequest?.search);
    assert.equal(seenRequest?.reasoningEffort, 'medium');
    assert.equal(seenRequest?.verbosity, 'medium');
    assert.equal(seenRequest?.search?.query, 'latest OpenAI policy update');
    assert.equal(seenRequest?.search?.intent, 'current_facts');
});

test('runReflectMessages records usage correctly when VoltAgent search falls back to the legacy runtime', async () => {
    const usageRecords: BackendLLMCostRecord[] = [];
    let fallbackCalled = false;
    let executorCalled = false;
    const reflectService = createReflectService({
        generationRuntime: createVoltAgentRuntime({
            defaultModel: 'gpt-5-mini',
            fallbackRuntime: {
                kind: 'legacy-openai',
                async generate() {
                    fallbackCalled = true;
                    return {
                        text: 'legacy search reply',
                        model: 'gpt-5-mini',
                        usage: {
                            promptTokens: 50,
                            completionTokens: 25,
                            totalTokens: 75,
                        },
                        provenance: 'Retrieved',
                        citations: [],
                    };
                },
            },
            createExecutor: () => ({
                async generateText() {
                    executorCalled = true;
                    return {
                        text: 'unexpected',
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

    await reflectService.runReflectMessages({
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

    assert.equal(fallbackCalled, true);
    assert.equal(executorCalled, false);
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].model, 'gpt-5-mini');
    assert.equal(usageRecords[0].promptTokens, 50);
    assert.equal(usageRecords[0].completionTokens, 25);
    assert.equal(usageRecords[0].totalTokens, 75);
});

test('runReflectMessages stores evidence and freshness chips for retrieved search replies', async () => {
    let storedMetadata: ResponseMetadata | undefined;

    const reflectService = createReflectService({
        generationRuntime: createVoltAgentRuntime({
            defaultModel: 'gpt-5-mini',
            fallbackRuntime: {
                kind: 'legacy-openai',
                async generate() {
                    return {
                        text: 'search-backed reply',
                        model: 'gpt-5-mini',
                        usage: {
                            promptTokens: 50,
                            completionTokens: 25,
                            totalTokens: 75,
                        },
                        provenance: 'Retrieved',
                        citations: [
                            { title: 'One', url: 'https://example.com/1' },
                            { title: 'Two', url: 'https://example.com/2' },
                        ],
                        retrieval: {
                            requested: true,
                            used: true,
                        },
                    };
                },
            },
            createExecutor: () => ({
                async generateText() {
                    return {
                        text: 'unexpected',
                    };
                },
            }),
        }),
        storeTrace: async (metadata) => {
            storedMetadata = metadata;
        },
        buildResponseMetadata,
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await reflectService.runReflectMessages({
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
