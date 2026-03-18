/**
 * @description: Covers the legacy OpenAI-backed generation runtime adapter.
 * @footnote-scope: test
 * @footnote-module: LegacyOpenAiRuntimeTests
 * @footnote-risk: medium - Missing tests here could let legacy request/result mapping drift before backend cutover.
 * @footnote-ethics: medium - This adapter preserves retrieval, provenance, and usage facts that feed Footnote transparency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRequest } from '../src/index.js';
import {
    createLegacyOpenAiRuntime,
    executeLegacyOpenAiGeneration,
    type LegacyOpenAiClient,
} from '../src/legacyOpenAiRuntime.js';

test('legacy runtime maps canonical search and generation settings into client options', async () => {
    let seenModel: string | undefined;
    let seenMessages: Array<{ role: string; content: string }> | undefined;
    let seenOptions:
        | import('../src/legacyOpenAiRuntime.js').LegacyOpenAiGenerateOptions
        | undefined;
    const signal = new AbortController().signal;
    const client: LegacyOpenAiClient = {
        async generateResponse(model, messages, options) {
            seenModel = model;
            seenMessages = messages;
            seenOptions = options;

            return {
                normalizedText: 'legacy reply',
                metadata: {
                    model: 'gpt-5.1',
                },
            };
        },
    };
    const runtime = createLegacyOpenAiRuntime({ client });
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
        signal,
    };

    const result = await runtime.generate(request);

    assert.equal(runtime.kind, 'legacy-openai');
    assert.equal(seenModel, 'gpt-5-mini');
    assert.deepEqual(seenMessages, request.messages);
    assert.equal(seenOptions?.maxOutputTokens, 900);
    assert.equal(seenOptions?.reasoningEffort, 'medium');
    assert.equal(seenOptions?.verbosity, 'high');
    assert.equal(seenOptions?.signal, signal);
    assert.deepEqual(seenOptions?.search, {
        query: 'latest OpenAI policy update',
        contextSize: 'low',
        intent: 'current_facts',
        repoHints: [],
    });
    assert.equal(result.text, 'legacy reply');
});

test('legacy runtime omits search when canonical request does not include it', async () => {
    let seenOptions:
        | import('../src/legacyOpenAiRuntime.js').LegacyOpenAiGenerateOptions
        | undefined;
    const client: LegacyOpenAiClient = {
        async generateResponse(_model, _messages, options) {
            seenOptions = options;

            return {
                normalizedText: 'no search reply',
                metadata: {
                    model: 'gpt-5-mini',
                },
            };
        },
    };
    const runtime = createLegacyOpenAiRuntime({ client });

    await runtime.generate({
        messages: [{ role: 'user', content: 'Explain the architecture.' }],
        model: 'gpt-5-mini',
        reasoningEffort: 'low',
        verbosity: 'medium',
    });

    assert.equal(seenOptions?.search, undefined);
});

test('legacy runtime normalizes provider output into GenerationResult', async () => {
    const client: LegacyOpenAiClient = {
        async generateResponse() {
            return {
                normalizedText: 'normalized legacy reply',
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

    const result = await executeLegacyOpenAiGeneration({
        client,
        request: {
            messages: [{ role: 'user', content: 'What changed today?' }],
            model: 'gpt-5-mini',
            search: {
                query: 'latest OpenAI policy update',
                contextSize: 'low',
                intent: 'current_facts',
            },
        },
    });

    assert.equal(result.generationResult.text, 'normalized legacy reply');
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
    assert.equal(result.metadata.model, 'gpt-5.1');
});

test('legacy runtime fails fast when the canonical request is missing a model', async () => {
    const client: LegacyOpenAiClient = {
        async generateResponse() {
            throw new Error('provider should not be called');
        },
    };

    await assert.rejects(
        () =>
            executeLegacyOpenAiGeneration({
                client,
                request: {
                    messages: [{ role: 'user', content: 'Hello there.' }],
                },
            }),
        /Missing model for legacy request\./
    );
});
