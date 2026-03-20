/**
 * @description: Verifies Discord-local OpenAI helpers report usage through the restored recorder seam.
 * @footnote-scope: test
 * @footnote-module: OpenAIServiceTests
 * @footnote-risk: medium - Missing coverage here could let Discord-local helper usage drift out of the shared cost-reporting path.
 * @footnote-ethics: medium - Usage reporting supports transparent operator visibility for embeddings and TTS helper calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    DEFAULT_EMBEDDING_MODEL,
    OpenAIService,
    TTS_DEFAULT_OPTIONS,
} from '../src/utils/openaiService.js';
import type { LLMUsageRecord } from '../src/state/ChannelContextManager.js';

test('embedText records usage through the injected recorder seam', async () => {
    const recordedUsage: LLMUsageRecord[] = [];
    const service = new OpenAIService('test-key', {
        recordLLMUsage(record) {
            recordedUsage.push(record);
        },
    });

    (
        service as unknown as {
            openai: {
                embeddings: {
                    create: (
                        request: Record<string, unknown>
                    ) => Promise<{
                        data: Array<{ embedding: number[] }>;
                        usage: { prompt_tokens: number; total_tokens: number };
                    }>;
                };
            };
        }
    ).openai = {
        embeddings: {
            async create(request) {
                assert.equal(request.model, DEFAULT_EMBEDDING_MODEL);
                return {
                    data: [{ embedding: [0.25, 0.5] }],
                    usage: {
                        prompt_tokens: 12,
                        total_tokens: 12,
                    },
                };
            },
        },
    };

    const embedding = await service.embedText('hello world');

    assert.deepEqual(embedding, [0.25, 0.5]);
    assert.equal(recordedUsage.length, 1);
    assert.equal(recordedUsage[0]?.feature, 'embedding');
    assert.equal(recordedUsage[0]?.model, DEFAULT_EMBEDDING_MODEL);
    assert.equal(recordedUsage[0]?.promptTokens, 12);
    assert.equal(recordedUsage[0]?.completionTokens, 0);
    assert.equal(recordedUsage[0]?.totalTokens, 12);
    assert.equal(recordedUsage[0]?.outputCostUsd, 0);
    assert.equal(recordedUsage[0]?.estimated, false);
    assert.ok(
        Math.abs((recordedUsage[0]?.inputCostUsd ?? 0) - 0.00000024) < 1e-16
    );
    assert.ok(
        Math.abs((recordedUsage[0]?.totalCostUsd ?? 0) - 0.00000024) < 1e-16
    );
    assert.equal(typeof recordedUsage[0]?.timestamp, 'number');
});

test('generateSpeech records TTS usage through the injected recorder seam', async () => {
    const recordedUsage: LLMUsageRecord[] = [];
    const service = new OpenAIService('test-key', {
        recordLLMUsage(record) {
            recordedUsage.push(record);
        },
    });
    const filename = `tts-test-${Date.now()}`;

    (
        service as unknown as {
            openai: {
                audio: {
                    speech: {
                        create: () => Promise<Response>;
                    };
                };
            };
        }
    ).openai = {
        audio: {
            speech: {
                async create() {
                    return new Response(Buffer.from('audio-bytes'));
                },
            },
        },
    };

    let outputPath = '';
    try {
        outputPath = await service.generateSpeech(
            'Speak this reply.',
            TTS_DEFAULT_OPTIONS,
            filename,
            'mp3'
        );

        assert.equal(fs.existsSync(outputPath), true);
        assert.equal(recordedUsage.length, 1);
        assert.equal(recordedUsage[0]?.feature, 'tts');
        assert.equal(recordedUsage[0]?.model, TTS_DEFAULT_OPTIONS.model);
        assert.equal(recordedUsage[0]?.completionTokens, 0);
        assert.equal(recordedUsage[0]?.estimated, true);
        assert.ok((recordedUsage[0]?.promptTokens ?? 0) > 0);
        assert.ok((recordedUsage[0]?.totalCostUsd ?? 0) > 0);
    } finally {
        if (outputPath && fs.existsSync(outputPath)) {
            await fs.promises.unlink(outputPath);
        }
    }
});
