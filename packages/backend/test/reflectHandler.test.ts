/**
 * @description: Validates trusted-service auth and public CAPTCHA enforcement for /api/reflect.
 * @footnote-scope: test
 * @footnote-module: ReflectHandlerTests
 * @footnote-risk: medium - Missing tests could let internal auth bypass or public auth regress silently.
 * @footnote-ethics: medium - Reflect auth controls abuse prevention and trusted service access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { createReflectHandler } from '../src/handlers/reflect.js';
import type { OpenAIService } from '../src/services/openaiService.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';

type MutableEnv = NodeJS.ProcessEnv & {
    TURNSTILE_SECRET_KEY?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_ALLOWED_HOSTNAMES?: string;
    TRACE_API_TOKEN?: string;
    REFLECT_SERVICE_TOKEN?: string;
    REFLECT_SERVICE_RATE_LIMIT?: string;
    REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS?: string;
};

type TestServer = {
    close: () => Promise<void>;
    url: string;
};

type CreateTestServerOptions = {
    openaiService?: OpenAIService;
    ipRateLimiter?: SimpleRateLimiter;
    sessionRateLimiter?: SimpleRateLimiter;
    serviceRateLimiter?: SimpleRateLimiter;
    logRequest?: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        extra?: string
    ) => void;
};

const createMetadata = (): ResponseMetadata => ({
    responseId: 'reflect_test_response',
    provenance: 'Inferred',
    confidence: 0.5,
    riskTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'abc123def456',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
});

const createTestServer = (
    options: CreateTestServerOptions = {}
): Promise<TestServer> =>
    new Promise((resolve) => {
        const serviceRateLimit = Number.parseInt(
            process.env.REFLECT_SERVICE_RATE_LIMIT || '30',
            10
        );
        const serviceRateLimitWindowMs = Number.parseInt(
            process.env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS || '60000',
            10
        );
        const defaultOpenaiService: OpenAIService = {
            async generateResponse() {
                return {
                    normalizedText: 'service response',
                    metadata: {
                        model: 'gpt-5-mini',
                        confidence: 0.5,
                        provenance: 'Inferred',
                        tradeoffCount: 0,
                        citations: [],
                    },
                };
            },
        };
        const openaiService = options.openaiService ?? defaultOpenaiService;

        const handler = createReflectHandler({
            openaiService,
            ipRateLimiter:
                options.ipRateLimiter ??
                new SimpleRateLimiter({ limit: 5, window: 60000 }),
            sessionRateLimiter:
                options.sessionRateLimiter ??
                new SimpleRateLimiter({
                    limit: 5,
                    window: 60000,
                }),
            serviceRateLimiter:
                options.serviceRateLimiter ??
                new SimpleRateLimiter({
                    limit: serviceRateLimit,
                    window: serviceRateLimitWindowMs,
                }),
            storeTrace: async () => undefined,
            logRequest: options.logRequest ?? (() => undefined),
            buildResponseMetadata: () => createMetadata(),
            maxReflectBodyBytes: 20000,
        });

        const server = http.createServer((req, res) => {
            void handler(req, res);
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            assert.ok(address && typeof address === 'object');
            resolve({
                url: `http://127.0.0.1:${address.port}`,
                close: () =>
                    new Promise((closeResolve, closeReject) => {
                        server.close((error) => {
                            if (error) {
                                closeReject(error);
                                return;
                            }
                            closeResolve();
                        });
                    }),
            });
        });
    });

test('reflect accepts trusted service calls with x-trace-token and no turnstile token', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({ question: 'What changed?' }),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            message: string;
            metadata: ResponseMetadata;
        };
        assert.equal(payload.message, 'service response');
        assert.equal(payload.metadata.responseId, 'reflect_test_response');
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('reflect rejects public calls without service token or turnstile token', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ question: 'What changed?' }),
        });

        assert.equal(response.status, 403);
        const payload = (await response.json()) as {
            error: string;
            details: string;
        };
        assert.equal(payload.error, 'CAPTCHA verification failed');
        assert.equal(payload.details, 'Missing turnstile token');
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('reflect service requests use a separate service rate limiter bucket', async () => {
    const env = process.env as MutableEnv;
    const previousServiceToken = env.REFLECT_SERVICE_TOKEN;
    const previousServiceLimit = env.REFLECT_SERVICE_RATE_LIMIT;
    const previousServiceWindow = env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.REFLECT_SERVICE_TOKEN = 'service-secret';
    env.REFLECT_SERVICE_RATE_LIMIT = '1';
    env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS = '60000';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer();

    try {
        const firstResponse = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
            },
            body: JSON.stringify({ question: 'first request' }),
        });
        assert.equal(firstResponse.status, 200);

        const secondResponse = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
            },
            body: JSON.stringify({ question: 'second request' }),
        });
        assert.equal(secondResponse.status, 429);
        const payload = (await secondResponse.json()) as {
            error: string;
        };
        assert.equal(payload.error, 'Too many requests from this service');
    } finally {
        await server.close();
        env.REFLECT_SERVICE_TOKEN = previousServiceToken;
        env.REFLECT_SERVICE_RATE_LIMIT = previousServiceLimit;
        env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS = previousServiceWindow;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('reflect trusted service requests stay in one bucket even if client IP changes', async () => {
    const env = process.env as MutableEnv;
    const previousServiceToken = env.REFLECT_SERVICE_TOKEN;
    const previousServiceLimit = env.REFLECT_SERVICE_RATE_LIMIT;
    const previousServiceWindow = env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;
    const previousTrustProxy = process.env.WEB_TRUST_PROXY;

    env.REFLECT_SERVICE_TOKEN = 'service-secret';
    env.REFLECT_SERVICE_RATE_LIMIT = '1';
    env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS = '60000';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';
    process.env.WEB_TRUST_PROXY = 'true';

    const server = await createTestServer();

    try {
        const firstResponse = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
                'X-Forwarded-For': '203.0.113.10',
            },
            body: JSON.stringify({ question: 'first request' }),
        });
        assert.equal(firstResponse.status, 200);

        const secondResponse = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
                'X-Forwarded-For': '203.0.113.99',
            },
            body: JSON.stringify({ question: 'second request' }),
        });
        assert.equal(secondResponse.status, 429);
        const payload = (await secondResponse.json()) as {
            error: string;
        };
        assert.equal(payload.error, 'Too many requests from this service');
    } finally {
        await server.close();
        env.REFLECT_SERVICE_TOKEN = previousServiceToken;
        env.REFLECT_SERVICE_RATE_LIMIT = previousServiceLimit;
        env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS = previousServiceWindow;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
        process.env.WEB_TRUST_PROXY = previousTrustProxy;
    }
});

test('reflect does not expose raw upstream error details to clients', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;
    const loggedEvents: string[] = [];

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer({
        openaiService: {
            async generateResponse() {
                throw new Error('OpenAI upstream leaked diagnostic details');
            },
        },
        logRequest: (_req, _res, extra) => {
            if (extra) {
                loggedEvents.push(extra);
            }
        },
    });

    try {
        const response = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({ question: 'What changed?' }),
        });

        assert.equal(response.status, 502);
        const payload = (await response.json()) as {
            error: string;
            details?: string;
        };
        assert.deepEqual(payload, {
            error: 'AI generation failed',
        });
        assert.ok(
            loggedEvents.some((entry) =>
                entry.includes('OpenAI upstream leaked diagnostic details')
            )
        );
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('reflect rate limits public callers before calling Turnstile', async () => {
    const env = process.env as MutableEnv;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;
    const previousAllowedHostnames = env.TURNSTILE_ALLOWED_HOSTNAMES;
    const originalFetch = globalThis.fetch;
    let turnstileCalls = 0;

    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';
    env.TURNSTILE_ALLOWED_HOSTNAMES = '127.0.0.1';

    globalThis.fetch = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
            turnstileCalls += 1;
            return new Response(
                JSON.stringify({
                    success: true,
                    hostname: '127.0.0.1',
                    'challenge-ts': new Date().toISOString(),
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );
        }

        return originalFetch(input, init);
    }) as typeof fetch;

    const server = await createTestServer({
        ipRateLimiter: new SimpleRateLimiter({ limit: 1, window: 60000 }),
        sessionRateLimiter: new SimpleRateLimiter({ limit: 5, window: 60000 }),
    });

    try {
        const firstResponse = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Turnstile-Token': 'captcha-token',
            },
            body: JSON.stringify({ question: 'first public request' }),
        });
        assert.equal(firstResponse.status, 200);
        assert.equal(turnstileCalls, 1);

        const secondResponse = await fetch(`${server.url}/api/reflect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Turnstile-Token': 'captcha-token',
            },
            body: JSON.stringify({ question: 'second public request' }),
        });
        assert.equal(secondResponse.status, 429);
        assert.equal(turnstileCalls, 1);
    } finally {
        globalThis.fetch = originalFetch;
        await server.close();
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
        env.TURNSTILE_ALLOWED_HOSTNAMES = previousAllowedHostnames;
    }
});
