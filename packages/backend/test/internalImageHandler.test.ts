/**
 * @description: Validates the trusted internal image task handler and its narrow task contract.
 * @footnote-scope: test
 * @footnote-module: InternalImageHandlerTests
 * @footnote-risk: medium - Missing tests could let trusted auth, task validation, or normalized image artifacts regress silently.
 * @footnote-ethics: medium - Confirms internal image execution stays narrow and predictable for bot-facing image workflows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import type {
    ImageGenerationRequest,
    ImageGenerationRuntime,
} from '@footnote/agent-runtime';
import type { BackendLLMCostRecord } from '../src/services/llmCostRecorder.js';
import { createInternalImageHandler } from '../src/handlers/internalImage.js';
import { createInternalImageTaskService } from '../src/services/internalImage.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';

type TestServer = {
    url: string;
    close: () => Promise<void>;
};

const createImageRequestPayload = () => ({
    task: 'generate' as const,
    prompt: 'draw a reflective skyline',
    textModel: 'gpt-5-mini' as const,
    imageModel: 'gpt-image-1-mini' as const,
    size: '1024x1024' as const,
    quality: 'medium' as const,
    background: 'auto' as const,
    style: 'vivid',
    allowPromptAdjustment: true,
    outputFormat: 'png' as const,
    outputCompression: 100,
    user: {
        username: 'Jordan',
        nickname: 'Jordan',
        guildName: 'Footnote Lab',
    },
    followUpResponseId: 'resp_prev_123',
    channelContext: {
        channelId: '123',
        guildId: '456',
    },
});

const createInternalImageServer = async (
    imageGenerationRuntime: ImageGenerationRuntime | null,
    options: { serviceRateLimiter?: SimpleRateLimiter } = {}
): Promise<TestServer> => {
    const internalImageTaskService = imageGenerationRuntime
        ? createInternalImageTaskService({
              imageGenerationRuntime,
              recordUsage: () => undefined,
          })
        : null;
    const handler = createInternalImageHandler({
        internalImageTaskService,
        logRequest: () => undefined,
        maxBodyBytes: 50_000,
        traceApiToken: 'trace-secret',
        serviceToken: null,
        serviceRateLimiter:
            options.serviceRateLimiter ??
            new SimpleRateLimiter({
                limit: 20,
                window: 60_000,
            }),
    });

    const server = http.createServer((req, res) => {
        if ((req.url ?? '') === '/api/internal/image') {
            void handler.handleInternalImageRequest(req, res);
            return;
        }

        res.statusCode = 404;
        res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            }),
    };
};

test('internal image endpoint accepts trusted generate tasks and returns normalized artifacts', async () => {
    let seenRequest: ImageGenerationRequest | undefined;
    const imageGenerationRuntime: ImageGenerationRuntime = {
        kind: 'test-image-runtime',
        async generateImage(request) {
            seenRequest = request;
            return {
                responseId: 'resp_123',
                textModel: request.textModel,
                imageModel: request.imageModel,
                revisedPrompt: 'draw a reflective skyline at dusk',
                finalStyle: 'vivid',
                annotations: {
                    title: 'Reflective Skyline',
                    description: 'A city scene at dusk.',
                    note: 'The skyline emphasizes calm light.',
                    adjustedPrompt: 'draw a reflective skyline at dusk',
                },
                finalImageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
                outputFormat: request.outputFormat,
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
            };
        },
    };
    const server = await createInternalImageServer(imageGenerationRuntime);

    try {
        const response = await fetch(`${server.url}/api/internal/image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify(createImageRequestPayload()),
        });

        assert.equal(response.status, 200);
        assert.equal(seenRequest?.followUpResponseId, 'resp_prev_123');
        assert.match(seenRequest?.systemPrompt ?? '', /Footnote/);
        assert.match(
            seenRequest?.developerPrompt ?? '',
            /Discord `\/image` command/
        );
        const payload = (await response.json()) as {
            task: string;
            result: { responseId: string | null; finalImageBase64: string };
        };
        assert.equal(payload.task, 'generate');
        assert.equal(payload.result.responseId, 'resp_123');
        assert.equal(
            payload.result.finalImageBase64,
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
        );
    } finally {
        await server.close();
    }
});

test('internal image endpoint streams partial previews and one terminal result when requested', async () => {
    const imageGenerationRuntime: ImageGenerationRuntime = {
        kind: 'test-image-runtime',
        async generateImage(request) {
            await request.onPartialImage?.({
                index: 0,
                base64: 'partial-one',
            });
            await request.onPartialImage?.({
                index: 1,
                base64: 'partial-two',
            });

            return {
                responseId: 'resp_stream_123',
                textModel: request.textModel,
                imageModel: request.imageModel,
                revisedPrompt: null,
                finalStyle: request.style,
                annotations: {
                    title: null,
                    description: null,
                    note: null,
                    adjustedPrompt: null,
                },
                finalImageBase64: 'final-base64-image',
                outputFormat: request.outputFormat,
                outputCompression: request.outputCompression,
                usage: {
                    inputTokens: 7,
                    outputTokens: 3,
                    totalTokens: 10,
                    imageCount: 1,
                },
                costs: {
                    text: 0.00001,
                    image: 0.011,
                    total: 0.01101,
                    perImage: 0.011,
                },
                generationTimeMs: 55,
            };
        },
    };
    const server = await createInternalImageServer(imageGenerationRuntime);

    try {
        const response = await fetch(`${server.url}/api/internal/image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                ...createImageRequestPayload(),
                stream: true,
            }),
        });

        assert.equal(response.status, 200);
        assert.equal(
            response.headers.get('content-type'),
            'application/x-ndjson; charset=utf-8'
        );

        const payload = (await response.text())
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { type: string });

        assert.deepEqual(
            payload.map((event) => event.type),
            ['partial_image', 'partial_image', 'result']
        );
        assert.equal(
            (
                payload[2] as unknown as {
                    result: { finalImageBase64: string };
                }
            ).result.finalImageBase64,
            'final-base64-image'
        );
    } finally {
        await server.close();
    }
});

test('internal image endpoint returns 429 when the trusted service limiter is exhausted', async () => {
    const server = await createInternalImageServer(
        {
            kind: 'test-image-runtime',
            async generateImage(request) {
                return {
                    responseId: 'resp_123',
                    textModel: request.textModel,
                    imageModel: request.imageModel,
                    revisedPrompt: null,
                    finalStyle: request.style,
                    annotations: {
                        title: null,
                        description: null,
                        note: null,
                        adjustedPrompt: null,
                    },
                    finalImageBase64: 'base64-image',
                    outputFormat: request.outputFormat,
                    outputCompression: request.outputCompression,
                    usage: {
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 2,
                        imageCount: 1,
                    },
                    costs: {
                        text: 0,
                        image: 0.011,
                        total: 0.011,
                        perImage: 0.011,
                    },
                    generationTimeMs: 1,
                };
            },
        },
        {
            serviceRateLimiter: new SimpleRateLimiter({
                limit: 1,
                window: 60_000,
            }),
        }
    );

    try {
        const request = () =>
            fetch(`${server.url}/api/internal/image`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-secret',
                },
                body: JSON.stringify(createImageRequestPayload()),
            });

        const firstResponse = await request();
        assert.equal(firstResponse.status, 200);

        const secondResponse = await request();
        assert.equal(secondResponse.status, 429);
        assert.equal(secondResponse.headers.get('retry-after'), '60');
    } finally {
        await server.close();
    }
});

test('internal image endpoint rejects missing trusted auth', async () => {
    const server = await createInternalImageServer({
        kind: 'test-image-runtime',
        async generateImage() {
            throw new Error('should not be called');
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(createImageRequestPayload()),
        });

        assert.equal(response.status, 401);
    } finally {
        await server.close();
    }
});

test('internal image task service rejects unsupported runtime model identifiers', async () => {
    const service = createInternalImageTaskService({
        imageGenerationRuntime: {
            kind: 'test-image-runtime',
            async generateImage(request) {
                return {
                    responseId: 'resp_123',
                    textModel: 'future-text-model' as ImageGenerationRequest['textModel'],
                    imageModel:
                        'future-image-model' as ImageGenerationRequest['imageModel'],
                    revisedPrompt: null,
                    finalStyle: request.style,
                    annotations: {
                        title: null,
                        description: null,
                        note: null,
                        adjustedPrompt: null,
                    },
                    finalImageBase64: 'base64-image',
                    outputFormat: request.outputFormat,
                    outputCompression: request.outputCompression,
                    usage: {
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 2,
                        imageCount: 1,
                    },
                    costs: {
                        text: 0,
                        image: 0.011,
                        total: 0.011,
                        perImage: 0.011,
                    },
                    generationTimeMs: 1,
                };
            },
        },
        recordUsage: () => undefined,
    });

    await assert.rejects(
        () => service.runImageTask(createImageRequestPayload()),
        /unsupported textModel/i
    );
});

test('internal image endpoint rejects invalid task payloads', async () => {
    const server = await createInternalImageServer({
        kind: 'test-image-runtime',
        async generateImage() {
            throw new Error('should not be called');
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                ...createImageRequestPayload(),
                outputCompression: 101,
            }),
        });

        assert.equal(response.status, 400);
    } finally {
        await server.close();
    }
});

test('internal image endpoint returns 503 when the internal image task service is unavailable', async () => {
    const server = await createInternalImageServer(null);

    try {
        const response = await fetch(`${server.url}/api/internal/image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify(createImageRequestPayload()),
        });

        assert.equal(response.status, 503);
    } finally {
        await server.close();
    }
});

test('internal image task service records usage after successful runtime execution', async () => {
    const recordedUsage: BackendLLMCostRecord[] = [];
    const service = createInternalImageTaskService({
        imageGenerationRuntime: {
            kind: 'test-image-runtime',
            async generateImage(request) {
                return {
                    responseId: 'resp_123',
                    textModel: request.textModel,
                    imageModel: request.imageModel,
                    revisedPrompt: null,
                    finalStyle: request.style,
                    annotations: {
                        title: null,
                        description: null,
                        note: null,
                        adjustedPrompt: null,
                    },
                    finalImageBase64: 'base64-image',
                    outputFormat: request.outputFormat,
                    outputCompression: request.outputCompression,
                    usage: {
                        inputTokens: 12,
                        outputTokens: 8,
                        totalTokens: 20,
                        imageCount: 1,
                    },
                    costs: {
                        text: 0.00002,
                        image: 0.011,
                        total: 0.01102,
                        perImage: 0.011,
                    },
                    generationTimeMs: 2,
                };
            },
        },
        recordUsage: (record) => {
            recordedUsage.push(record);
        },
    });

    const response = await service.runImageTask(createImageRequestPayload());

    assert.equal(recordedUsage.length, 1);
    const usageRecord = recordedUsage[0];
    assert.ok(usageRecord);
    assert.equal(typeof usageRecord.timestamp, 'number');
    assert.deepEqual(usageRecord, {
        feature: 'image',
        model: 'gpt-image-1-mini',
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
        inputCostUsd: 0.00002,
        outputCostUsd: 0.011,
        totalCostUsd: 0.01102,
        timestamp: usageRecord.timestamp,
    });
    assert.equal(response.result.responseId, 'resp_123');
});
