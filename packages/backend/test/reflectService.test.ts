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
    confidence: 0.5,
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
                    confidence: 0.5,
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
                    confidence: 0.5,
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
                    confidence: 0.5,
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
