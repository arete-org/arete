/**
 * @description: Covers surface policy and planner-to-generation plumbing in the reflect orchestrator.
 * @footnote-scope: test
 * @footnote-module: ReflectOrchestratorTests
 * @footnote-risk: medium - Missing tests here can let web/Discord routing drift again.
 * @footnote-ethics: medium - Surface policy decides whether users receive a reply, reaction, or silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type { PostReflectRequest } from '@footnote/contracts/web';
import { createReflectOrchestrator } from '../src/services/reflectOrchestrator.js';
import { renderPrompt } from '../src/services/prompts/promptRegistry.js';
import type {
    GenerateResponseOptions,
    OpenAIService,
} from '../src/services/openaiService.js';

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

test('web requests go through planner and are coerced to message when planner picks react', async () => {
    let callCount = 0;
    let finalMessages: Array<{ role: string; content: string }> = [];
    const openaiService: OpenAIService = {
        async generateResponse(
            _model,
            messages,
            options?: GenerateResponseOptions
        ) {
            callCount += 1;
            if (options?.expectMetadata === false) {
                return {
                    normalizedText: JSON.stringify({
                        action: 'react',
                        modality: 'text',
                        reaction: '👍',
                        riskTier: 'Low',
                        reasoning: 'A reaction would normally be enough.',
                        generation: {
                            reasoningEffort: 'low',
                            verbosity: 'low',
                            toolChoice: 'none',
                        },
                    }),
                    metadata: { model: 'gpt-5-mini' },
                };
            }

            finalMessages = messages;
            return {
                normalizedText: 'coerced web reply',
                metadata: {
                    model: 'gpt-5-mini',
                    provenance: 'Inferred',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const orchestrator = createReflectOrchestrator({
        openaiService,
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
        renderPrompt('reflect.chat.system').content
    );
    assert.match(
        finalMessages[finalMessages.length - 1]?.content ?? '',
        /coercedFrom/
    );
});

test('discord requests preserve non-message planner actions', async () => {
    let callCount = 0;
    const openaiService: OpenAIService = {
        async generateResponse(
            _model,
            _messages,
            options?: GenerateResponseOptions
        ) {
            callCount += 1;
            if (options?.expectMetadata === false) {
                return {
                    normalizedText: JSON.stringify({
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
                            toolChoice: 'none',
                        },
                    }),
                    metadata: { model: 'gpt-5-mini' },
                };
            }

            throw new Error(
                'message generation should not run for image actions'
            );
        },
    };

    const orchestrator = createReflectOrchestrator({
        openaiService,
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
    let generationOptionsSeen: GenerateResponseOptions | undefined;
    let finalMessages: Array<{ role: string; content: string }> = [];
    const openaiService: OpenAIService = {
        async generateResponse(
            _model,
            messages,
            options?: GenerateResponseOptions
        ) {
            if (options?.expectMetadata === false) {
                return {
                    normalizedText: JSON.stringify({
                        action: 'message',
                        modality: 'text',
                        riskTier: 'Low',
                        reasoning: 'This needs a sourced reply.',
                        generation: {
                            reasoningEffort: 'medium',
                            verbosity: 'medium',
                            toolChoice: 'web_search',
                            temperament: {
                                tightness: 4,
                                rationale: 3,
                                attribution: 4,
                                caution: 3,
                                extent: 4,
                            },
                            webSearch: {
                                query: 'latest OpenAI policy update',
                                searchContextSize: 'low',
                                searchIntent: 'current_facts',
                            },
                        },
                    }),
                    metadata: { model: 'gpt-5-mini' },
                };
            }

            finalMessages = messages;
            generationOptionsSeen = options;
            return {
                normalizedText: 'message with retrieval',
                metadata: {
                    model: 'gpt-5-mini',
                    provenance: 'Retrieved',
                    tradeoffCount: 0,
                    citations: [],
                },
            };
        },
    };

    const orchestrator = createReflectOrchestrator({
        openaiService,
        storeTrace: async () => undefined,
        buildResponseMetadata: () => createMetadata(),
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await orchestrator.runReflect(createReflectRequest());

    assert.equal(response.action, 'message');
    assert.equal(generationOptionsSeen?.toolChoice, 'web_search');
    assert.equal(
        generationOptionsSeen?.webSearch?.searchIntent,
        'current_facts'
    );
    assert.equal(generationOptionsSeen?.reasoningEffort, 'medium');
    assert.equal(generationOptionsSeen?.verbosity, 'medium');
    assert.equal(
        finalMessages[0]?.content,
        renderPrompt('discord.chat.system').content
    );
});
