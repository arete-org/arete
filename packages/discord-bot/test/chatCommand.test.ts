/**
 * @description: Verifies /chat slash command request forwarding and action handling.
 * @footnote-scope: test
 * @footnote-module: ChatCommandTests
 * @footnote-risk: low - These tests only cover command-level wiring.
 * @footnote-ethics: medium - Ensures model/profile selector inputs are forwarded as requested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { botApi } from '../src/api/botApi.js';
import chatCommand from '../src/commands/chat.js';

const createInteraction = (overrides: {
    prompt?: string;
    profileId?: string | null;
    reasoningEffort?: string | null;
    verbosity?: string | null;
    id?: string;
}) => {
    const editReplyPayloads: unknown[] = [];
    const deferReplyPayloads: unknown[] = [];

    return {
        interaction: {
            id: overrides.id ?? 'interaction-1',
            channelId: 'channel-123',
            guildId: 'guild-456',
            user: {
                id: 'user-789',
            },
            options: {
                getString: (name: string, required?: boolean) => {
                    if (name === 'prompt') {
                        if (required && !overrides.prompt) {
                            throw new Error('required prompt missing');
                        }
                        return overrides.prompt ?? null;
                    }
                    if (name === 'profile_id') {
                        return overrides.profileId ?? null;
                    }
                    if (name === 'reasoning_effort') {
                        return overrides.reasoningEffort ?? null;
                    }
                    if (name === 'verbosity') {
                        return overrides.verbosity ?? null;
                    }
                    return null;
                },
            },
            deferReply: async (payload?: unknown) => {
                deferReplyPayloads.push(payload);
            },
            editReply: async (payload: unknown) => {
                editReplyPayloads.push(payload);
            },
        },
        editReplyPayloads,
        deferReplyPayloads,
    };
};

test('/chat forwards prompt/profile/generation options and renders message action', async () => {
    const originalChatViaApi = botApi.chatViaApi;
    const originalPostTraceCardFromTrace = botApi.postTraceCardFromTrace;
    const seenRequests: unknown[] = [];
    botApi.chatViaApi = (async (request) => {
        seenRequests.push(request);
        return {
            action: 'message',
            message: 'Model-switched response',
            modality: 'text',
            metadata: {
                responseId: 'resp_123',
                provenance: 'Inferred',
                riskTier: 'Low',
                tradeoffCount: 0,
                chainHash: 'hash_123',
                licenseContext: 'MIT + HL3',
                modelVersion: 'gpt-5-mini',
                staleAfter: new Date(Date.now() + 60000).toISOString(),
                citations: [],
                execution: [
                    {
                        kind: 'tool',
                        toolName: 'web_search',
                        status: 'skipped',
                        reasonCode: 'search_not_supported_by_selected_profile',
                    },
                ],
            },
        };
    }) as typeof botApi.chatViaApi;
    botApi.postTraceCardFromTrace = (async (request, _options) => ({
        responseId: request.responseId,
        pngBase64: Buffer.from('trace-card').toString('base64'),
    })) as typeof botApi.postTraceCardFromTrace;

    const { interaction, editReplyPayloads, deferReplyPayloads } =
        createInteraction({
            prompt: 'Compare model output.',
            profileId: 'openai-text-medium',
            reasoningEffort: 'high',
            verbosity: 'low',
        });

    try {
        await chatCommand.execute(interaction as never);
        assert.equal(deferReplyPayloads.length, 1);
        assert.equal(editReplyPayloads.length, 1);
        assert.deepEqual(seenRequests, [
            {
                surface: 'discord',
                profileId: 'openai-text-medium',
                trigger: {
                    kind: 'direct',
                    messageId: 'interaction-1',
                },
                latestUserInput: 'Compare model output.',
                conversation: [
                    {
                        role: 'user',
                        content: 'Compare model output.',
                    },
                ],
                capabilities: {
                    canReact: true,
                    canGenerateImages: true,
                    canUseTts: true,
                },
                generation: {
                    reasoningEffort: 'high',
                    verbosity: 'low',
                },
                surfaceContext: {
                    channelId: 'channel-123',
                    guildId: 'guild-456',
                    userId: 'user-789',
                },
            },
        ]);
        const payload = editReplyPayloads[0] as {
            content?: string;
            components?: unknown[];
            files?: unknown[];
        };
        assert.match(
            String(payload.content),
            /^> profile_id: openai-text-medium\n> reasoning_effort: high\n> verbosity: low\n\n⚠️ search unavailable for selected model\n\nModel-switched response$/
        );
        assert.equal(Array.isArray(payload.components), true);
        assert.equal(payload.components?.length, 1);
        assert.equal(Array.isArray(payload.files), true);
        assert.equal(payload.files?.length, 1);
    } finally {
        botApi.chatViaApi = originalChatViaApi;
        botApi.postTraceCardFromTrace = originalPostTraceCardFromTrace;
    }
});

test('/chat handles non-message actions gracefully', async () => {
    const originalChatViaApi = botApi.chatViaApi;
    botApi.chatViaApi = (async () => {
        return {
            action: 'react',
            reaction: '👍',
            metadata: null,
        };
    }) as typeof botApi.chatViaApi;

    const { interaction, editReplyPayloads } = createInteraction({
        prompt: 'React to this.',
    });

    try {
        await chatCommand.execute(interaction as never);
        assert.equal(editReplyPayloads.length, 1);
        assert.match(
            String((editReplyPayloads[0] as { content?: string }).content),
            /^Backend selected reaction mode \(👍\). \/chat currently returns text only\.$/i
        );
    } finally {
        botApi.chatViaApi = originalChatViaApi;
    }
});
