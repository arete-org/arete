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
} from '../src/index.js';

test('createGenerationRuntime returns a placeholder runtime with the requested kind', async () => {
    const runtime = createGenerationRuntime({ kind: 'test-runtime' });
    const request: GenerationRequest = {
        messages: [{ role: 'user', content: 'Hello there.' }],
    };

    assert.equal(runtime.kind, 'test-runtime');
    await assert.rejects(
        () => runtime.generate(request),
        /Generation runtime "test-runtime" has not been implemented yet./
    );
});
