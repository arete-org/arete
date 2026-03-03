/**
 * @description: Covers backend reflect planner parsing and normalization behavior.
 * @footnote-scope: test
 * @footnote-module: ReflectPlannerTests
 * @footnote-risk: medium - Missing tests here can let planner regressions hide behind safe fallbacks.
 * @footnote-ethics: medium - Planner normalization affects retrieval quality and response appropriateness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostReflectRequest } from '@footnote/contracts/web';
import { createReflectPlanner } from '../src/services/reflectPlanner.js';
import type { OpenAIService } from '../src/services/openaiService.js';

const createReflectRequest = (
    overrides: Partial<PostReflectRequest> = {}
): PostReflectRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'What changed?',
    conversation: [{ role: 'user', content: 'What changed?' }],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

test('reflectPlanner parses plain JSON output from the backend-native planner prompt', async () => {
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    riskTier: 'Low',
                    reasoning: 'The user is asking a question that needs a reply.',
                    generation: {
                        reasoningEffort: 'medium',
                        verbosity: 'medium',
                        toolChoice: 'web_search',
                        webSearch: {
                            query: 'latest Footnote release notes',
                            searchContextSize: 'low',
                            searchIntent: 'current_facts',
                        },
                    },
                }),
                metadata: {
                    model: 'gpt-5-mini',
                },
            };
        },
    };

    const planner = createReflectPlanner({ openaiService });
    const plan = await planner.planReflect(createReflectRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.generation.toolChoice, 'web_search');
    assert.equal(plan.generation.webSearch?.query, 'latest Footnote release notes');
    assert.equal(plan.generation.webSearch?.searchIntent, 'current_facts');
  });

test('reflectPlanner fails open to a valid fallback generation config when planner JSON is invalid', async () => {
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: '{not-valid-json',
                metadata: {
                    model: 'gpt-5-mini',
                },
            };
        },
    };

    const planner = createReflectPlanner({ openaiService });
    const plan = await planner.planReflect(createReflectRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.generation.toolChoice, 'none');
    assert.equal(plan.generation.reasoningEffort, 'low');
    assert.equal(plan.generation.verbosity, 'low');
});

test('repo_explainer search plans normalize repo hints and medium context', async () => {
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    riskTier: 'Low',
                    reasoning: 'This is a Footnote architecture question.',
                    generation: {
                        reasoningEffort: 'low',
                        verbosity: 'medium',
                        toolChoice: 'web_search',
                        webSearch: {
                            query: 'How does Discord provenance work in Footnote?',
                            searchContextSize: 'low',
                            searchIntent: 'repo_explainer',
                            repoHints: ['Discord', 'provenance', 'discord', 'wiki'],
                        },
                    },
                }),
                metadata: {
                    model: 'gpt-5-mini',
                },
            };
        },
    };

    const planner = createReflectPlanner({ openaiService });
    const plan = await planner.planReflect(createReflectRequest());

    assert.equal(plan.generation.toolChoice, 'web_search');
    assert.equal(plan.generation.webSearch?.searchIntent, 'repo_explainer');
    assert.equal(plan.generation.webSearch?.searchContextSize, 'medium');
    assert.deepEqual(plan.generation.webSearch?.repoHints, [
        'discord',
        'provenance',
    ]);
});

test('invalid web_search query downgrades safely to none', async () => {
    const openaiService: OpenAIService = {
        async generateResponse() {
            return {
                normalizedText: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    riskTier: 'Low',
                    reasoning: 'This could have used search.',
                    generation: {
                        reasoningEffort: 'low',
                        verbosity: 'low',
                        toolChoice: 'web_search',
                        webSearch: {
                            query: '   ',
                            searchContextSize: 'medium',
                            searchIntent: 'repo_explainer',
                            repoHints: ['discord'],
                        },
                    },
                }),
                metadata: {
                    model: 'gpt-5-mini',
                },
            };
        },
    };

    const planner = createReflectPlanner({ openaiService });
    const plan = await planner.planReflect(createReflectRequest());

    assert.equal(plan.generation.toolChoice, 'none');
    assert.equal(plan.generation.webSearch, undefined);
    assert.match(plan.reasoning, /search was disabled safely/i);
});
