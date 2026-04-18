/**
 * @description: Validates the trusted internal text task handler and its narrow task contract.
 * @footnote-scope: test
 * @footnote-module: InternalTextHandlerTests
 * @footnote-risk: medium - Missing tests could let trusted auth, task validation, or structured response parsing regress silently.
 * @footnote-ethics: medium - Confirms internal task execution stays narrow and predictable for bot-facing text workflows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import type {
    GenerationRequest,
    GenerationRuntime,
} from '@footnote/agent-runtime';
import { createInternalTextHandler } from '../src/handlers/internalText.js';
import {
    createInternalNewsTaskService,
    type InternalImageDescriptionTaskService,
    type InternalNewsTaskService,
} from '../src/services/internalText.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';

type TestServer = {
    url: string;
    close: () => Promise<void>;
};

const createInternalTextServer = async (
    generationRuntime: GenerationRuntime | null,
    options: {
        serviceRateLimiter?: SimpleRateLimiter;
        internalNewsTaskService?: InternalNewsTaskService | null;
        internalImageDescriptionTaskService?: InternalImageDescriptionTaskService | null;
    } = {}
): Promise<TestServer> => {
    const internalNewsTaskService =
        options.internalNewsTaskService !== undefined
            ? options.internalNewsTaskService
            : generationRuntime
              ? createInternalNewsTaskService({
                    generationRuntime,
                    defaultModel: 'gpt-5-mini',
                    recordUsage: () => undefined,
                })
              : null;
    const internalImageDescriptionTaskService =
        options.internalImageDescriptionTaskService !== undefined
            ? options.internalImageDescriptionTaskService
            : generationRuntime
              ? {
                    async runImageDescriptionTask() {
                        return {
                            task: 'image_description' as const,
                            result: {
                                description:
                                    '{"summary":"Screenshot of a policy update"}',
                                model: 'gpt-4o-mini',
                                usage: {
                                    inputTokens: 10,
                                    outputTokens: 5,
                                    totalTokens: 15,
                                },
                                costs: {
                                    input: 0.0000015,
                                    output: 0.000003,
                                    total: 0.0000045,
                                },
                            },
                        };
                    },
                }
              : null;
    const handler = createInternalTextHandler({
        internalNewsTaskService,
        internalImageDescriptionTaskService,
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
        if ((req.url ?? '') === '/api/internal/text') {
            void handler.handleInternalTextRequest(req, res);
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

test('internal text endpoint accepts trusted news tasks and returns structured results', async () => {
    let seenRequest: GenerationRequest | undefined;
    const generationRuntime: GenerationRuntime = {
        kind: 'test-runtime',
        async generate(request) {
            seenRequest = request;
            return {
                text: JSON.stringify({
                    news: [
                        {
                            title: 'Policy update',
                            summary: 'A concise summary',
                            url: 'https://example.com/news',
                            source: 'Example News',
                            timestamp: '2026-03-18T12:00:00.000Z',
                        },
                    ],
                    summary: 'One important headline today.',
                }),
                model: 'gpt-5-mini',
                usage: {
                    promptTokens: 10,
                    completionTokens: 5,
                    totalTokens: 15,
                },
                provenance: 'Retrieved',
                citations: [],
            };
        },
    };
    const server = await createInternalTextServer(generationRuntime);

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'news',
                query: 'latest ai policy',
                maxResults: 2,
            }),
        });

        assert.equal(response.status, 200);
        assert.equal(seenRequest?.search?.query, 'latest ai policy');
        assert.equal(seenRequest?.search?.intent, 'current_facts');
        const payload = (await response.json()) as {
            task: string;
            result: { news: Array<{ title: string }>; summary: string };
        };
        assert.equal(payload.task, 'news');
        assert.equal(payload.result.news[0]?.title, 'Policy update');
        assert.equal(payload.result.summary, 'One important headline today.');
    } finally {
        await server.close();
    }
});

test('internal text endpoint accepts trusted image-description tasks and returns structured results', async () => {
    const server = await createInternalTextServer({
        kind: 'test-runtime',
        async generate() {
            throw new Error(
                'news runtime should not be called for image_description'
            );
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'image_description',
                imageUrl: 'https://example.com/image.png',
                context: 'User asked what changed in this screenshot.',
                channelContext: {
                    channelId: 'channel-1',
                    guildId: 'guild-1',
                },
            }),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            task: string;
            result: {
                description: string;
                model: string;
                usage: { totalTokens: number };
            };
        };
        assert.equal(payload.task, 'image_description');
        assert.match(
            payload.result.description,
            /Screenshot of a policy update/
        );
        assert.equal(payload.result.model, 'gpt-4o-mini');
        assert.equal(payload.result.usage.totalTokens, 15);
    } finally {
        await server.close();
    }
});

test('internal text endpoint returns 429 when the trusted service limiter is exhausted', async () => {
    const server = await createInternalTextServer(
        {
            kind: 'test-runtime',
            async generate() {
                return {
                    text: JSON.stringify({
                        news: [],
                        summary: 'No updates.',
                    }),
                    model: 'gpt-5-mini',
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
            fetch(`${server.url}/api/internal/text`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-secret',
                },
                body: JSON.stringify({
                    task: 'news',
                    query: 'latest ai policy',
                }),
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

test('internal text endpoint rejects missing trusted auth', async () => {
    const server = await createInternalTextServer({
        kind: 'test-runtime',
        async generate() {
            return {
                text: '{}',
            };
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                task: 'news',
            }),
        });

        assert.equal(response.status, 401);
    } finally {
        await server.close();
    }
});

test('internal text endpoint rejects GET requests with 405', async () => {
    const server = await createInternalTextServer({
        kind: 'test-runtime',
        async generate() {
            throw new Error('should not be called');
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'GET',
            headers: {
                'X-Trace-Token': 'trace-secret',
            },
        });

        assert.equal(response.status, 405);
    } finally {
        await server.close();
    }
});

test('internal text endpoint returns 503 when the internal news task service is unavailable', async () => {
    const server = await createInternalTextServer(null);

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'news',
                query: 'latest ai policy',
            }),
        });

        assert.equal(response.status, 503);
        const payload = (await response.json()) as {
            error: string;
            details?: string;
        };
        assert.equal(
            payload.error,
            'Internal text generation provider unavailable'
        );
        assert.equal(payload.details, 'provider_unavailable');
    } finally {
        await server.close();
    }
});

test('internal text endpoint still serves image-description tasks when the news service is unavailable', async () => {
    const server = await createInternalTextServer(null, {
        internalImageDescriptionTaskService: {
            async runImageDescriptionTask() {
                return {
                    task: 'image_description',
                    result: {
                        description:
                            '{"summary":"Screenshot of a policy update"}',
                        model: 'gpt-4o-mini',
                        usage: {
                            inputTokens: 10,
                            outputTokens: 5,
                            totalTokens: 15,
                        },
                        costs: {
                            input: 0.0000015,
                            output: 0.000003,
                            total: 0.0000045,
                        },
                    },
                };
            },
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'image_description',
                imageUrl: 'https://example.com/image.png',
            }),
        });

        assert.equal(response.status, 200);
    } finally {
        await server.close();
    }
});

test('internal text endpoint returns 503 for image-description tasks when only the news service is available', async () => {
    const server = await createInternalTextServer(
        {
            kind: 'test-runtime',
            async generate() {
                return {
                    text: JSON.stringify({
                        news: [],
                        summary: 'No updates.',
                    }),
                    model: 'gpt-5-mini',
                };
            },
        },
        {
            internalImageDescriptionTaskService: null,
        }
    );

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'image_description',
                imageUrl: 'https://example.com/image.png',
            }),
        });

        assert.equal(response.status, 503);
        const payload = (await response.json()) as {
            error: string;
            details?: string;
        };
        assert.equal(
            payload.error,
            'Internal image-description provider unavailable'
        );
        assert.equal(payload.details, 'provider_unavailable');
    } finally {
        await server.close();
    }
});

test('internal text endpoint rejects invalid task payloads', async () => {
    const server = await createInternalTextServer({
        kind: 'test-runtime',
        async generate() {
            throw new Error('should not be called');
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'news',
                maxResults: 9,
            }),
        });

        assert.equal(response.status, 400);

        const imageDescriptionResponse = await fetch(
            `${server.url}/api/internal/text`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-secret',
                },
                body: JSON.stringify({
                    task: 'image_description',
                    imageUrl: 'not-a-url',
                }),
            }
        );

        assert.equal(imageDescriptionResponse.status, 400);
    } finally {
        await server.close();
    }
});

test('internal text endpoint returns 502 when the runtime output is not valid structured JSON', async () => {
    const server = await createInternalTextServer({
        kind: 'test-runtime',
        async generate() {
            return {
                text: 'not json',
                model: 'gpt-5-mini',
            };
        },
    });

    try {
        const response = await fetch(`${server.url}/api/internal/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'news',
                query: 'latest ai policy',
            }),
        });

        assert.equal(response.status, 502);
    } finally {
        await server.close();
    }
});

test('internal news task service records usage even when structured parsing fails', async () => {
    let recordedUsageCount = 0;
    const service = createInternalNewsTaskService({
        generationRuntime: {
            kind: 'test-runtime',
            async generate() {
                return {
                    text: 'not json',
                    model: 'gpt-5-mini',
                    usage: {
                        promptTokens: 12,
                        completionTokens: 8,
                        totalTokens: 20,
                    },
                };
            },
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => {
            recordedUsageCount += 1;
        },
    });

    await assert.rejects(
        () =>
            service.runNewsTask({
                task: 'news',
                query: 'latest ai policy',
            }),
        /invalid structured output|did not return a JSON object/i
    );

    assert.equal(recordedUsageCount, 1);
});

test('internal news task service preserves its descriptive JSON-object error when fallback parsing fails', async () => {
    const service = createInternalNewsTaskService({
        generationRuntime: {
            kind: 'test-runtime',
            async generate() {
                return {
                    text: 'Wrapped output: {"news": [}',
                    model: 'gpt-5-mini',
                };
            },
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    await assert.rejects(
        () =>
            service.runNewsTask({
                task: 'news',
                query: 'latest ai policy',
            }),
        /Internal text task did not return a JSON object\./i
    );
});

test('internal news task service keeps articles when timestamps are missing or malformed', async () => {
    const service = createInternalNewsTaskService({
        generationRuntime: {
            kind: 'test-runtime',
            async generate() {
                return {
                    text: JSON.stringify({
                        news: [
                            {
                                title: 'Policy update',
                                summary: 'A concise summary',
                                url: 'https://example.com/news-1',
                                source: 'Example News',
                                timestamp: '2026-03-18 23:48:53Z',
                            },
                            {
                                title: 'Bad timestamp item',
                                summary: 'This one should keep the article.',
                                url: 'https://example.com/news-2',
                                source: 'Example News',
                                timestamp: 'later tonight maybe',
                            },
                            {
                                title: 'Date-only item',
                                summary:
                                    'This one should omit the midnight placeholder.',
                                url: 'https://example.com/news-3',
                                source: 'Example News',
                                timestamp: '2026-03-18',
                            },
                        ],
                        summary:
                            'Articles remain even when publish time is fuzzy.',
                    }),
                    model: 'gpt-5-mini',
                };
            },
        },
        defaultModel: 'gpt-5-mini',
        recordUsage: () => undefined,
    });

    const response = await service.runNewsTask({
        task: 'news',
        query: 'latest ai policy',
    });

    assert.equal(response.result.news.length, 3);
    assert.equal(
        response.result.news[0]?.timestamp,
        '2026-03-18T23:48:53.000Z'
    );
    assert.equal('timestamp' in response.result.news[1]!, false);
    assert.equal('timestamp' in response.result.news[2]!, false);
    assert.equal(
        response.result.summary,
        'Articles remain even when publish time is fuzzy.'
    );
});
