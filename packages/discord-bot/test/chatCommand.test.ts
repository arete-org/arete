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
    modeId?: string | null;
    maxReviewCycles?: number | null;
    traceTightness?: number | null;
    traceRationale?: number | null;
    traceAttribution?: number | null;
    traceCaution?: number | null;
    traceExtent?: number | null;
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
                    if (name === 'mode') {
                        return overrides.modeId ?? null;
                    }
                    return null;
                },
                getInteger: (name: string) => {
                    if (name === 'max_review_cycles') {
                        return overrides.maxReviewCycles ?? null;
                    }
                    if (name === 'trace_tightness') {
                        return overrides.traceTightness ?? null;
                    }
                    if (name === 'trace_rationale') {
                        return overrides.traceRationale ?? null;
                    }
                    if (name === 'trace_attribution') {
                        return overrides.traceAttribution ?? null;
                    }
                    if (name === 'trace_caution') {
                        return overrides.traceCaution ?? null;
                    }
                    if (name === 'trace_extent') {
                        return overrides.traceExtent ?? null;
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

test('/chat forwards prompt/workflow options and renders message action', async () => {
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
                safetyTier: 'Low',
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
            modeId: 'grounded',
            maxReviewCycles: 4,
            traceTightness: 4,
            traceRationale: 2,
            traceAttribution: 5,
            traceCaution: 3,
            traceExtent: 1,
        });

    try {
        await chatCommand.execute(interaction as never);
        assert.equal(deferReplyPayloads.length, 1);
        assert.equal(editReplyPayloads.length, 1);
        assert.deepEqual(seenRequests, [
            {
                surface: 'discord',
                botPersonaId: 'footnote',
                modeId: 'grounded',
                maxReviewCycles: 4,
                traceTarget: {
                    tightness: 4,
                    rationale: 2,
                    attribution: 5,
                    caution: 3,
                    extent: 1,
                },
                trigger: {
                    kind: 'submit',
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
            /^> mode: grounded\n> max_review_cycles: 4\n> trace_tightness: 4\n> trace_rationale: 2\n> trace_attribution: 5\n> trace_caution: 3\n> trace_extent: 1\n\n⚠️ search unavailable for selected model\n\nModel-switched response$/
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
