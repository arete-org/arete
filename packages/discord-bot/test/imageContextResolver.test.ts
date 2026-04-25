/**
 * @description: Verifies trace-first image context recovery and legacy embed fallback parsing.
 * @footnote-scope: test
 * @footnote-module: ImageContextResolverTests
 * @footnote-risk: medium - Regressions here can break variation follow-ups after bot restarts.
 * @footnote-ethics: medium - Accurate prompt provenance recovery affects transparency and user trust.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { botApi } from '../src/api/botApi.js';
import {
    recoverContextDetailsFromMessage,
    recoverContextDetailsFromTrace,
} from '../src/commands/image/contextResolver.js';

const createTraceMetadata = (): ResponseMetadata => ({
    responseId: 'resp_trace_image_1',
    provenance: 'Speculative',
    safetyTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'chain_hash_1',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-image-1-mini',
    staleAfter: new Date(Date.now() + 60_000).toISOString(),
    citations: [],
    trace_target: {},
    trace_final: {},
    imageGeneration: {
        version: 'v1',
        prompts: {
            original: 'original trace prompt',
            active: 'active trace prompt',
            revised: 'revised trace prompt',
            maxInputChars: 8000,
            policyTruncated: false,
        },
        request: {
            textModel: 'gpt-5-mini',
            imageModel: 'gpt-image-1-mini',
            quality: 'medium',
            size: '1024x1024',
            aspectRatio: 'square',
            background: 'opaque',
            style: 'vivid',
            allowPromptAdjustment: true,
            outputFormat: 'png',
            outputCompression: 90,
        },
        linkage: {
            followUpResponseId: 'resp_prev_image_1',
        },
        result: {
            outputResponseId: 'resp_trace_image_1',
            finalStyle: 'vivid',
            generationTimeMs: 1800,
        },
        usage: {
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
            imageCount: 1,
        },
        costs: {
            text: 0.00001,
            image: 0.001,
            total: 0.00101,
            perImage: 0.001,
        },
    },
});

test('recoverContextDetailsFromTrace builds context from imageGeneration metadata', async () => {
    const originalGetTrace = botApi.getTrace;
    botApi.getTrace = (async () => ({
        status: 200,
        data: createTraceMetadata(),
    })) as typeof botApi.getTrace;

    try {
        const recovered =
            await recoverContextDetailsFromTrace('resp_trace_image_1');

        assert.ok(recovered);
        assert.equal(recovered?.context.prompt, 'active trace prompt');
        assert.equal(
            recovered?.context.originalPrompt,
            'original trace prompt'
        );
        assert.equal(recovered?.context.refinedPrompt, 'revised trace prompt');
        assert.equal(recovered?.context.textModel, 'gpt-5-mini');
        assert.equal(recovered?.context.imageModel, 'gpt-image-1-mini');
        assert.equal(recovered?.responseId, 'resp_trace_image_1');
        assert.equal(recovered?.inputId, 'resp_prev_image_1');
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});

test('recoverContextDetailsFromTrace fails open when trace is not found', async () => {
    const originalGetTrace = botApi.getTrace;
    botApi.getTrace = (async () => {
        const notFoundError = new Error('not found') as Error & {
            status: number;
            code: string;
            endpoint: string;
        };
        notFoundError.name = 'DiscordApiClientError';
        notFoundError.status = 404;
        notFoundError.code = 'not_found';
        notFoundError.endpoint = '/api/traces/resp_missing';
        throw notFoundError;
    }) as typeof botApi.getTrace;

    try {
        const recovered = await recoverContextDetailsFromTrace('resp_missing');
        assert.equal(recovered, null);
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});

test('recoverContextDetailsFromTrace accepts stale trace envelopes and preserves prompt policy fields', async () => {
    const originalGetTrace = botApi.getTrace;
    botApi.getTrace = (async () => ({
        status: 410,
        data: {
            message: 'Trace is stale',
            metadata: createTraceMetadata(),
        },
    })) as typeof botApi.getTrace;

    try {
        const recovered =
            await recoverContextDetailsFromTrace('resp_trace_image_1');
        assert.ok(recovered);
        assert.equal(recovered?.context.promptPolicyMaxInputChars, 8000);
        assert.equal(recovered?.context.promptPolicyTruncated, false);
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});

test('recoverContextDetailsFromTrace returns null for non-image traces', async () => {
    const originalGetTrace = botApi.getTrace;
    botApi.getTrace = (async () => ({
        status: 200,
        data: {
            metadata: {
                responseId: 'resp_non_image_1',
                provenance: 'Inferred',
                safetyTier: 'Low',
                tradeoffCount: 0,
                chainHash: 'chain_hash_non_image_1',
                licenseContext: 'MIT + HL3',
                modelVersion: 'gpt-5-mini',
                staleAfter: new Date(Date.now() + 60_000).toISOString(),
                citations: [],
                trace_target: {},
                trace_final: {},
            },
        },
    })) as unknown as typeof botApi.getTrace;

    try {
        const recovered =
            await recoverContextDetailsFromTrace('resp_non_image_1');
        assert.equal(recovered, null);
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});

test('recoverContextDetailsFromMessage parses legacy embed fields for fallback context', async () => {
    const recovered = await recoverContextDetailsFromMessage({
        id: 'message-legacy-1',
        embeds: [
            {
                fields: [
                    { name: 'Prompt', value: 'legacy prompt text' },
                    { name: 'Image model', value: 'gpt-image-1-mini' },
                    { name: 'Text model', value: 'gpt-5-mini' },
                    { name: 'Quality', value: 'Medium' },
                    { name: 'Aspect ratio', value: 'Square' },
                    { name: 'Resolution', value: '1024x1024' },
                    { name: 'Background', value: 'Opaque' },
                    { name: 'Prompt adjustment', value: 'Enabled' },
                    { name: 'Output format', value: 'PNG' },
                    { name: 'Compression', value: '90' },
                    { name: 'Output ID', value: '`resp_legacy_1`' },
                    { name: 'Input ID', value: '`resp_legacy_parent`' },
                ],
            },
        ],
        channel: null,
        client: { user: { id: 'bot-user-1' } },
    } as never);

    assert.ok(recovered);
    assert.equal(recovered?.context.prompt, 'legacy prompt text');
    assert.equal(recovered?.context.originalPrompt, 'legacy prompt text');
    assert.equal(recovered?.context.imageModel, 'gpt-image-1-mini');
    assert.equal(recovered?.responseId, 'resp_legacy_1');
    assert.equal(recovered?.inputId, 'resp_legacy_parent');
});
