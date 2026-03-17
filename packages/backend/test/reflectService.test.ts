/**
 * @description: Covers backend cost recording in the shared reflect service.
 * @footnote-scope: test
 * @footnote-module: ReflectServiceTests
 * @footnote-risk: medium - Missing tests could let backend reflect stop recording usage silently.
 * @footnote-ethics: medium - Cost accounting is part of responsible backend AI operation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { createReflectService } from '../src/services/reflectService.js';
import type { OpenAIService } from '../src/services/openaiService.js';
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

test('createReflectService records backend token usage and estimated cost', async () => {
    const usageRecords: BackendLLMCostRecord[] = [];
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: 'reflect response',
                metadata: {
                    model: 'gpt-5-mini',
                    usage: {
                        prompt_tokens: 120,
                        completion_tokens: 80,
                        total_tokens: 200,
                    },
                    provenance: 'Inferred',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const reflectService = createReflectService({
        openaiService,
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
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: 'reflect response',
                metadata: {
                    model: 'gpt-5.1',
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 8,
                        total_tokens: 20,
                    },
                    provenance: 'Inferred',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const reflectService = createReflectService({
        openaiService,
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

test('runReflectMessages passes planner temperament into response metadata runtime context', async () => {
    let capturedPlannerTemperament:
        | import('@footnote/contracts/ethics-core').PartialResponseTemperament
        | undefined;
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: 'reflect response',
                metadata: {
                    model: 'gpt-5-mini',
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 8,
                        total_tokens: 20,
                    },
                    provenance: 'Inferred',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const reflectService = createReflectService({
        openaiService,
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

test('runReflectMessages passes usedWebSearch flag into response metadata runtime context', async () => {
    let capturedUsedWebSearch: boolean | undefined;
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: 'reflect response',
                metadata: {
                    model: 'gpt-5-mini',
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 8,
                        total_tokens: 20,
                    },
                    provenance: 'Retrieved',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const reflectService = createReflectService({
        openaiService,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedUsedWebSearch = runtimeContext.usedWebSearch;
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

    assert.equal(capturedUsedWebSearch, true);
});

test('createReflectService swallows usage recording failures', async () => {
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: 'reflect response',
                metadata: {
                    model: 'gpt-5-mini',
                    usage: {
                        prompt_tokens: 20,
                        completion_tokens: 10,
                        total_tokens: 30,
                    },
                    provenance: 'Inferred',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const reflectService = createReflectService({
        openaiService,
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
    const openaiService: OpenAIService = {
        async generateResponse(_model, messages) {
            seenMessages = messages;
            return {
                normalizedText: 'reflect response',
                metadata: {
                    model: 'gpt-5-mini',
                    usage: {
                        prompt_tokens: 20,
                        completion_tokens: 10,
                        total_tokens: 30,
                    },
                    provenance: 'Retrieved',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const reflectService = createReflectService({
        openaiService,
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

test('runReflectMessages forwards planner-selected web search options to openaiService', async () => {
    let seenOptions:
        | import('../src/services/openaiService.js').GenerateResponseOptions
        | undefined;
    const openaiService: OpenAIService = {
        async generateResponse(_model, _messages, options) {
            seenOptions = options;
            return {
                normalizedText: 'reflect response',
                metadata: {
                    model: 'gpt-5-mini',
                    usage: {
                        prompt_tokens: 20,
                        completion_tokens: 10,
                        total_tokens: 30,
                    },
                    provenance: 'Retrieved',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const reflectService = createReflectService({
        openaiService,
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

    assert.ok(seenOptions?.search);
    assert.equal(seenOptions?.reasoningEffort, 'medium');
    assert.equal(seenOptions?.verbosity, 'medium');
    assert.equal(seenOptions?.search?.query, 'latest OpenAI policy update');
    assert.equal(seenOptions?.search?.intent, 'current_facts');
});
