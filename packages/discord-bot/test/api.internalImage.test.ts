/**
 * @description: Covers the Discord bot internal image-task API client wrapper.
 * @footnote-scope: test
 * @footnote-module: DiscordInternalImageApiTests
 * @footnote-risk: low - These tests validate transport wiring and response validation only.
 * @footnote-ethics: medium - Stable trusted transport helps keep backend-owned image tasks predictable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PostInternalImageGenerateRequest } from '@footnote/contracts/web';
import type {
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
} from '../src/api/client.js';
import { createInternalImageApi } from '../src/api/internalImage.js';

const createImageRequest = (
    overrides: Partial<PostInternalImageGenerateRequest> = {}
): PostInternalImageGenerateRequest => ({
    task: 'generate',
    prompt: 'draw a reflective skyline',
    textModel: 'gpt-5-mini',
    imageModel: 'gpt-image-1-mini',
    size: '1024x1024',
    quality: 'medium',
    background: 'auto',
    style: 'vivid',
    allowPromptAdjustment: true,
    outputFormat: 'png',
    outputCompression: 100,
    user: {
        username: 'Jordan',
        nickname: 'Jordan',
        guildName: 'Footnote Lab',
    },
    ...overrides,
});

test('runImageTaskViaApi posts to /api/internal/image with trusted headers and returns parsed data', async () => {
    const request = createImageRequest();
    let capturedEndpoint = '';
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: unknown;

    const requestJson: ApiRequester = async <T>(
        endpoint: string,
        options: ApiRequestOptions<T> = {}
    ): Promise<ApiJsonResult<T>> => {
        capturedEndpoint = endpoint;
        capturedHeaders = options.headers as Record<string, string>;
        capturedBody = options.body;
        return {
            status: 200,
            data: {
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
                    finalImageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
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
            } as T,
        };
    };

    const api = createInternalImageApi(requestJson, {
        traceApiToken: 'trace-secret',
        baseUrl: 'http://backend.test',
    });

    const response = await api.runImageTaskViaApi(request);

    assert.equal(capturedEndpoint, '/api/internal/image');
    assert.equal(capturedHeaders?.['X-Trace-Token'], 'trace-secret');
    assert.deepEqual(capturedBody, request);
    assert.equal(response.task, 'generate');
    assert.equal(response.result.responseId, 'resp_123');
});

test('runImageTaskViaApi throws backend request errors so callers can handle them', async () => {
    const requestJson: ApiRequester = async () => {
        throw new Error('backend exploded');
    };
    const api = createInternalImageApi(requestJson, {
        baseUrl: 'http://backend.test',
    });

    await assert.rejects(
        () => api.runImageTaskViaApi(createImageRequest()),
        /backend exploded/
    );
});

test('runImageTaskStreamViaApi parses NDJSON events and returns the terminal result', async () => {
    const request = createImageRequest();
    const partials: Array<{ index: number; base64: string }> = [];
    let seenBody = '';
    const requestJson: ApiRequester = async () => {
        throw new Error('requestJson should not be used for streaming');
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
        seenBody = String(init?.body ?? '');
        return new Response(
            [
                JSON.stringify({
                    type: 'partial_image',
                    index: 0,
                    base64: 'partial-one',
                }),
                JSON.stringify({
                    type: 'partial_image',
                    index: 1,
                    base64: 'partial-two',
                }),
                JSON.stringify({
                    type: 'result',
                    task: 'generate',
                    result: {
                        responseId: 'resp_123',
                        textModel: 'gpt-5-mini',
                        imageModel: 'gpt-image-1-mini',
                        revisedPrompt: null,
                        finalStyle: 'vivid',
                        annotations: {
                            title: null,
                            description: null,
                            note: null,
                            adjustedPrompt: null,
                        },
                        finalImageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
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
                }),
                '',
            ].join('\n'),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/x-ndjson; charset=utf-8',
                },
            }
        );
    };

    const api = createInternalImageApi(requestJson, {
        traceApiToken: 'trace-secret',
        baseUrl: 'http://backend.test',
        fetchImpl,
    });

    const response = await api.runImageTaskStreamViaApi(request, {
        onPartialImage(payload) {
            partials.push(payload);
        },
    });

    assert.equal(JSON.parse(seenBody).stream, true);
    assert.deepEqual(partials, [
        { index: 0, base64: 'partial-one' },
        { index: 1, base64: 'partial-two' },
    ]);
    assert.equal(response.result.responseId, 'resp_123');
});
