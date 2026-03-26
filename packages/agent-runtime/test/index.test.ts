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
} from '../src/index.js';

test('createGenerationRuntime builds the VoltAgent runtime', async () => {
    const runtime = createGenerationRuntime({
        kind: 'voltagent',
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
