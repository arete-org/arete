/**
 * @description: Verifies that Reflect generation settings stay aligned with the canonical runtime seam types.
 * @footnote-scope: test
 * @footnote-module: ReflectGenerationTypeAlignmentTests
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
    ReflectGenerationPlan,
    ReflectGenerationSearch,
} from '../src/services/reflectGenerationTypes.js';

const toRuntimeSettings = (
    generation: ReflectGenerationPlan
): Pick<GenerationRequest, 'reasoningEffort' | 'verbosity' | 'search'> => ({
    reasoningEffort: generation.reasoningEffort,
    verbosity: generation.verbosity,
    search: generation.search,
});

test('reflect generation settings stay assignable to canonical runtime settings', () => {
    const search: ReflectGenerationSearch = {
        query: 'Footnote architecture overview',
        contextSize: 'medium',
        intent: 'repo_explainer',
        repoHints: ['architecture', 'backend'],
    };
    const generation: ReflectGenerationPlan = {
        reasoningEffort: 'medium',
        verbosity: 'high',
        search,
    };
    const runtimeSettings = toRuntimeSettings(generation);
    const canonicalSearch: GenerationSearchRequest | undefined =
        runtimeSettings.search;

    assert.equal(runtimeSettings.reasoningEffort, 'medium');
    assert.equal(runtimeSettings.verbosity, 'high');
    assert.equal(canonicalSearch?.intent, 'repo_explainer');
    assert.deepEqual(canonicalSearch?.repoHints, ['architecture', 'backend']);
});
