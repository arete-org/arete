/**
 * @description: Covers the exported generation seam for the internal runtime package.
 * @footnote-scope: test
 * @footnote-module: AgentRuntimeExportsTests
 * @footnote-risk: low - Missing tests here could let the package surface drift without a quick signal.
 * @footnote-ethics: low - These tests only verify package-boundary behavior, not user-facing policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createGenerationRuntime,
    type GenerationRequest,
    type GenerationRuntime,
} from '../src/index.js';

test('createGenerationRuntime builds the legacy OpenAI runtime', async () => {
    const runtime = createGenerationRuntime({
        kind: 'legacy-openai',
        client: {
            async generateResponse() {
                return {
                    normalizedText: 'legacy reply',
                    metadata: {
                        model: 'gpt-5-mini',
                    },
                };
            },
        },
    });

    const result = await runtime.generate({
        messages: [{ role: 'user', content: 'Hello there.' }],
        model: 'gpt-5-mini',
    });

    assert.equal(runtime.kind, 'legacy-openai');
    assert.equal(result.text, 'legacy reply');
});

test('createGenerationRuntime builds the VoltAgent runtime', async () => {
    const fallbackRuntime: GenerationRuntime = {
        kind: 'legacy-openai',
        async generate(request: GenerationRequest) {
            return {
                text: `fallback:${request.messages[0]?.content ?? ''}`,
                retrieval: {
                    requested: true,
                    used: true,
                },
                provenance: 'Retrieved',
            };
        },
    };
    const runtime = createGenerationRuntime({
        kind: 'voltagent',
        fallbackRuntime,
        defaultModel: 'gpt-5-mini',
        createExecutor: ({ model }) => ({
            async generateText() {
                return {
                    text: `voltagent:${model}`,
                    response: {
                        modelId: model,
                    },
                };
            },
        }),
    });

    const result = await runtime.generate({
        messages: [{ role: 'user', content: 'Hello there.' }],
    });

    assert.equal(runtime.kind, 'voltagent');
    assert.equal(result.text, 'voltagent:openai/gpt-5-mini');
    assert.equal(result.model, 'gpt-5-mini');
});
