/**
 * @description: Covers backend execution-bridge mapping between the generic generation seam and the current OpenAI wrapper.
 * @footnote-scope: test
 * @footnote-module: GenerationExecutionBridgeTests
 * @footnote-risk: medium - Missing tests here could let backend request/result mapping drift before a real runtime adapter exists.
 * @footnote-ethics: medium - This bridge preserves retrieval, provenance, and usage facts that affect Footnote transparency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRequest } from '@footnote/agent-runtime';
import {
    buildLegacyOpenAiGenerateOptions,
    executeLegacyOpenAiGeneration,
    type LegacyOpenAiClient,
} from '@footnote/agent-runtime/legacyOpenAiRuntime';
import {
    buildGenerateResponseOptions,
    executeOpenAIGeneration,
} from '../src/services/generationExecution.js';
import type { OpenAIService } from '../src/services/openaiService.js';

test('buildGenerateResponseOptions delegates to the legacy runtime adapter mapping', () => {
    const request: GenerationRequest = {
        messages: [{ role: 'user', content: 'What changed today?' }],
        model: 'gpt-5-mini',
        maxOutputTokens: 900,
        reasoningEffort: 'medium',
        verbosity: 'high',
        search: {
            query: 'latest OpenAI policy update',
            contextSize: 'low',
            intent: 'current_facts',
            repoHints: [],
        },
    };

    assert.deepEqual(
        buildGenerateResponseOptions(request),
        buildLegacyOpenAiGenerateOptions(request)
    );
});

test('buildGenerateResponseOptions omits search when generation request does not include it', () => {
    const request: GenerationRequest = {
        messages: [{ role: 'user', content: 'Explain the architecture.' }],
        model: 'gpt-5-mini',
        reasoningEffort: 'low',
        verbosity: 'medium',
    };

    const options = buildGenerateResponseOptions(request);

    assert.equal(options.search, undefined);
    assert.equal(options.maxOutputTokens, undefined);
});

test('executeOpenAIGeneration normalizes OpenAI output into GenerationResult', async () => {
    let seenModel: string | undefined;
    let seenMessages: Array<{ role: string; content: string }> | undefined;
    let seenOptions:
        | import('../src/services/openaiService.js').GenerateResponseOptions
        | undefined;
    const openaiService: OpenAIService = {
        async generateResponse(model, messages, options) {
            seenModel = model;
            seenMessages = messages;
            seenOptions = options;

            return {
                normalizedText: 'normalized bridge reply',
                metadata: {
                    model: 'gpt-5.1',
                    finishReason: 'stop',
                    usage: {
                        prompt_tokens: 120,
                        completion_tokens: 80,
                        total_tokens: 200,
                    },
                    provenance: 'Retrieved',
                    citations: [
                        {
                            title: 'Source',
                            url: 'https://example.com/source',
                            snippet: 'important excerpt',
                        },
                    ],
                },
            };
        },
    };
    const legacyClient: LegacyOpenAiClient = openaiService;
    const request: GenerationRequest = {
        messages: [{ role: 'user', content: 'What changed today?' }],
        model: 'gpt-5-mini',
        maxOutputTokens: 700,
        reasoningEffort: 'medium',
        verbosity: 'medium',
        search: {
            query: 'latest OpenAI policy update',
            contextSize: 'low',
            intent: 'current_facts',
        },
    };

    const result = await executeOpenAIGeneration({
        openaiService,
        request,
    });
    const delegatedResult = await executeLegacyOpenAiGeneration({
        client: legacyClient,
        request,
    });

    assert.equal(seenModel, 'gpt-5-mini');
    assert.deepEqual(seenMessages, request.messages);
    assert.equal(seenOptions?.maxOutputTokens, 700);
    assert.equal(seenOptions?.reasoningEffort, 'medium');
    assert.equal(seenOptions?.verbosity, 'medium');
    assert.equal(seenOptions?.search?.query, 'latest OpenAI policy update');

    assert.equal(result.generationResult.text, 'normalized bridge reply');
    assert.equal(result.generationResult.model, 'gpt-5.1');
    assert.equal(result.generationResult.finishReason, 'stop');
    assert.deepEqual(result.generationResult.usage, {
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
    });
    assert.deepEqual(result.generationResult.citations, [
        {
            title: 'Source',
            url: 'https://example.com/source',
            snippet: 'important excerpt',
        },
    ]);
    assert.deepEqual(result.generationResult.retrieval, {
        requested: true,
        used: true,
    });
    assert.equal(result.generationResult.provenance, 'Retrieved');
    assert.equal(result.assistantMetadata.model, 'gpt-5.1');
    assert.deepEqual(result.generationResult, delegatedResult.generationResult);
    assert.deepEqual(result.assistantMetadata, delegatedResult.metadata);
});
