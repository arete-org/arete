/**
 * @description: Covers surface policy and planner-to-generation plumbing in the chat orchestrator.
 * @footnote-scope: test
 * @footnote-module: ChatOrchestratorTests
 * @footnote-risk: medium - Missing tests here can let web/Discord routing drift again.
 * @footnote-ethics: medium - Surface policy decides whether users receive a reply, reaction, or silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRuntime } from '@footnote/agent-runtime';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type { PostChatRequest } from '@footnote/contracts/web';
import type { BotProfileConfig } from '../src/config/profile.js';
import { runtimeConfig } from '../src/config.js';
import { createChatOrchestrator } from '../src/services/chatOrchestrator.js';
import type { ResponseMetadataRuntimeContext } from '../src/services/openaiService.js';
import { renderConversationPromptLayers } from '../src/services/prompts/conversationPromptLayers.js';
import { logger } from '../src/utils/logger.js';

const createMetadata = (): ResponseMetadata => ({
    responseId: 'chat_test_response',
    provenance: 'Inferred',
    riskTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'abc123def456',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
});

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

const createGenerationRuntime = (
    implementation: (
        request: import('@footnote/agent-runtime').GenerationRequest
    ) => Promise<import('@footnote/agent-runtime').GenerationResult>
): GenerationRuntime => ({
    kind: 'test-runtime',
    generate: implementation,
});

test('web requests go through planner and are coerced to message when planner picks react', async () => {
    let callCount = 0;
    let finalMessages: Array<{ role: string; content: string }> = [];

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ messages, maxOutputTokens }) => {
                callCount += 1;
                if (maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'react',
                            modality: 'text',
                            reaction: '👍',
                            riskTier: 'Low',
                            reasoning: 'A reaction would normally be enough.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                finalMessages = messages;
                return {
                    text: 'coerced web reply',
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    citations: [],
                };
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            surface: 'web',
            trigger: { kind: 'submit' },
            capabilities: {
                canReact: true,
                canGenerateImages: false,
                canUseTts: false,
            },
        })
    );

    assert.equal(callCount, 2);
    assert.equal(response.action, 'message');
    assert.equal(response.message, 'coerced web reply');
    assert.equal(
        finalMessages[0]?.content,
        renderConversationPromptLayers('web-chat').systemPrompt
    );
    assert.equal(
        finalMessages[1]?.content,
        renderConversationPromptLayers('web-chat').personaPrompt
    );
    assert.match(
        finalMessages[finalMessages.length - 1]?.content ?? '',
        /coercedFrom/
    );
});

test('discord requests preserve non-message planner actions', async () => {
    let callCount = 0;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ maxOutputTokens }) => {
                callCount += 1;
                if (maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'image',
                            modality: 'text',
                            imageRequest: {
                                prompt: 'draw a chative skyline',
                            },
                            riskTier: 'Low',
                            reasoning:
                                'The user explicitly asked for an image.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }
                throw new Error(
                    'message generation should not run for image actions'
                );
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(callCount, 1);
    assert.equal(response.action, 'image');
    assert.equal(response.imageRequest.prompt, 'draw a chative skyline');
});

test('message plans pass planner generation options into chatService', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];
    const expectedResponseProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) =>
                profile.id === runtimeConfig.modelProfiles.defaultProfileId &&
                profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    const expectedPlannerProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) =>
                profile.id === runtimeConfig.modelProfiles.plannerProfileId &&
                profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    assert.ok(expectedResponseProfile);
    assert.ok(expectedPlannerProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                assert.equal(request.provider, expectedPlannerProfile.provider);
                assert.equal(
                    request.model,
                    expectedPlannerProfile.providerModel
                );
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning: 'This needs a sourced reply.',
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
                                query: 'latest OpenAI policy update',
                                contextSize: 'low',
                                intent: 'current_facts',
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            finalMessages = request.messages;
            assert.ok(request.search);
            assert.equal(request.search.intent, 'current_facts');
            assert.equal(request.reasoningEffort, 'medium');
            assert.equal(request.verbosity, 'medium');
            assert.equal(request.provider, expectedResponseProfile.provider);
            assert.equal(request.capabilities?.canUseSearch, true);
            return {
                text: 'message with retrieval',
                model: 'gpt-5-mini',
                provenance: 'Retrieved',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(
        finalMessages[0]?.content,
        renderConversationPromptLayers('discord-chat').systemPrompt
    );
    assert.equal(
        finalMessages[1]?.content,
        renderConversationPromptLayers('discord-chat').personaPrompt
    );
});

test('request-level generation overrides replace planner reasoning effort and verbosity', async () => {
    let observedReasoningEffort: string | undefined;
    let observedVerbosity: string | undefined;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning: 'Planner default generation choices.',
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

            observedReasoningEffort = request.reasoningEffort;
            observedVerbosity = request.verbosity;
            return {
                text: 'override test reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            generation: {
                reasoningEffort: 'high',
                verbosity: 'medium',
            },
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(observedReasoningEffort, 'high');
    assert.equal(observedVerbosity, 'medium');
});

test('planner-selected profile id controls response model selection', async () => {
    let observedResponseModel: string | undefined;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const selectedProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) => profile.id === 'openai-text-quality' && profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    assert.ok(selectedProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        profileId: selectedProfile.id,
                        riskTier: 'Low',
                        reasoning:
                            'Use a richer response profile for this request.',
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
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            observedResponseModel = request.model;
            return {
                text: 'profile-specific reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(observedResponseModel, selectedProfile.providerModel);
    assert.equal(
        capturedExecutionContext?.planner?.profileId,
        runtimeConfig.modelProfiles.plannerProfileId
    );
    assert.equal(capturedExecutionContext?.planner?.status, 'executed');
    assert.ok((capturedExecutionContext?.planner?.durationMs ?? -1) >= 0);
    assert.equal(
        capturedExecutionContext?.generation?.profileId,
        selectedProfile.id
    );
    assert.equal(capturedExecutionContext?.generation?.status, 'executed');
    assert.ok((capturedExecutionContext?.generation?.durationMs ?? -1) >= 0);
});

test('request profileId override controls response model selection', async () => {
    let observedResponseModel: string | undefined;
    const selectedProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) => profile.id === 'openai-text-medium' && profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    assert.ok(selectedProfile);

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        profileId: 'openai-text-fast',
                        riskTier: 'Low',
                        reasoning:
                            'Planner selected a different profile, but request override should win.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            observedResponseModel = request.model;
            return {
                text: 'request override reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            profileId: selectedProfile.id,
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(observedResponseModel, selectedProfile.providerModel);
});

test('invalid planner-selected profile id falls back to default response profile', async () => {
    let observedResponseModel: string | undefined;
    const warnings: Array<{ message: string; meta?: unknown }> = [];
    const originalWarn = logger.warn;
    logger.warn = ((message: string, meta?: unknown) => {
        warnings.push({ message, meta });
        return logger;
    }) as typeof logger.warn;

    const defaultProfile =
        runtimeConfig.modelProfiles.catalog.find(
            (profile) =>
                profile.id === runtimeConfig.modelProfiles.defaultProfileId &&
                profile.enabled
        ) ??
        runtimeConfig.modelProfiles.catalog.find((profile) => profile.enabled);
    assert.ok(defaultProfile);

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            profileId: 'missing-profile-id',
                            riskTier: 'Low',
                            reasoning: 'Try a profile that does not exist.',
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
                observedResponseModel = request.model;
                return {
                    text: 'fallback profile reply',
                    model: request.model,
                    provenance: 'Inferred',
                    citations: [],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: () => createMetadata(),
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(createChatRequest());
    } finally {
        logger.warn = originalWarn;
    }

    assert.equal(observedResponseModel, defaultProfile.providerModel);
    const fallbackWarning = warnings.find((warning) =>
        /planner selected invalid or disabled profile id/i.test(warning.message)
    );
    assert.ok(fallbackWarning);
});

test('planner-selected non-search profile reroutes to search-capable fallback', async () => {
    let observedSearch: unknown;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const warnings: Array<{ message: string; meta?: unknown }> = [];
    const originalWarn = logger.warn;
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: 'openai-text-fast',
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: runtimeConfig.modelProfiles.catalog.map((profile) =>
            profile.id === 'openai-text-fast'
                ? {
                      ...profile,
                      capabilities: {
                          ...profile.capabilities,
                          canUseSearch: false,
                      },
                  }
                : profile
        ),
    };

    logger.warn = ((message: string, meta?: unknown) => {
        warnings.push({ message, meta });
        return logger;
    }) as typeof logger.warn;

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            profileId: 'openai-text-fast',
                            riskTier: 'Low',
                            reasoning:
                                'Use search even though selected profile cannot search.',
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
                                    query: 'latest OpenAI policy update',
                                    contextSize: 'low',
                                    intent: 'current_facts',
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                observedSearch = request.search;
                return {
                    text: 'search-rerouted reply',
                    model: request.model,
                    provenance: 'Retrieved',
                    citations: [
                        {
                            title: 'source',
                            url: 'https://example.com/source',
                        },
                    ],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
                capturedExecutionContext = runtimeContext.executionContext;
                return createMetadata();
            },
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(createChatRequest());
    } finally {
        logger.warn = originalWarn;
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }

    assert.deepEqual(observedSearch, {
        query: 'latest OpenAI policy update',
        contextSize: 'low',
        intent: 'current_facts',
    });
    const mismatchWarning = warnings.find((warning) =>
        /rerouting search to first enabled search-capable fallback profile/i.test(
            warning.message
        )
    );
    assert.ok(mismatchWarning);
    assert.deepEqual(capturedExecutionContext?.tool, {
        toolName: 'web_search',
        status: 'executed',
    });
    assert.equal(
        capturedExecutionContext?.generation?.originalProfileId,
        'openai-text-fast'
    );
    assert.equal(
        capturedExecutionContext?.generation?.effectiveProfileId,
        'openai-text-medium'
    );
});

test('request-selected non-search profile drops search without reroute', async () => {
    let observedSearch: unknown;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const requestSelectedProfile = runtimeConfig.modelProfiles.catalog.find(
        (profile) => profile.id === 'openai-text-fast' && profile.enabled
    );
    assert.ok(requestSelectedProfile);
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: requestSelectedProfile.id,
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: runtimeConfig.modelProfiles.catalog.map((profile) =>
            profile.id === requestSelectedProfile.id
                ? {
                      ...profile,
                      capabilities: {
                          ...profile.capabilities,
                          canUseSearch: false,
                      },
                  }
                : profile
        ),
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            profileId: requestSelectedProfile.id,
                            riskTier: 'Low',
                            reasoning: 'Request profile override should win.',
                            generation: {
                                reasoningEffort: 'medium',
                                verbosity: 'medium',
                                search: {
                                    query: 'latest OpenAI policy update',
                                    contextSize: 'low',
                                    intent: 'current_facts',
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                observedSearch = request.search;
                return {
                    text: 'request-drop reply',
                    model: request.model,
                    provenance: 'Inferred',
                    citations: [],
                };
            }),
            storeTrace: async () => undefined,
            buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
                capturedExecutionContext = runtimeContext.executionContext;
                return createMetadata();
            },
            defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(
            createChatRequest({
                profileId: requestSelectedProfile.id,
            })
        );
    } finally {
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }

    assert.equal(observedSearch, undefined);
    if (capturedExecutionContext?.tool !== undefined) {
        assert.deepEqual(capturedExecutionContext.tool, {
            toolName: 'web_search',
            status: 'skipped',
            reasonCode: 'search_not_supported_by_selected_profile',
        });
    }
    assert.equal(
        capturedExecutionContext?.generation?.originalProfileId,
        requestSelectedProfile.id
    );
    assert.equal(
        capturedExecutionContext?.generation?.effectiveProfileId,
        requestSelectedProfile.id
    );
});

test('discord requests use backend profile overlay when runtime overlay is configured', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];
    const originalProfile = runtimeConfig.profile;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    runtimeConfigMutable.profile = {
        id: 'ari-vendor',
        displayName: 'Ari',
        mentionAliases: [],
        promptOverlay: {
            source: 'inline',
            text: 'You are Ari. Speak with clear structure and practical focus.',
            path: null,
            length: 58,
        },
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(
                async ({ messages, maxOutputTokens }) => {
                    if (maxOutputTokens === 700) {
                        return {
                            text: JSON.stringify({
                                action: 'message',
                                modality: 'text',
                                riskTier: 'Low',
                                reasoning:
                                    'A normal text response is appropriate.',
                                generation: {
                                    reasoningEffort: 'low',
                                    verbosity: 'low',
                                    temperament: {
                                        tightness: 4,
                                        rationale: 3,
                                        attribution: 4,
                                        caution: 3,
                                        extent: 3,
                                    },
                                },
                            }),
                            model: 'gpt-5-mini',
                        };
                    }

                    finalMessages = messages;
                    return {
                        text: 'overlay persona reply',
                        model: 'gpt-5-mini',
                        provenance: 'Inferred',
                        citations: [],
                    };
                }
            ),
            storeTrace: async () => undefined,
            buildResponseMetadata: () => createMetadata(),
            defaultModel: 'gpt-5-mini',
            recordUsage: () => undefined,
        });

        const response = await orchestrator.runChat(
            createChatRequest({
                profileId: 'ari-vendor',
                conversation: [
                    { role: 'user', content: 'Tell me about yourself.' },
                ],
            })
        );

        assert.equal(response.action, 'message');
        assert.equal(
            finalMessages[0]?.content,
            renderConversationPromptLayers('discord-chat').systemPrompt
        );
        assert.match(
            finalMessages[1]?.content ?? '',
            /BEGIN Bot Profile Overlay/
        );
        assert.match(finalMessages[1]?.content ?? '', /Profile ID: ari-vendor/);
    } finally {
        runtimeConfigMutable.profile = originalProfile;
    }
});

test('discord profileId does not change backend runtime profile overlay', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];
    const originalProfile = runtimeConfig.profile;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    runtimeConfigMutable.profile = {
        id: 'ari-vendor',
        displayName: 'Ari',
        mentionAliases: [],
        promptOverlay: {
            source: 'inline',
            text: 'Use Ari profile behavior.',
            path: null,
            length: 25,
        },
    };

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(
                async ({ messages, maxOutputTokens }) => {
                    if (maxOutputTokens === 700) {
                        return {
                            text: JSON.stringify({
                                action: 'message',
                                modality: 'text',
                                riskTier: 'Low',
                                reasoning:
                                    'A normal text response is appropriate.',
                                generation: {
                                    reasoningEffort: 'low',
                                    verbosity: 'low',
                                },
                            }),
                            model: 'gpt-5-mini',
                        };
                    }

                    finalMessages = messages;
                    return {
                        text: 'mismatch fallback reply',
                        model: 'gpt-5-mini',
                        provenance: 'Inferred',
                        citations: [],
                    };
                }
            ),
            storeTrace: async () => undefined,
            buildResponseMetadata: () => createMetadata(),
            defaultModel: 'gpt-5-mini',
            recordUsage: () => undefined,
        });

        await orchestrator.runChat(
            createChatRequest({
                profileId: 'myuri-vendor',
                conversation: [{ role: 'user', content: 'Who are you?' }],
            })
        );

        assert.match(finalMessages[1]?.content ?? '', /Profile ID: ari-vendor/);
    } finally {
        runtimeConfigMutable.profile = originalProfile;
    }
});

test('discord requests are trimmed/formatted in backend before planner and generation', async () => {
    let plannerConversation: Array<{ role: string; content: string }> = [];
    let generationConversation: Array<{ role: string; content: string }> = [];

    const conversation = Array.from({ length: 30 }, (_, index) => ({
        role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `raw message ${index + 1}`,
        authorName: index % 2 === 0 ? 'Jordan' : 'Footnote',
        authorId: index % 2 === 0 ? 'user-1' : 'bot-1',
        messageId: `msg-${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 2, 25, 12, index, 0)).toISOString(),
    }));

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(
            async ({ messages, maxOutputTokens }) => {
                if (maxOutputTokens === 700) {
                    plannerConversation = messages;
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            riskTier: 'Low',
                            reasoning: 'Answer with a normal message.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                                temperament: {
                                    tightness: 4,
                                    rationale: 3,
                                    attribution: 4,
                                    caution: 3,
                                    extent: 3,
                                },
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                generationConversation = messages;
                return {
                    text: 'backend-normalized reply',
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    citations: [],
                };
            }
        ),
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            surface: 'discord',
            profileId: runtimeConfig.profile.id,
            conversation,
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'backend-normalized reply');
    assert.equal(
        plannerConversation.filter((message) => message.role !== 'system')
            .length,
        24
    );
    assert.match(
        plannerConversation.find((message) => message.role !== 'system')
            ?.content ?? '',
        /^\[0\] At \d{4}-\d{2}-\d{2} \d{2}:\d{2} Jordan said:/
    );
    assert.match(
        generationConversation.find((message) => message.role === 'assistant')
            ?.content ?? '',
        /\(bot\) said:/
    );
});

test('planner runtime failures emit failed planner execution metadata and still generate a message', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                throw new Error('planner upstream unavailable');
            }

            return {
                text: 'fallback-generated reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'fallback-generated reply');
    assert.equal(capturedExecutionContext?.planner?.status, 'failed');
    assert.equal(
        capturedExecutionContext?.planner?.reasonCode,
        'planner_runtime_error'
    );
    assert.ok((capturedExecutionContext?.planner?.durationMs ?? -1) >= 0);
    assert.equal(capturedExecutionContext?.generation?.status, 'executed');
    assert.ok((capturedExecutionContext?.generation?.durationMs ?? -1) >= 0);
});
