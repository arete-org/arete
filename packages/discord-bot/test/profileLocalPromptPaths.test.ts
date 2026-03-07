/**
 * @description: Verifies bot-local prompt paths apply profile overlay composition consistently.
 * @footnote-scope: test
 * @footnote-module: ProfileLocalPromptPathTests
 * @footnote-risk: low - These tests validate prompt construction only.
 * @footnote-ethics: high - Local prompt paths must preserve base safety while applying vendor overlays consistently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeConfig } from '../src/config.js';
import type { BotProfileConfig } from '../src/config/profile.js';
import { buildDeveloperPrompt } from '../src/commands/image/prompts.js';
import { generateImageWithMetadata } from '../src/commands/image/openai.js';
import { RealtimeContextBuilder } from '../src/utils/prompting/RealtimeContextBuilder.js';
import {
    generateAlternativeLensMessage,
    requestProvenanceOpenAIOptions,
    type AlternativeLensPayload,
} from '../src/utils/response/provenanceInteractions.js';
import { Planner } from '../src/utils/prompting/Planner.js';
import type {
    OpenAIMessage,
    OpenAIOptions,
    OpenAIService,
} from '../src/utils/openaiService.js';

const originalProfile = runtimeConfig.profile;

const withProfile = async (
    profile: BotProfileConfig,
    fn: () => Promise<void> | void
): Promise<void> => {
    const mutableRuntimeConfig = runtimeConfig as unknown as {
        profile: BotProfileConfig;
    };
    mutableRuntimeConfig.profile = profile;
    try {
        await fn();
    } finally {
        mutableRuntimeConfig.profile = originalProfile;
    }
};

const createOverlayProfile = (): BotProfileConfig => ({
    id: 'ari-vendor',
    displayName: 'Ari',
    promptOverlay: {
        source: 'inline',
        text: 'You may speak as Ari when this runtime is explicitly configured for that vendor.',
        path: null,
        length: 77,
    },
});

const createNoOverlayProfile = (): BotProfileConfig => ({
    id: 'footnote',
    displayName: 'Footnote',
    promptOverlay: {
        source: 'none',
        text: null,
        path: null,
        length: 0,
    },
});

test('buildDeveloperPrompt appends the configured profile overlay and leaves no-overlay prompts unchanged', async () => {
    await withProfile(createOverlayProfile(), () => {
        const prompt = buildDeveloperPrompt({
            allowPromptAdjustment: false,
            size: '1024x1024',
            quality: 'low',
            background: 'auto',
            style: 'natural',
            username: 'Jordan',
            nickname: 'J',
            guildName: 'Footnote Lab',
            remainingPromptRatio: 1,
        });

        assert.match(prompt, /BEGIN Bot Profile Overlay/);
        assert.match(prompt, /Usage Context: image\.developer/);
        assert.match(prompt, /Profile Display Name: Ari/);
    });

    await withProfile(createNoOverlayProfile(), () => {
        const prompt = buildDeveloperPrompt({
            allowPromptAdjustment: false,
            size: '1024x1024',
            quality: 'low',
            background: 'auto',
            style: 'natural',
            username: 'Jordan',
            nickname: 'J',
            guildName: 'Footnote Lab',
            remainingPromptRatio: 1,
        });

        assert.doesNotMatch(prompt, /BEGIN Bot Profile Overlay/);
    });
});

test('generateImageWithMetadata injects the configured overlay into the image system prompt', async () => {
    await withProfile(createOverlayProfile(), async () => {
        let capturedPayload: unknown = null;
        const openai = {
            responses: {
                create: async (payload: unknown) => {
                    capturedPayload = payload;
                    return {
                        error: null,
                        output: [
                            {
                                type: 'image_generation_call',
                                id: 'img_123',
                                status: 'completed',
                                result: 'base64-image',
                            },
                            {
                                type: 'message',
                                content: [
                                    {
                                        type: 'output_text',
                                        text: '{"title":"t","description":"d","reflection":"n","adjusted_prompt":"p"}',
                                    },
                                ],
                            },
                        ],
                    };
                },
            },
        } as never;

        await generateImageWithMetadata({
            openai,
            prompt: 'A quiet library at dusk',
            textModel: 'gpt-4.1-mini',
            imageModel: 'gpt-image-1-mini',
            quality: 'low',
            size: '1024x1024',
            background: 'auto',
            style: 'natural',
            username: 'Jordan',
            nickname: 'J',
            guildName: 'Footnote Lab',
            allowPromptAdjustment: false,
            outputFormat: 'png',
            outputCompression: 100,
            stream: false,
        });

        const payload = capturedPayload as {
            input: Array<{
                role: string;
                content: Array<{ type: string; text: string }>;
            }>;
        };
        assert.match(payload.input[0].content[0].text, /BEGIN Bot Profile Overlay/);
        assert.match(payload.input[0].content[0].text, /Usage Context: image\.system/);
    });
});

test('RealtimeContextBuilder appends the configured overlay to realtime instructions', async () => {
    await withProfile(createOverlayProfile(), () => {
        const builder = new RealtimeContextBuilder();
        const result = builder.buildContext({
            participants: [{ id: 'u1', displayName: 'Jordan' }],
            transcripts: ['Earlier topic summary'],
        });

        assert.match(result.instructions, /BEGIN Bot Profile Overlay/);
        assert.match(result.instructions, /Usage Context: realtime/);
        assert.match(result.instructions, /Participants currently in the voice channel/);
    });
});

test('generateAlternativeLensMessage uses the overlay-composed provenance system prompt', async () => {
    await withProfile(createOverlayProfile(), async () => {
        let capturedMessages: OpenAIMessage[] = [];
        const openaiService = {
            generateResponse: async (
                _model: string,
                messages: OpenAIMessage[],
                _options: OpenAIOptions
            ) => {
                capturedMessages = messages;
                return {
                    message: { content: 'Reframed response' },
                };
            },
        } as never as OpenAIService;
        const lens: AlternativeLensPayload = {
            key: 'CUSTOM',
            label: 'Custom Lens',
            description: 'Focus on identity and authorship.',
        };

        const text = await generateAlternativeLensMessage(
            openaiService,
            {
                messageText: 'Original response',
                metadata: null,
                channelId: 'channel-1',
            },
            lens
        );

        assert.equal(text, 'Reframed response');
        assert.match(capturedMessages[0].content, /BEGIN Bot Profile Overlay/);
        assert.match(capturedMessages[0].content, /Usage Context: provenance/);
    });
});

test('requestProvenanceOpenAIOptions passes overlay-composed system prompt into planner context', async () => {
    await withProfile(createOverlayProfile(), async () => {
        const originalGeneratePlan = Planner.prototype.generatePlan;
        let capturedContext: OpenAIMessage[] = [];

        Planner.prototype.generatePlan = (async function (
            this: Planner,
            context: OpenAIMessage[]
        ) {
            capturedContext = context;
            return {
                action: 'ignore',
                modality: 'text',
                openaiOptions: { reasoningEffort: 'low', verbosity: 'low' },
                riskTier: 'Low',
            } as never;
        }) as typeof Planner.prototype.generatePlan;

        try {
            const options = await requestProvenanceOpenAIOptions(
                {} as OpenAIService,
                {
                    kind: 'alternative_lens',
                    messageText: 'Original response',
                    lens: {
                        key: 'CUSTOM',
                        label: 'Custom Lens',
                        description: 'Focus on identity and authorship.',
                    },
                    metadata: null,
                }
            );

            assert.deepEqual(options, {
                reasoningEffort: 'low',
                verbosity: 'low',
            });
            assert.match(capturedContext[0].content, /BEGIN Bot Profile Overlay/);
            assert.match(capturedContext[0].content, /Usage Context: provenance/);
        } finally {
            Planner.prototype.generatePlan = originalGeneratePlan;
        }
    });
});
