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
    type ChatPlannerCapabilityProfileOption,
} from '../src/services/chatPlanner.js';
import { logger } from '../src/utils/logger.js';

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
    availableCapabilityProfiles: ChatPlannerCapabilityProfileOption[] = []
) =>
    createChatPlanner({
        executePlanner: async () => ({
            text: normalizedText,
            model: 'gpt-5-mini',
        }),
        availableCapabilityProfiles,
    });

const createStructuredPlanner = (
    decision: unknown,
    availableCapabilityProfiles: ChatPlannerCapabilityProfileOption[] = []
) =>
    createChatPlanner({
        executePlannerStructured: async () => ({
            decision,
            model: 'gpt-5-mini',
            usage: {
                promptTokens: 12,
                completionTokens: 8,
                totalTokens: 20,
            },
            rawArguments: JSON.stringify(decision),
        }),
        availableCapabilityProfiles,
    });

test('chatPlanner parses plain JSON output from the backend-native planner prompt', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
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
    assert.equal(plan.requestedCapabilityProfile, 'balanced-general');
    assert.ok(plan.generation.search);
    assert.equal(
        plan.generation.search?.query,
        'latest Footnote release notes'
    );
    assert.equal(plan.generation.search?.intent, 'current_facts');
    assert.equal(execution.status, 'executed');
    assert.ok(execution.durationMs >= 0);
});

test('chatPlanner parses fenced JSON output', async () => {
    const planner = createPlanner(`\`\`\`json
${JSON.stringify({
    action: 'message',
    modality: 'text',
    requestedCapabilityProfile: 'balanced-general',
    safetyTier: 'Low',
    reasoning: 'The user needs a normal reply.',
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
})}
\`\`\``);

    const { plan, execution } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.requestedCapabilityProfile, 'balanced-general');
    assert.equal(execution.status, 'executed');
});

test('chatPlanner accepts structured planner decisions without text JSON parsing', async () => {
    const planner = createStructuredPlanner({
        action: 'message',
        modality: 'text',
        requestedCapabilityProfile: 'structured-cheap',
        safetyTier: 'Low',
        reasoning: 'Reply should be a normal message.',
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
        },
    });

    const { plan, execution } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.requestedCapabilityProfile, 'structured-cheap');
    assert.equal(execution.status, 'executed');
});

test('chatPlanner marks structured policy-invalid decisions as failed with invalid-output reason', async () => {
    const planner = createStructuredPlanner({
        action: 'message',
        modality: 'text',
        safetyTier: 'Low',
        reasoning: 'Invalid policy decision shape for message action.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
        },
    });

    const { execution } = await planner.planChat(createChatRequest());

    assert.equal(execution.status, 'failed');
    assert.equal(execution.reasonCode, 'planner_invalid_output');
});

test('chatPlanner forwards bounded capability options context and rejects blank requested capability for message action', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const warnings: Array<{ message: string; meta?: unknown }> = [];
    const originalWarn = logger.warn;
    logger.warn = ((message: string, meta?: unknown) => {
        warnings.push({ message, meta });
        return logger;
    }) as typeof logger.warn;
    const availableCapabilityProfiles: ChatPlannerCapabilityProfileOption[] = [
        {
            id: 'structured-cheap',
            description: 'Fast structured routing profile.',
        },
        {
            id: 'balanced-general',
            description: 'Balanced generation profile.',
        },
    ];

    try {
        const planner = createChatPlanner({
            availableCapabilityProfiles,
            executePlanner: async ({ messages }) => {
                capturedMessages = messages;
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: '   ',
                        safetyTier: 'Low',
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

        const { execution } = await planner.planChat(createChatRequest());

        assert.equal(execution.status, 'failed');
        assert.equal(execution.reasonCode, 'planner_invalid_output');
        const profileContextMessage =
            capturedMessages.find((message) =>
                message.content.startsWith(
                    'Planner capability profiles (bounded): '
                )
            )?.content ?? '';
        assert.match(
            profileContextMessage,
            /^Planner capability profiles \(bounded\): \[/
        );
        const encodedProfiles = profileContextMessage.replace(
            'Planner capability profiles (bounded): ',
            ''
        );
        const parsedProfiles = JSON.parse(
            encodedProfiles
        ) as ChatPlannerCapabilityProfileOption[];
        assert.deepEqual(parsedProfiles, availableCapabilityProfiles);
        const fallbackWarning = warnings.find(
            (warning) =>
                (warning.meta as { event?: string } | undefined)?.event ===
                'chat.planner.fallback'
        );
        assert.ok(fallbackWarning);
        assert.deepEqual(
            (
                fallbackWarning?.meta as
                    | { correctionCodes?: string[] }
                    | undefined
            )?.correctionCodes,
            ['requested_capability_profile_missing']
        );
    } finally {
        logger.warn = originalWarn;
    }
});

test('chatPlanner marks unknown requested capability profile as invalid planner output for message action', async () => {
    const warnings: Array<{ message: string; meta?: unknown }> = [];
    const originalWarn = logger.warn;
    logger.warn = ((message: string, meta?: unknown) => {
        warnings.push({ message, meta });
        return logger;
    }) as typeof logger.warn;

    try {
        const planner = createStructuredPlanner({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'unknown-profile',
            safetyTier: 'Low',
            reasoning: 'Reply with a standard capability profile.',
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
        });

        const { execution } = await planner.planChat(createChatRequest());

        assert.equal(execution.status, 'failed');
        assert.equal(execution.reasonCode, 'planner_invalid_output');
        const fallbackWarning = warnings.find(
            (warning) =>
                (warning.meta as { event?: string } | undefined)?.event ===
                'chat.planner.fallback'
        );
        assert.ok(fallbackWarning);
        assert.deepEqual(
            (
                fallbackWarning?.meta as
                    | { correctionCodes?: string[] }
                    | undefined
            )?.correctionCodes,
            ['requested_capability_profile_invalid']
        );
    } finally {
        logger.warn = originalWarn;
    }
});

test('chatPlanner fails open to a valid fallback generation config when planner JSON is invalid', async () => {
    const warnings: Array<{ message: string; meta?: unknown }> = [];
    const originalWarn = logger.warn;
    logger.warn = ((message: string, meta?: unknown) => {
        warnings.push({ message, meta });
        return logger;
    }) as typeof logger.warn;

    try {
        const planner = createPlanner('{not-valid-json');
        const { plan, execution } = await planner.planChat(createChatRequest());

        assert.equal(plan.action, 'message');
        assert.equal(plan.generation.search, undefined);
        assert.equal(plan.generation.reasoningEffort, 'low');
        assert.equal(plan.generation.verbosity, 'low');
        assert.equal(execution.status, 'failed');
        assert.equal(execution.reasonCode, 'planner_invalid_output');
        const warning = warnings.find((entry) =>
            /using fallback plan/i.test(entry.message)
        );
        assert.ok(warning);
        assert.equal(
            (warning?.meta as { plannerMode?: string } | undefined)
                ?.plannerMode,
            'text_json'
        );
        assert.equal(
            (warning?.meta as { reasonCode?: string } | undefined)?.reasonCode,
            'planner_invalid_output'
        );
        assert.equal(
            (warning?.meta as { fallbackTo?: string } | undefined)?.fallbackTo,
            'safe_default_plan'
        );
    } finally {
        logger.warn = originalWarn;
    }
});

test('repo_explainer search plans normalize repo hints and medium context', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
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
                    topicHints: ['Incident Lifecycle', 'discord'],
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
    assert.deepEqual(plan.generation.search?.topicHints, [
        'incident lifecycle',
        'discord',
        'provenance',
    ]);
});

test('search topicHints are bounded, deduped, and normalized fail-open', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
            reasoning: 'Use focused retrieval hints for ranking.',
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
                    query: 'How does incident logging correlate with traces?',
                    contextSize: 'medium',
                    intent: 'current_facts',
                    topicHints: [
                        ' Incident Lifecycle ',
                        'trace envelope',
                        'trace envelope',
                        '',
                        'x'.repeat(41),
                        'weather tool',
                        'chat planner',
                        'extra item',
                    ],
                },
            },
        })
    );
    const { plan } = await planner.planChat(createChatRequest());

    assert.deepEqual(plan.generation.search?.topicHints, [
        'incident lifecycle',
        'trace envelope',
        'weather tool',
        'chat planner',
        'extra item',
    ]);
});

test('invalid web_search query downgrades safely to none', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
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

test('planner weather request is normalized when location contract is valid', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
            reasoning: 'Forecast details are needed.',
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
                weather: {
                    location: {
                        latitude: 39.0458,
                        longitude: -95.6694,
                    },
                    horizonPeriods: 8,
                },
            },
        })
    );

    const { plan } = await planner.planChat(createChatRequest());

    assert.deepEqual(plan.generation.weather, {
        location: {
            type: 'lat_lon',
            latitude: 39.0458,
            longitude: -95.6694,
        },
        horizonPeriods: 8,
    });
});

test('invalid weather request is disabled safely', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
            reasoning: 'Need weather data.',
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
                weather: {
                    location: {
                        city: 'Indianapolis',
                    },
                },
            },
        })
    );

    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.generation.weather, undefined);
    assert.match(plan.reasoning, /weather tool request was disabled safely/i);
});

test('out-of-range lat/lon weather request is disabled safely', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
            reasoning: 'Need weather data.',
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
                weather: {
                    location: {
                        latitude: 123.45,
                        longitude: -86.1581,
                    },
                },
            },
        })
    );

    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.generation.weather, undefined);
    assert.match(plan.reasoning, /weather tool request was disabled safely/i);
});

test('non-positive gridpoint weather request is disabled safely', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
            reasoning: 'Need weather data.',
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
                weather: {
                    location: {
                        office: 'IND',
                        gridX: 0,
                        gridY: 69,
                    },
                },
            },
        })
    );

    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.generation.weather, undefined);
    assert.match(plan.reasoning, /weather tool request was disabled safely/i);
});

test('mixed lat/lon and gridpoint weather location is disabled safely', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
            reasoning: 'Need weather data.',
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
                weather: {
                    location: {
                        latitude: 39.7684,
                        longitude: -86.1581,
                        office: 'IND',
                        gridX: 54,
                        gridY: 69,
                    },
                },
            },
        })
    );

    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.generation.weather, undefined);
    assert.match(plan.reasoning, /weather tool request was disabled safely/i);
});

test('invalid weather request does not suppress valid search normalization', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
            reasoning: 'Need weather and current facts.',
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
                weather: {
                    location: {
                        city: 'Indianapolis',
                    },
                },
                search: {
                    query: 'Indianapolis weather headline',
                    contextSize: 'low',
                    intent: 'current_facts',
                },
            },
        })
    );

    const { plan } = await planner.planChat(createChatRequest());

    assert.equal(plan.generation.weather, undefined);
    assert.equal(
        plan.generation.search?.query,
        'Indianapolis weather headline'
    );
    assert.match(plan.reasoning, /weather tool request was disabled safely/i);
});

test('planner temperament is accepted when all TRACE axes are integer 1..5', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'message',
            modality: 'text',
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
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
            requestedCapabilityProfile: 'balanced-general',
            safetyTier: 'Low',
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
    const { plan, execution } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.generation.search, undefined);
    assert.equal(plan.generation.reasoningEffort, 'low');
    assert.equal(plan.generation.verbosity, 'low');
    assert.equal(plan.generation.temperament, undefined);
    assert.match(plan.reasoning, /missing|invalid|TRACE temperament/i);
    assert.equal(execution.status, 'failed');
    assert.equal(execution.reasonCode, 'planner_invalid_output');
});

test('non-object planner payload falls back safely without runtime errors', async () => {
    const planner = createPlanner(JSON.stringify('not-an-object'));
    const { plan, execution } = await planner.planChat(createChatRequest());

    assert.equal(plan.action, 'message');
    assert.equal(plan.generation.search, undefined);
    assert.equal(execution.status, 'failed');
    assert.equal(execution.reasonCode, 'planner_invalid_output');
});

test('react plans with non-emoji payload fall back safely', async () => {
    const planner = createPlanner(
        JSON.stringify({
            action: 'react',
            modality: 'text',
            safetyTier: 'Low',
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

test('expanded_with_summary digest summarizes dropped older context, not recent window', async () => {
    const digestMessages: string[] = [];
    let callCount = 0;
    const planner = createChatPlanner({
        executePlanner: async ({ messages }) => {
            callCount += 1;
            const digestMessage = messages.find((message) =>
                message.content.startsWith('Conversation digest: ')
            );
            if (digestMessage) {
                digestMessages.push(digestMessage.content);
            }

            if (callCount === 1) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'balanced-general',
                        contextNeed: 'needs_more_context',
                        contextTier: 'expanded_with_summary',
                        safetyTier: 'Low',
                        reasoning: 'Need expanded context with digest.',
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
            }

            return {
                text: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    requestedCapabilityProfile: 'balanced-general',
                    contextNeed: 'sufficient',
                    safetyTier: 'Low',
                    reasoning: 'Expanded context is sufficient.',
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

    await planner.planChat(
        createChatRequest({
            conversation: Array.from({ length: 24 }, (_value, index) => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `message ${index + 1}`,
            })),
        })
    );

    assert.equal(callCount, 2);
    assert.equal(digestMessages.length, 1);
    const digest = digestMessages[0];
    assert.match(digest, /message 1/i);
    assert.doesNotMatch(digest, /message 24/i);
});

test('chatPlanner treats expanded safety and TRACE temperament changes as material', async () => {
    let callCount = 0;
    const planner = createChatPlanner({
        executePlanner: async () => {
            callCount += 1;
            if (callCount === 1) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'balanced-general',
                        contextNeed: 'needs_more_context',
                        contextTier: 'expanded_recent',
                        safetyTier: 'Low',
                        reasoning: 'Need more context.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            temperament: {
                                tightness: 3,
                                rationale: 3,
                                attribution: 3,
                                caution: 3,
                                extent: 3,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    requestedCapabilityProfile: 'balanced-general',
                    contextNeed: 'sufficient',
                    safetyTier: 'Medium',
                    reasoning: 'Expanded plan tightens safety/temperament.',
                    generation: {
                        reasoningEffort: 'low',
                        verbosity: 'low',
                        temperament: {
                            tightness: 4,
                            rationale: 4,
                            attribution: 4,
                            caution: 4,
                            extent: 4,
                        },
                    },
                }),
                model: 'gpt-5-mini',
            };
        },
    });

    const response = await planner.planChat(
        createChatRequest({
            conversation: Array.from({ length: 10 }, (_value, index) => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `message ${index + 1}`,
            })),
        })
    );

    assert.equal(response.execution.selectedAttempt, 'expanded');
    assert.equal(
        response.execution.contextReasonCode,
        'planner_context_expanded'
    );
    assert.equal(response.plan.safetyTier, 'Medium');
    assert.deepEqual(response.plan.generation.temperament, {
        tightness: 4,
        rationale: 4,
        attribution: 4,
        caution: 4,
        extent: 4,
    });
});

test('chatPlanner adopts expanded attempt when initial marks context as insufficient', async () => {
    const seenMessageCounts: number[] = [];
    let callCount = 0;
    const planner = createChatPlanner({
        executePlanner: async ({ messages }) => {
            callCount += 1;
            seenMessageCounts.push(messages.length);
            if (callCount === 1) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'balanced-general',
                        contextNeed: 'needs_more_context',
                        contextTier: 'expanded_recent',
                        safetyTier: 'Low',
                        reasoning: 'Need more context before selecting search.',
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
            }

            return {
                text: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    requestedCapabilityProfile: 'balanced-general',
                    contextNeed: 'sufficient',
                    safetyTier: 'Low',
                    reasoning: 'Expanded context supports retrieval.',
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
                            query: 'latest changes',
                            contextSize: 'low',
                            intent: 'current_facts',
                        },
                    },
                }),
                model: 'gpt-5-mini',
            };
        },
    });

    const response = await planner.planChat(
        createChatRequest({
            conversation: Array.from({ length: 10 }, (_value, index) => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `message ${index + 1}`,
            })),
        })
    );

    assert.equal(response.execution.selectedAttempt, 'expanded');
    assert.equal(response.execution.contextTier, 'expanded_recent');
    assert.equal(
        response.execution.contextReasonCode,
        'planner_context_expanded'
    );
    assert.equal(response.execution.plannerAttemptIndex, 2);
    assert.ok(response.plan.generation.search);
    assert.equal(callCount, 2);
    assert.ok(seenMessageCounts[1] > seenMessageCounts[0]);
});

test('chatPlanner keeps initial plan when expanded attempt is invalid', async () => {
    let callCount = 0;
    const planner = createChatPlanner({
        executePlanner: async () => {
            callCount += 1;
            if (callCount === 1) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        requestedCapabilityProfile: 'balanced-general',
                        contextNeed: 'needs_more_context',
                        contextTier: 'expanded_recent',
                        safetyTier: 'Low',
                        reasoning: 'Need more context.',
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
            }

            return {
                text: '{"action":"message"',
                model: 'gpt-5-mini',
            };
        },
    });

    const response = await planner.planChat(
        createChatRequest({
            conversation: Array.from({ length: 8 }, (_value, index) => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `message ${index + 1}`,
            })),
        })
    );

    assert.equal(response.execution.selectedAttempt, 'initial');
    assert.equal(
        response.execution.contextReasonCode,
        'planner_expansion_invalid_fallback_initial'
    );
    assert.equal(response.execution.plannerAttemptIndex, 2);
    assert.equal(response.plan.generation.search, undefined);
    assert.equal(callCount, 2);
});

test('chatPlanner marks budget exhausted when expansion is requested with no extra context budget', async () => {
    let callCount = 0;
    const planner = createChatPlanner({
        executePlanner: async () => {
            callCount += 1;
            return {
                text: JSON.stringify({
                    action: 'message',
                    modality: 'text',
                    requestedCapabilityProfile: 'balanced-general',
                    contextNeed: 'needs_more_context',
                    contextTier: 'expanded_recent',
                    safetyTier: 'Low',
                    reasoning: 'Need more context.',
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

    const response = await planner.planChat(
        createChatRequest({
            conversation: [{ role: 'user', content: 'single message only' }],
        })
    );

    assert.equal(response.execution.selectedAttempt, 'initial');
    assert.equal(
        response.execution.contextReasonCode,
        'planner_context_budget_exhausted'
    );
    assert.equal(response.execution.plannerAttemptIndex, 1);
    assert.equal(callCount, 1);
});
