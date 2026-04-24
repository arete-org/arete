/**
 * @description: Verifies the shared Discord image execution helper uses the backend-owned image task path.
 * @footnote-scope: test
 * @footnote-module: ImageSessionHelpersTests
 * @footnote-risk: medium - Missing tests here could let image execution drift back to local provider calls.
 * @footnote-ethics: medium - Confirms the backend-owned image path still returns normalized artifacts and cost accounting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { botApi } from '../src/api/botApi.js';
import { EMBED_FIELD_VALUE_LIMIT } from '../src/commands/image/constants.js';
import {
    buildImageResultPresentation,
    executeImageGeneration,
} from '../src/commands/image/sessionHelpers.js';
import type { ImageGenerationContext } from '../src/commands/image/followUpCache.js';
import { runtimeConfig } from '../src/config.js';

const createContext = (): ImageGenerationContext => ({
    prompt: 'draw a reflective skyline',
    originalPrompt: 'draw a reflective skyline',
    refinedPrompt: null,
    promptPolicyMaxInputChars: 8000,
    promptPolicyTruncated: false,
    textModel: 'gpt-5-mini',
    imageModel: 'gpt-image-1-mini',
    size: '1024x1024',
    aspectRatio: 'square',
    aspectRatioLabel: 'Square',
    quality: 'medium',
    background: 'auto',
    style: 'vivid',
    allowPromptAdjustment: true,
    outputFormat: 'png',
    outputCompression: 100,
});

test('executeImageGeneration uses the streaming backend image task path when partial previews are requested', async () => {
    const originalRunImageTaskViaApi = botApi.runImageTaskViaApi;
    const originalRunImageTaskStreamViaApi = botApi.runImageTaskStreamViaApi;
    const seenRequests: unknown[] = [];
    const partials: Array<{ index: number; base64: string }> = [];
    botApi.runImageTaskStreamViaApi = (async (request, options) => {
        seenRequests.push(request);
        await options?.onPartialImage?.({
            index: 0,
            base64: 'partial-one',
        });
        return {
            task: 'generate',
            result: {
                responseId: 'resp_123',
                textModel: 'gpt-5-mini',
                imageModel: 'gpt-image-1-mini',
                revisedPrompt: 'draw a reflective skyline at dusk',
                finalStyle: 'vivid',
                annotations: {
                    title: 'Reflective Skyline',
                    description: 'A city scene at dusk.',
                    note: 'The skyline emphasizes calm light.',
                    adjustedPrompt: 'draw a reflective skyline at dusk',
                },
                finalImageBase64: 'aGVsbG8=',
                outputFormat: 'png',
                outputCompression: 100,
                usage: {
                    inputTokens: 42,
                    outputTokens: 18,
                    totalTokens: 60,
                    imageCount: 1,
                },
                costs: {
                    text: 0.000046,
                    image: 0.011,
                    total: 0.011046,
                    perImage: 0.011,
                },
                generationTimeMs: 2100,
            },
        };
    }) as typeof botApi.runImageTaskStreamViaApi;
    botApi.runImageTaskViaApi = (async () => {
        throw new Error('non-streaming client should not be used');
    }) as typeof botApi.runImageTaskViaApi;

    try {
        const artifacts = await executeImageGeneration(createContext(), {
            followUpResponseId: 'resp_prev_123',
            user: {
                username: 'Jordan',
                nickname: 'Jordan',
                guildName: 'Footnote Lab',
            },
            channelContext: {
                channelId: 'channel-123',
                guildId: 'guild-456',
            },
            onPartialImage(payload) {
                partials.push(payload);
            },
        });

        assert.equal(seenRequests.length, 1);
        assert.equal(
            (seenRequests[0] as { followUpResponseId?: string })
                .followUpResponseId,
            'resp_prev_123'
        );
        assert.deepEqual(
            (seenRequests[0] as { promptPolicy?: unknown }).promptPolicy,
            {
                originalPrompt: 'draw a reflective skyline',
                maxInputChars: 8000,
                policyTruncated: false,
            }
        );
        assert.equal(
            (seenRequests[0] as { aspectRatio?: string }).aspectRatio,
            'square'
        );
        assert.equal(artifacts.responseId, 'resp_123');
        assert.equal(artifacts.finalImageBuffer.toString('utf8'), 'hello');
        assert.deepEqual(partials, [{ index: 0, base64: 'partial-one' }]);
    } finally {
        botApi.runImageTaskViaApi = originalRunImageTaskViaApi;
        botApi.runImageTaskStreamViaApi = originalRunImageTaskStreamViaApi;
    }
});

test('buildImageResultPresentation keeps generation context prompts beyond embed field limits', () => {
    const longPrompt = 'A'.repeat(EMBED_FIELD_VALUE_LIMIT + 400);
    const context: ImageGenerationContext = {
        ...createContext(),
        prompt: longPrompt,
        originalPrompt: longPrompt,
        refinedPrompt: null,
    };

    const presentation = buildImageResultPresentation(context, {
        responseId: 'resp_long_prompt',
        textModel: context.textModel,
        imageModel: context.imageModel,
        revisedPrompt: null,
        finalStyle: context.style,
        annotations: {
            title: 'Long prompt test',
            description: null,
            note: null,
            adjustedPrompt: null,
        },
        finalImageBuffer: Buffer.from('hello'),
        finalImageFileName: 'long-prompt.png',
        imageUrl: 'https://example.com/long-prompt.png',
        outputFormat: context.outputFormat,
        outputCompression: context.outputCompression,
        usage: {
            inputTokens: 11,
            outputTokens: 5,
            totalTokens: 16,
            imageCount: 1,
        },
        costs: {
            text: 0.00001,
            image: 0.001,
            total: 0.00101,
            perImage: 0.001,
        },
        generationTimeMs: 1024,
    });

    assert.equal(presentation.retryContext.prompt.length, longPrompt.length);
    assert.equal(
        presentation.retryContext.originalPrompt.length,
        longPrompt.length
    );

    const promptField = presentation.embed.data.fields?.find(
        (field) => field.name === 'Original prompt'
    );
    assert.ok(promptField);
    assert.equal(
        (promptField?.value ?? '').length <= EMBED_FIELD_VALUE_LIMIT,
        true
    );
    assert.match(promptField?.value ?? '', /\*\(truncated\)\*/);

    const traceField = presentation.embed.data.fields?.find(
        (field) => field.name === 'Trace'
    );
    assert.ok(traceField);
    const expectedTraceBase = runtimeConfig.webBaseUrl
        .trim()
        .replace(/\/+$/, '');
    assert.equal(
        traceField?.value,
        `[Open trace](${expectedTraceBase}/traces/resp_long_prompt)`
    );
});
