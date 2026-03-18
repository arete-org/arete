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

import type { GenerationRequest, GenerationRuntime } from '@footnote/agent-runtime';
import { createInternalTextHandler } from '../src/handlers/internalText.js';
import { createInternalNewsTaskService } from '../src/services/internalText.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';

type TestServer = {
    url: string;
    close: () => Promise<void>;
};

const createInternalTextServer = async (
    generationRuntime: GenerationRuntime | null,
    options: { serviceRateLimiter?: SimpleRateLimiter } = {}
): Promise<TestServer> => {
    const internalNewsTaskService = generationRuntime
        ? createInternalNewsTaskService({
              generationRuntime,
              defaultModel: 'gpt-5-mini',
              recordUsage: () => undefined,
          })
        : null;
    const handler = createInternalTextHandler({
        internalNewsTaskService,
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
