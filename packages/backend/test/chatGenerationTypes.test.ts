/**
 * @description: Verifies that Chat generation settings stay aligned with the canonical runtime seam types.
 * @footnote-scope: test
 * @footnote-module: ChatGenerationTypeAlignmentTests
 * @footnote-risk: medium - Missing tests here could let backend-only generation shapes drift away from the runtime boundary.
 * @footnote-ethics: medium - Type drift can weaken retrieval and provenance behavior by desynchronizing planner output from runtime execution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
    GenerationRequest,
    GenerationSearchRequest,
} from '@footnote/agent-runtime';
import type {
    ChatGenerationPlan,
    ChatGenerationSearch,
} from '../src/services/chatGenerationTypes.js';

const toRuntimeSettings = (
    generation: ChatGenerationPlan
): Pick<GenerationRequest, 'reasoningEffort' | 'verbosity' | 'search'> => ({
    reasoningEffort: generation.reasoningEffort,
    verbosity: generation.verbosity,
    search: generation.search,
});

test('chat generation settings stay assignable to canonical runtime settings', () => {
    const search: ChatGenerationSearch = {
        query: 'Footnote architecture overview',
        contextSize: 'medium',
        intent: 'repo_explainer',
        repoHints: ['architecture', 'backend'],
    };
    const generation: ChatGenerationPlan = {
        reasoningEffort: 'medium',
        verbosity: 'high',
        search,
    };
    const runtimeSettings = toRuntimeSettings(generation);
    const canonicalSearch: GenerationSearchRequest | undefined =
        runtimeSettings.search;

    assert.equal(runtimeSettings.reasoningEffort, 'medium');
    assert.equal(runtimeSettings.verbosity, 'high');
    assert.equal(canonicalSearch?.query, 'Footnote architecture overview');
    assert.equal(canonicalSearch?.contextSize, 'medium');
    assert.equal(canonicalSearch?.intent, 'repo_explainer');
    assert.deepEqual(canonicalSearch?.repoHints, ['architecture', 'backend']);
});
