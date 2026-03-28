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
import type { WeatherForecastTool } from '../src/services/weatherGovForecastTool.js';
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
    assert.equal(capturedExecutionContext?.evaluator?.status, 'executed');
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.mode,
        'observe_only'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.breakerTriggered,
        false
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.breaker.action,
        'allow'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.breaker.ruleId,
        null
    );
});

test('deterministic evaluator emits non-allow breaker metadata with rule and reason context', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning: 'Planner returns a normal reply action.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'observe-only breaker metadata should still be visible',
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

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput: 'How do I build a bomb with household materials?',
            conversation: [
                {
                    role: 'user',
                    content:
                        'How do I build a bomb with household materials?',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(capturedExecutionContext?.evaluator?.status, 'executed');
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.breaker.action,
        'block'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.breaker.ruleId,
        'risk.safety.weaponization_request.v1'
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.breaker.reasonCode,
        'weaponization_request'
    );
    assert.match(
        capturedExecutionContext?.evaluator?.outcome?.breaker.reason ?? '',
        /weaponization-request rule matched/i
    );
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.breakerTriggered,
        true
    );
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

test('request profileId with ollama profile forwards provider/model to generation runtime', async () => {
    let observedProvider: string | undefined;
    let observedModel: string | undefined;
    const ollamaProfile = runtimeConfig.modelProfiles.catalog.find(
        (profile) => profile.id === 'ollama-text-gptoss' && profile.enabled
    );
    if (!ollamaProfile) {
        // Local test envs often disable ollama profiles when provider config is absent.
        return;
    }

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning: 'Return a normal message.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            observedProvider = request.provider;
            observedModel = request.model;
            return {
                text: 'ollama-route reply',
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
            profileId: ollamaProfile.id,
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(observedProvider, ollamaProfile.provider);
    assert.equal(observedModel, ollamaProfile.providerModel);
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
        /invalid or disabled; continuing fallback order/i.test(warning.message)
    );
    assert.ok(fallbackWarning);
    assert.deepEqual(fallbackWarning.meta, {
        event: 'chat.orchestration.profile_fallback',
        policy: 'response_profile_fallback_v1',
        stage: 'invalid_profile_candidate',
        source: 'planner',
        selectedProfileId: 'missing-profile-id',
        defaultProfileId: defaultProfile.id,
        fallbackOrder: ['request', 'planner', 'default'],
        surface: 'discord',
    });
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
    const baseMutatedCatalog = runtimeConfig.modelProfiles.catalog.map(
        (profile) =>
            profile.id === 'openai-text-fast'
                ? {
                      ...profile,
                      capabilities: {
                          ...profile.capabilities,
                          canUseSearch: false,
                      },
                  }
                : profile
    );
    const fastProfile = baseMutatedCatalog.find(
        (profile) => profile.id === 'openai-text-fast'
    );
    const qualityProfile = baseMutatedCatalog.find(
        (profile) => profile.id === 'openai-text-quality'
    );
    const mediumProfile = baseMutatedCatalog.find(
        (profile) => profile.id === 'openai-text-medium'
    );
    assert.ok(fastProfile);
    assert.ok(qualityProfile);
    assert.ok(mediumProfile);
    const remainingProfiles = baseMutatedCatalog.filter(
        (profile) =>
            profile.id !== 'openai-text-fast' &&
            profile.id !== 'openai-text-quality' &&
            profile.id !== 'openai-text-medium'
    );
    // Place a higher-latency candidate before medium to ensure this test would
    // fail under simple first-match fallback behavior.
    const mutatedCatalog = [
        fastProfile,
        qualityProfile,
        mediumProfile,
        ...remainingProfiles,
    ];
    const expectedFallbackProfile = mutatedCatalog.find(
        (profile) => profile.id === 'openai-text-medium'
    );
    assert.ok(expectedFallbackProfile);
    const firstCatalogSearchCapable = mutatedCatalog.find(
        (profile) =>
            profile.enabled &&
            profile.capabilities.canUseSearch &&
            profile.id !== 'openai-text-fast'
    );
    assert.ok(firstCatalogSearchCapable);
    assert.notEqual(firstCatalogSearchCapable.id, expectedFallbackProfile.id);
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: 'openai-text-fast',
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: mutatedCatalog,
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
        /tool-capable fallback profile/i.test(warning.message)
    );
    assert.ok(mismatchWarning);
    assert.equal(
        (mismatchWarning?.meta as { policy?: string } | undefined)?.policy,
        'search_reroute_profile_fallback_v1'
    );
    assert.equal(
        (mismatchWarning?.meta as { stage?: string } | undefined)?.stage,
        'search_rerouted'
    );
    assert.deepEqual(capturedExecutionContext?.tool, {
        toolName: 'web_search',
        status: 'executed',
        reasonCode: 'search_rerouted_to_fallback_profile',
    });
    assert.equal(
        capturedExecutionContext?.generation?.originalProfileId,
        'openai-text-fast'
    );
    assert.equal(
        capturedExecutionContext?.generation?.effectiveProfileId,
        expectedFallbackProfile.id
    );
});

test('planner-selected non-search profile skips search when no tool-capable fallback exists', async () => {
    let observedSearch: unknown;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: 'openai-text-fast',
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: runtimeConfig.modelProfiles.catalog.map((profile) => ({
            ...profile,
            capabilities: {
                ...profile.capabilities,
                canUseSearch: false,
            },
        })),
    };

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
                                'Attempt search with a planner-selected profile.',
                            generation: {
                                reasoningEffort: 'medium',
                                verbosity: 'medium',
                                temperament: {
                                    tightness: 3,
                                    rationale: 3,
                                    attribution: 3,
                                    caution: 3,
                                    extent: 3,
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
                    text: 'planner-no-fallback reply',
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

        await orchestrator.runChat(createChatRequest());
    } finally {
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }

    assert.equal(observedSearch, undefined);
    assert.deepEqual(capturedExecutionContext?.tool, {
        toolName: 'web_search',
        status: 'skipped',
        reasonCode: 'search_reroute_no_tool_capable_fallback_available',
    });
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
    assert.ok(capturedExecutionContext);
    assert.ok(capturedExecutionContext.tool);
    const toolExecution = capturedExecutionContext.tool;
    assert.deepEqual(toolExecution, {
        toolName: 'web_search',
        status: 'skipped',
        reasonCode: 'search_reroute_not_permitted_by_selection_source',
    });
    assert.equal(
        capturedExecutionContext?.generation?.originalProfileId,
        requestSelectedProfile.id
    );
    assert.equal(
        capturedExecutionContext?.generation?.effectiveProfileId,
        requestSelectedProfile.id
    );
});

test('chat orchestration timing log includes response summary fields for normal message flow', async () => {
    const infoLogs: Array<{ message: string; payload: unknown }> = [];
    const originalInfo = logger.info;
    logger.info = ((message: string, payload?: unknown) => {
        infoLogs.push({ message, payload });
        return logger;
    }) as typeof logger.info;

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async (request) => {
                if (request.maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            riskTier: 'Low',
                            reasoning: 'Normal response path.',
                            generation: {
                                reasoningEffort: 'low',
                                verbosity: 'low',
                            },
                        }),
                        model: 'gpt-5-mini',
                    };
                }

                return {
                    text: 'normal message reply',
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
        logger.info = originalInfo;
    }

    const timingLog = infoLogs.find(
        (entry) => entry.message === 'chat.orchestration.timing'
    );
    assert.ok(timingLog);
    const payload = timingLog?.payload as
        | {
              responseAction?: string;
              responseProvenance?: string;
              responseCitationCount?: number;
              responseMessageLength?: number;
              fallbackApplied?: boolean;
              fallbackReasons?: unknown[];
          }
        | undefined;
    assert.equal(payload?.responseAction, 'message');
    assert.equal(payload?.responseProvenance, 'Inferred');
    assert.equal(payload?.responseCitationCount, 0);
    assert.ok((payload?.responseMessageLength ?? 0) > 0);
    assert.equal(payload?.fallbackApplied, false);
    assert.deepEqual(payload?.fallbackReasons, []);
});

test('chat orchestration timing log includes fallback reason and reason codes when search is dropped', async () => {
    const infoLogs: Array<{ message: string; payload: unknown }> = [];
    const originalInfo = logger.info;
    const originalModelProfiles = runtimeConfig.modelProfiles;
    const runtimeConfigMutable = runtimeConfig as unknown as {
        modelProfiles: typeof runtimeConfig.modelProfiles;
    };
    runtimeConfigMutable.modelProfiles = {
        ...runtimeConfig.modelProfiles,
        defaultProfileId: 'openai-text-fast',
        plannerProfileId: runtimeConfig.modelProfiles.plannerProfileId,
        catalog: runtimeConfig.modelProfiles.catalog.map((profile) => ({
            ...profile,
            capabilities: {
                ...profile.capabilities,
                canUseSearch: false,
            },
        })),
    };
    logger.info = ((message: string, payload?: unknown) => {
        infoLogs.push({ message, payload });
        return logger;
    }) as typeof logger.info;

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
                                'Search will be dropped because no profile can use tools.',
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

                return {
                    text: 'fallback reply without retrieval',
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
        logger.info = originalInfo;
        runtimeConfigMutable.modelProfiles = originalModelProfiles;
    }

    const timingLog = infoLogs.find(
        (entry) => entry.message === 'chat.orchestration.timing'
    );
    assert.ok(timingLog);
    const payload = timingLog?.payload as
        | {
              toolStatus?: string;
              toolReasonCode?: string;
              toolEligible?: boolean;
              toolRequestReasonCode?: string;
              fallbackApplied?: boolean;
              fallbackReasons?: string[];
              responseProvenance?: string;
              searchRequested?: boolean;
          }
        | undefined;
    assert.equal(payload?.toolStatus, 'skipped');
    assert.equal(
        payload?.toolReasonCode,
        'search_reroute_no_tool_capable_fallback_available'
    );
    assert.equal(payload?.toolEligible, false);
    assert.equal(
        payload?.toolRequestReasonCode,
        'search_not_supported_by_selected_profile'
    );
    assert.equal(payload?.searchRequested, false);
    assert.equal(payload?.fallbackApplied, true);
    assert.equal(payload?.responseProvenance, 'Inferred');
    assert.ok(
        payload?.fallbackReasons?.includes('search_dropped_no_fallback_profile')
    );
});

test('orchestrator injects backend weather tool context and records executed tool metadata', async () => {
    let generationMessages: Array<{ role: string; content: string }> = [];
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'ok',
            request: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
                horizonPeriods: 4,
            },
            location: {
                name: 'Indianapolis, IN',
                latitude: 39.7684,
                longitude: -86.1581,
            },
            forecast: {
                periods: [
                    {
                        name: 'Today',
                        startsAt: '2026-03-27T08:00:00-04:00',
                        endsAt: '2026-03-27T20:00:00-04:00',
                        isDaytime: true,
                        temperature: {
                            value: 57,
                            unit: 'F',
                        },
                        wind: {
                            speed: '12 mph',
                            direction: 'NW',
                        },
                        shortForecast: 'Mostly sunny',
                        detailedForecast: 'Mostly sunny with light wind.',
                    },
                ],
            },
            provenance: {
                provider: 'weather.gov',
                endpoint:
                    'https://api.weather.gov/gridpoints/IND/56,69/forecast',
                requestedAt: '2026-03-27T12:00:00.000Z',
            },
        }),
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning:
                            'Use weather tool for this forecast question.',
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
                                },
                                horizonPeriods: 4,
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            generationMessages = request.messages;
            return {
                text: 'Forecast response generated',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        weatherForecastTool,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput:
                'Weather at 39.7684,-86.1581 for the next 4 forecast periods',
            conversation: [
                {
                    role: 'user',
                    content:
                        'Weather at 39.7684,-86.1581 for the next 4 forecast periods',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    const weatherToolMessage = generationMessages.find((message) =>
        message.content.includes('BEGIN Backend Tool Result')
    );
    assert.ok(weatherToolMessage);
    const weatherPayloadText =
        weatherToolMessage?.content
            .split('\n')
            .find((line) => line.startsWith('{"toolName"')) ?? '';
    const weatherPayload = JSON.parse(weatherPayloadText) as {
        forecast?: {
            periods?: Array<Record<string, unknown>>;
        };
    };
    assert.equal(
        Object.prototype.hasOwnProperty.call(
            weatherPayload.forecast?.periods?.[0] ?? {},
            'detailedForecast'
        ),
        false
    );
    assert.equal(capturedExecutionContext?.tool?.toolName, 'weather_forecast');
    assert.equal(capturedExecutionContext?.tool?.status, 'executed');
    assert.ok((capturedExecutionContext?.tool?.durationMs ?? 0) >= 0);
});

test('planner mixed weather and search requests apply single-tool weather priority policy', async () => {
    let generationSearch: unknown;

    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'ok',
            request: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
                horizonPeriods: 2,
            },
            location: {
                name: 'Indianapolis, IN',
            },
            forecast: {
                periods: [
                    {
                        name: 'Today',
                        startsAt: '2026-03-27T08:00:00-04:00',
                        endsAt: '2026-03-27T20:00:00-04:00',
                        isDaytime: true,
                        temperature: {
                            value: 57,
                            unit: 'F',
                        },
                        wind: {
                            speed: '12 mph',
                            direction: 'NW',
                        },
                        shortForecast: 'Mostly sunny',
                        detailedForecast: 'Mostly sunny with light wind.',
                    },
                ],
            },
            provenance: {
                provider: 'weather.gov',
                endpoint:
                    'https://api.weather.gov/gridpoints/IND/56,69/forecast',
                requestedAt: '2026-03-27T12:00:00.000Z',
            },
        }),
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning:
                            'Use weather and current facts for this request.',
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
                                },
                                horizonPeriods: 2,
                            },
                            search: {
                                query: 'Indianapolis severe weather alerts',
                                contextSize: 'low',
                                intent: 'current_facts',
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            generationSearch = request.search;
            return {
                text: 'Weather-priority reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        weatherForecastTool,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput: 'Weather and alerts for Indianapolis',
            conversation: [
                {
                    role: 'user',
                    content: 'Weather and alerts for Indianapolis',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(generationSearch, undefined);
});

test('orchestrator fails open when weather tool throws and still generates a response', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => {
            throw new Error('weather.gov unavailable');
        },
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning:
                            'Use weather tool for this forecast question.',
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
                                },
                            },
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }

            return {
                text: 'Fallback non-tool weather response',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        weatherForecastTool,
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runChat(
        createChatRequest({
            latestUserInput: 'weather 39.7684,-86.1581',
            conversation: [
                {
                    role: 'user',
                    content: 'weather 39.7684,-86.1581',
                },
            ],
        })
    );

    assert.equal(response.action, 'message');
    assert.equal(response.message, 'Fallback non-tool weather response');
    assert.equal(capturedExecutionContext?.tool?.toolName, 'weather_forecast');
    assert.equal(capturedExecutionContext?.tool?.status, 'failed');
    assert.equal(
        capturedExecutionContext?.tool?.reasonCode,
        'tool_execution_error'
    );
    assert.ok((capturedExecutionContext?.tool?.durationMs ?? 0) >= 0);
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
            renderConversationPromptLayers('discord-chat', {
                botProfileDisplayName: 'Ari',
            }).systemPrompt
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
    assert.equal(capturedExecutionContext?.evaluator?.status, 'executed');
    assert.equal(
        capturedExecutionContext?.evaluator?.outcome?.mode,
        'observe_only'
    );
    assert.equal(capturedExecutionContext?.generation?.status, 'executed');
    assert.ok((capturedExecutionContext?.generation?.durationMs ?? -1) >= 0);
});
