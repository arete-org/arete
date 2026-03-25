/**
 * @description: Covers surface policy and planner-to-generation plumbing in the reflect orchestrator.
 * @footnote-scope: test
 * @footnote-module: ReflectOrchestratorTests
 * @footnote-risk: medium - Missing tests here can let web/Discord routing drift again.
 * @footnote-ethics: medium - Surface policy decides whether users receive a reply, reaction, or silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRuntime } from '@footnote/agent-runtime';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type { PostReflectRequest } from '@footnote/contracts/web';
import { createReflectOrchestrator } from '../src/services/reflectOrchestrator.js';
import { renderConversationPromptLayers } from '../src/services/prompts/conversationPromptLayers.js';

const createMetadata = (): ResponseMetadata => ({
    responseId: 'reflect_test_response',
    provenance: 'Inferred',
    riskTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'abc123def456',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
});

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

    const orchestrator = createReflectOrchestrator({
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

    const response = await orchestrator.runReflect(
        createReflectRequest({
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
        renderConversationPromptLayers('reflect-chat').systemPrompt
    );
    assert.equal(
        finalMessages[1]?.content,
        renderConversationPromptLayers('reflect-chat').personaPrompt
    );
    assert.match(
        finalMessages[finalMessages.length - 1]?.content ?? '',
        /coercedFrom/
    );
});

test('discord requests preserve non-message planner actions', async () => {
    let callCount = 0;

    const orchestrator = createReflectOrchestrator({
        generationRuntime: createGenerationRuntime(async ({ maxOutputTokens }) => {
            callCount += 1;
            if (maxOutputTokens === 700) {
                return {
                    text: JSON.stringify({
                        action: 'image',
                        modality: 'text',
                        imageRequest: {
                            prompt: 'draw a reflective skyline',
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

    const response = await orchestrator.runReflect(createReflectRequest());

    assert.equal(callCount, 1);
    assert.equal(response.action, 'image');
    assert.equal(response.imageRequest.prompt, 'draw a reflective skyline');
});

test('message plans pass planner generation options into reflectService', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];

    const orchestrator = createReflectOrchestrator({
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

    const response = await orchestrator.runReflect(createReflectRequest());

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

test('discord overlay replaces default persona layer in reflect generation', async () => {
    let finalMessages: Array<{ role: string; content: string }> = [];

    const orchestrator = createReflectOrchestrator({
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

    const response = await orchestrator.runReflect(
        createReflectRequest({
            conversation: [
                {
                    role: 'system',
                    content:
                        '// BEGIN Bot Profile Overlay\nYou are Myuri.\n// END Bot Profile Overlay',
                },
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
    assert.equal(
        finalMessages.some(
            (message) =>
                message.content ===
                renderConversationPromptLayers('discord-chat').personaPrompt
        ),
        false
    );
});
