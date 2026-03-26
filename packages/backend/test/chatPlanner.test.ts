/**
 * @description: Covers backend chat planner parsing and normalization behavior.
 * @footnote-scope: test
 * @footnote-module: ChatPlannerTests
 * @footnote-risk: medium - Missing tests here can let planner regressions hide behind safe fallbacks.
 * @footnote-ethics: medium - Planner normalization affects retrieval quality and response appropriateness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostChatRequest } from '@footnote/contracts/web';
import {
    createChatPlanner,
    type ChatPlannerProfileOption,
} from '../src/services/chatPlanner.js';

const createChatRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
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

const createPlanner = (
    normalizedText: string,
    availableProfiles: ChatPlannerProfileOption[] = []
) =>
    createChatPlanner({
        executePlanner: async () => ({
            text: normalizedText,
            model: 'gpt-5-mini',
        }),
        availableProfiles,
    });

test('chatPlanner parses plain JSON output from the backend-native planner prompt', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            profileId: 'openai-text-medium',
            riskTier: 'Low',
            reasoning: 'The user is asking a question that needs a reply.',
            generation: {
                reasoningEffort: 'medium',
                verbosity: 'medium',
                temperament: {
                    tightness: 4,
                    rationale: 3,
                    attribution: 4,
                    caution: 3,
                    extent: 4,
                },
                search: {
                    query: 'latest Footnote release notes',
                    contextSize: 'low',
                    intent: 'current_facts',
                },
            },
        })
    );
    const { plan, execution } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.profileId, 'openai-text-medium');
    assert.ok(plan.generation.search);
    assert.equal(
        plan.generation.search?.query,
        'latest Footnote release notes'
    );
    assert.equal(plan.generation.search?.intent, 'current_facts');
    assert.equal(execution.status, 'executed');
    assert.ok(execution.durationMs >= 0);
});

test('chatPlanner forwards bounded profile options context and normalizes blank profileId', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const availableProfiles: ChatPlannerProfileOption[] = [
        {
            id: 'openai-text-fast',
            description: 'Fast profile for short planner tasks.',
            costClass: 'low',
            latencyClass: 'low',
            capabilities: { canUseSearch: false },
        },
        {
            id: 'openai-text-medium',
            description: 'Balanced profile for chat responses.',
            costClass: 'medium',
            latencyClass: 'medium',
            capabilities: { canUseSearch: true },
        },
    ];

    const planner = createChatPlanner({
        availableProfiles,
        executePlanner: async ({ messages }) => {
            capturedMessages = messages;
            return {
                text: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    profileId: '   ',
                    riskTier: 'Low',
                    reasoning: 'Use safe defaults.',
                    generation: {
                        reasoningEffort: 'low',
                        verbosity: 'low',
                        temperament: {
                            tightness: 4,
                            rationale: 3,
                            attribution: 4,
                            caution: 3,
                            extent: 4,
                        },
                    },
                }),
                model: 'gpt-5-mini',
            };
        },
    });

    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.profileId, undefined);
    const profileContextMessage =
        capturedMessages.find((message) =>
            message.content.startsWith('Planner profile options (bounded): ')
        )?.content ?? '';
    assert.match(
        profileContextMessage,
        /^Planner profile options \(bounded\): \[/
    );
    const encodedProfiles = profileContextMessage.replace(
        'Planner profile options (bounded): ',
        ''
    );
    const parsedProfiles = JSON.parse(
        encodedProfiles
    ) as ChatPlannerProfileOption[];
    assert.deepEqual(parsedProfiles, availableProfiles);
});

test('chatPlanner fails open to a valid fallback generation config when planner JSON is invalid', async () => {
    const planner = createPlanner('{not-valid-json');
    const { plan, execution } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.generation.search, undefined);
    assert.equal(plan.generation.reasoningEffort, 'low');
    assert.equal(plan.generation.verbosity, 'low');
    assert.equal(execution.status, 'failed');
    assert.equal(execution.reasonCode, 'planner_invalid_output');
});

test('repo_explainer search plans normalize repo hints and medium context', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            riskTier: 'Low',
            reasoning: 'This is a Footnote architecture question.',
            generation: {
                reasoningEffort: 'low',
                verbosity: 'medium',
                temperament: {
                    tightness: 4,
                    rationale: 3,
                    attribution: 4,
                    caution: 3,
                    extent: 4,
                },
                search: {
                    query: 'How does Discord provenance work in Footnote?',
                    contextSize: 'low',
                    intent: 'repo_explainer',
                    repoHints: ['Discord', 'provenance', 'discord', 'wiki'],
                },
            },
        })
    );
    const { plan } = await planner.planChat(createChatRequest());

    assert.ok(plan.generation.search);
    assert.equal(plan.generation.search?.intent, 'repo_explainer');
    assert.equal(plan.generation.search?.contextSize, 'medium');
    assert.deepEqual(plan.generation.search?.repoHints, [
        'discord',
        'provenance',
    ]);
});

test('invalid web_search query downgrades safely to none', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            riskTier: 'Low',
            reasoning: 'This could have used search.',
            generation: {
                reasoningEffort: 'low',
                verbosity: 'low',
                temperament: {
                    tightness: 4,
                    rationale: 3,
                    attribution: 4,
                    caution: 3,
                    extent: 4,
                },
                search: {
                    query: '   ',
                    contextSize: 'medium',
                    intent: 'repo_explainer',
                    repoHints: ['discord'],
                },
            },
        })
    );
    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.generation.search, undefined);
    assert.match(plan.reasoning, /search was disabled safely/i);
});

test('planner temperament is accepted when all TRACE axes are integer 1..5', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            riskTier: 'Low',
            reasoning: 'This should include TRACE temperament guidance.',
            generation: {
                reasoningEffort: 'low',
                verbosity: 'low',
                temperament: {
                    tightness: 5,
                    rationale: 3,
                    attribution: 4,
                    caution: 2,
                    extent: 1,
                },
            },
        })
    );
    const { plan } = await planner.planChat(createChatRequest());

    assert.deepEqual(plan.generation.temperament, {
        tightness: 5,
        rationale: 3,
        attribution: 4,
        caution: 2,
        extent: 1,
    });
});

test('message plans with missing or invalid TRACE axes fall back safely', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            riskTier: 'Low',
            reasoning: 'This should include TRACE temperament guidance.',
            generation: {
                reasoningEffort: 'medium',
                verbosity: 'high',
                temperament: {
                    tightness: 5,
                    rationale: 3,
                    attribution: 4,
                    caution: 6,
                    extent: 1,
                },
                search: {
                    query: 'latest release notes',
                    contextSize: 'low',
                    intent: 'current_facts',
                },
            },
        })
    );
    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.generation.search, undefined);
    assert.equal(plan.generation.reasoningEffort, 'low');
    assert.equal(plan.generation.verbosity, 'low');
    assert.equal(plan.generation.temperament, undefined);
    assert.match(plan.reasoning, /missing|invalid|TRACE temperament/i);
});

test('react plans with non-emoji payload fall back safely', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'react',
            modality: 'text',
            riskTier: 'Low',
            reaction: 'sounds good',
            reasoning: 'A reaction is enough.',
            generation: {
                reasoningEffort: 'low',
                verbosity: 'low',
            },
        })
    );
    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.reaction, undefined);
    assert.equal(plan.generation.search, undefined);
    assert.equal(plan.generation.temperament, undefined);
    assert.match(plan.reasoning, /not a valid emoji token/i);
});
