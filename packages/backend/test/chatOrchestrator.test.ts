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
        generationRuntime: createGenerationRuntime(async ({ messages, maxOutputTokens }) => {
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
        }),
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
        generationRuntime: createGenerationRuntime(async ({ maxOutputTokens }) => {
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
                        reasoning: 'The user explicitly asked for an image.',
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
        }),
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

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === 700) {
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
            generationRuntime: createGenerationRuntime(async ({ messages, maxOutputTokens }) => {
                if (maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            riskTier: 'Low',
                            reasoning: 'A normal text response is appropriate.',
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
            }),
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
        assert.match(finalMessages[1]?.content ?? '', /BEGIN Bot Profile Overlay/);
        assert.match(finalMessages[1]?.content ?? '', /Profile ID: ari-vendor/);
    } finally {
        runtimeConfigMutable.profile = originalProfile;
    }
});

test('discord profileId mismatch warns and falls back to backend runtime profile overlay', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];
    const warnings: string[] = [];
    const originalWarn = logger.warn;
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
    logger.warn = ((message: string) => {
        warnings.push(message);
        return logger;
    }) as typeof logger.warn;

    try {
        const orchestrator = createChatOrchestrator({
            generationRuntime: createGenerationRuntime(async ({ messages, maxOutputTokens }) => {
                if (maxOutputTokens === 700) {
                    return {
                        text: JSON.stringify({
                            action: 'message',
                            modality: 'text',
                            riskTier: 'Low',
                            reasoning: 'A normal text response is appropriate.',
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
            }),
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

        assert.equal(warnings.length, 1);
        assert.match(warnings[0] ?? '', /does not match backend runtime profile/i);
        assert.match(finalMessages[1]?.content ?? '', /Profile ID: ari-vendor/);
    } finally {
        logger.warn = originalWarn;
        runtimeConfigMutable.profile = originalProfile;
    }
});

test('discord requests are trimmed/formatted in backend before planner and generation', async () => {
    let plannerConversation: Array<{ role: string; content: string }> = [];
    let generationConversation: Array<{ role: string; content: string }> = [];

    const conversation = Array.from({ length: 30 }, (_, index) => ({
        role: (index % 2 === 0 ? 'user' : 'assistant') as
            | 'user'
            | 'assistant',
        content: `raw message ${index + 1}`,
        authorName: index % 2 === 0 ? 'Jordan' : 'Footnote',
        authorId: index % 2 === 0 ? 'user-1' : 'bot-1',
        messageId: `msg-${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 2, 25, 12, index, 0)).toISOString(),
    }));

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async ({ messages, maxOutputTokens }) => {
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
        }),
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
        plannerConversation.filter((message) => message.role !== 'system').length,
        24
    );
    assert.match(
        plannerConversation.find((message) => message.role !== 'system')?.content ??
            '',
        /^\[0\] At \d{4}-\d{2}-\d{2} \d{2}:\d{2} Jordan said:/
    );
    assert.match(
        generationConversation.find((message) => message.role === 'assistant')
            ?.content ?? '',
        /\(bot\) said:/
    );
});
