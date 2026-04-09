/**
 * @description: Validates trusted-service auth and public CAPTCHA enforcement for /api/chat.
 * @footnote-scope: test
 * @footnote-module: ChatHandlerTests
 * @footnote-risk: medium - Missing tests could let internal auth bypass or public auth regress silently.
 * @footnote-ethics: medium - Chat auth controls abuse prevention and trusted service access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import type {
    GenerationRequest,
    GenerationRuntime,
} from '@footnote/agent-runtime';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type { PostChatRequest } from '@footnote/contracts/web';
import { createChatHandler } from '../src/handlers/chat.js';
import { runtimeConfig } from '../src/config.js';
import type { RuntimeConfig } from '../src/config/types.js';
import { parseBooleanEnv } from '../src/config/parsers.js';
import type { CreateChatServiceOptions } from '../src/services/chatService.js';
import {
    createScopeOwnershipValidatorFromTenancyService,
    resolveExecutionContractTrustGraphRuntimeOptions,
    StubTrustGraphEvidenceAdapter,
    TrustGraphOwnershipValidationPolicy,
} from '../src/services/executionContractTrustGraph/index.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';
import { logger } from '../src/utils/logger.js';

const TEST_PLANNER_MAX_COMPLETION_TOKENS = 700;

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
    generationRuntime?: GenerationRuntime;
    ipRateLimiter?: SimpleRateLimiter;
    sessionRateLimiter?: SimpleRateLimiter;
    serviceRateLimiter?: SimpleRateLimiter;
    executionContractTrustGraph?: CreateChatServiceOptions['executionContractTrustGraph'];
    logRequest?: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        extra?: string
    ) => void;
};

const TEST_TIMESTAMP = new Date('2026-04-04T00:00:00.000Z').toISOString();

const createExecutionContractTrustGraphRuntimeConfig = (
    overrides: Partial<RuntimeConfig['executionContractTrustGraph']> = {}
): RuntimeConfig['executionContractTrustGraph'] => {
    const { adapter, ownership, ...rest } = overrides;

    return {
        enabled: true,
        killSwitchExternalRetrieval: false,
        policyId: 'chat_handler_runtime_policy',
        timeoutMs: 100,
        maxCalls: 1,
        adapter: {
            mode: 'none',
            endpointUrl: null,
            apiToken: null,
            configRef: null,
            stubMode: 'success',
            ...(adapter ?? {}),
        },
        ownership: {
            bindingMode: 'none',
            validatorId: 'backend_tenancy_http_v1',
            endpointUrl: null,
            apiToken: null,
            ...(ownership ?? {}),
        },
        ...rest,
    };
};

const createMetadata = (): ResponseMetadata => ({
    responseId: 'chat_test_response',
    provenance: 'Inferred',
    safetyTier: 'Low',
    tradeoffCount: 0,
    chainHash: 'abc123def456',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
});

const createChatRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'What changed?',
    conversation: [
        {
            role: 'user',
            content: 'What changed?',
        },
    ],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

const createTestServer = (
    options: CreateTestServerOptions = {}
): Promise<TestServer> =>
    new Promise((resolve) => {
        // Keep tests deterministic when they mutate process.env after runtimeConfig
        // has already been initialized at import time.
        const mutableRuntimeConfig = runtimeConfig as typeof runtimeConfig;
        mutableRuntimeConfig.trace.apiToken =
            process.env.TRACE_API_TOKEN?.trim() || null;
        mutableRuntimeConfig.reflect.serviceToken =
            process.env.REFLECT_SERVICE_TOKEN?.trim() || null;
        mutableRuntimeConfig.turnstile.secretKey =
            process.env.TURNSTILE_SECRET_KEY?.trim() || null;
        mutableRuntimeConfig.turnstile.siteKey =
            process.env.TURNSTILE_SITE_KEY?.trim() || null;
        mutableRuntimeConfig.turnstile.allowedHostnames = (
            process.env.TURNSTILE_ALLOWED_HOSTNAMES || ''
        )
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
        mutableRuntimeConfig.server.trustProxy = parseBooleanEnv(
            process.env.WEB_TRUST_PROXY,
            false
        );

        const serviceRateLimit = Number.parseInt(
            process.env.REFLECT_SERVICE_RATE_LIMIT || '30',
            10
        );
        const serviceRateLimitWindowMs = Number.parseInt(
            process.env.REFLECT_SERVICE_RATE_LIMIT_WINDOW_MS || '60000',
            10
        );
        const generationRuntime =
            options.generationRuntime ??
            ({
                kind: 'test-runtime',
                async generate(request: GenerationRequest) {
                    if (
                        request.maxOutputTokens ===
                        TEST_PLANNER_MAX_COMPLETION_TOKENS
                    ) {
                        return {
                            text: '{"action":"message","modality":"text","safetyTier":"Low","reasoning":"The request expects a reply.","generation":{"reasoningEffort":"low","verbosity":"low","temperament":{"tightness":4,"rationale":3,"attribution":4,"caution":3,"extent":4}}}',
                            model: 'gpt-5-mini',
                        };
                    }

                    return {
                        text: 'service response',
                        model: 'gpt-5-mini',
                        provenance: 'Inferred',
                        citations: [],
                    };
                },
            } satisfies GenerationRuntime);

        const handler = createChatHandler({
            generationRuntime,
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
            maxChatBodyBytes: 20000,
            executionContractTrustGraph: options.executionContractTrustGraph,
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

test('chat accepts trusted service calls with x-trace-token and no turnstile token', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify(createChatRequest()),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            action: string;
            message: string;
            modality: string;
            metadata: ResponseMetadata;
        };
        assert.equal(payload.action, 'message');
        assert.equal(payload.message, 'service response');
        assert.equal(payload.metadata.responseId, 'chat_test_response');
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('chat rejects public calls without service token or turnstile token', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(createChatRequest()),
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

test('chat constrains web requests to message actions', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify(
                createChatRequest({
                    surface: 'web',
                    trigger: { kind: 'submit' },
                    capabilities: {
                        canReact: false,
                        canGenerateImages: false,
                        canUseTts: false,
                    },
                })
            ),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            action: string;
            metadata: ResponseMetadata;
        };
        assert.equal(payload.action, 'message');
        assert.equal(payload.metadata.responseId, 'chat_test_response');
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('chat service requests use a separate service rate limiter bucket', async () => {
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
        const firstResponse = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
            },
            body: JSON.stringify(
                createChatRequest({
                    latestUserInput: 'first request',
                    conversation: [{ role: 'user', content: 'first request' }],
                })
            ),
        });
        assert.equal(firstResponse.status, 200);

        const secondResponse = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
            },
            body: JSON.stringify(
                createChatRequest({
                    latestUserInput: 'second request',
                    conversation: [{ role: 'user', content: 'second request' }],
                })
            ),
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

test('chat trusted service requests stay in one bucket even if client IP changes', async () => {
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
        const firstResponse = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
                'X-Forwarded-For': '203.0.113.10',
            },
            body: JSON.stringify(
                createChatRequest({
                    latestUserInput: 'first request',
                    conversation: [{ role: 'user', content: 'first request' }],
                })
            ),
        });
        assert.equal(firstResponse.status, 200);

        const secondResponse = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
                'X-Forwarded-For': '203.0.113.99',
            },
            body: JSON.stringify(
                createChatRequest({
                    latestUserInput: 'second request',
                    conversation: [{ role: 'user', content: 'second request' }],
                })
            ),
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

test('chat does not expose raw upstream error details to clients', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;
    const loggedEvents: string[] = [];

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const server = await createTestServer({
        generationRuntime: {
            kind: 'test-runtime',
            async generate() {
                throw new Error('VoltAgent upstream leaked diagnostic details');
            },
        },
        logRequest: (_req, _res, extra) => {
            if (extra) {
                loggedEvents.push(extra);
            }
        },
    });

    try {
        const response = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify(createChatRequest()),
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
                entry.includes('VoltAgent upstream leaked diagnostic details')
            )
        );
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('chat accepts public calls when allowlist is unset and Turnstile hostname matches the request host', async () => {
    const env = process.env as MutableEnv;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;
    const previousAllowedHostnames = env.TURNSTILE_ALLOWED_HOSTNAMES;
    const originalFetch = globalThis.fetch;

    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';
    delete env.TURNSTILE_ALLOWED_HOSTNAMES;

    globalThis.fetch = (async (input, init) => {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
        if (
            url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
        ) {
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

    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Turnstile-Token': 'captcha-token',
            },
            body: JSON.stringify(
                createChatRequest({
                    surface: 'web',
                    trigger: { kind: 'submit' },
                    latestUserInput: 'public request',
                    conversation: [{ role: 'user', content: 'public request' }],
                    capabilities: {
                        canReact: false,
                        canGenerateImages: false,
                        canUseTts: false,
                    },
                })
            ),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            action: string;
            message: string;
        };
        assert.equal(payload.action, 'message');
        assert.equal(payload.message, 'service response');
    } finally {
        globalThis.fetch = originalFetch;
        await server.close();
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
        env.TURNSTILE_ALLOWED_HOSTNAMES = previousAllowedHostnames;
    }
});

test('chat rate limits public callers before calling Turnstile', async () => {
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
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
        if (
            url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
        ) {
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
        const firstResponse = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Turnstile-Token': 'captcha-token',
            },
            body: JSON.stringify(
                createChatRequest({
                    surface: 'web',
                    trigger: { kind: 'submit' },
                    latestUserInput: 'first public request',
                    conversation: [
                        { role: 'user', content: 'first public request' },
                    ],
                    capabilities: {
                        canReact: false,
                        canGenerateImages: false,
                        canUseTts: false,
                    },
                })
            ),
        });
        assert.equal(firstResponse.status, 200);
        assert.equal(turnstileCalls, 1);

        const secondResponse = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Turnstile-Token': 'captcha-token',
            },
            body: JSON.stringify(
                createChatRequest({
                    surface: 'web',
                    trigger: { kind: 'submit' },
                    latestUserInput: 'second public request',
                    conversation: [
                        { role: 'user', content: 'second public request' },
                    ],
                    capabilities: {
                        canReact: false,
                        canGenerateImages: false,
                        canUseTts: false,
                    },
                })
            ),
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

test('chat runtime path includes advisory TrustGraph metadata when configured', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });
    const server = await createTestServer({
        executionContractTrustGraph: {
            adapter: new StubTrustGraphEvidenceAdapter('success'),
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy:
                TrustGraphOwnershipValidationPolicy.required({
                    policyId: 'chat_handler_runtime_policy',
                }),
            scopeOwnershipValidator,
        },
    });

    try {
        const response = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify(
                createChatRequest({
                    surfaceContext: {
                        userId: 'user_1',
                        channelId: 'project_1',
                    },
                })
            ),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            action: string;
            message: string;
            metadata: ResponseMetadata & {
                trustGraph?: {
                    adapterStatus?: string;
                    terminalAuthority?: string;
                    failOpenBehavior?: string;
                    verificationRequired?: boolean;
                    scopeValidation?: {
                        ok?: boolean;
                        normalizedScope?: {
                            userId?: string;
                            projectId?: string;
                        };
                    };
                    adapterBundle?: unknown;
                    provenanceJoin?: { externalEvidenceBundleId?: string };
                };
            };
        };
        assert.equal(payload.action, 'message');
        assert.equal(payload.message, 'service response');
        assert.equal(payload.metadata.trustGraph?.adapterStatus, 'success');
        assert.equal(
            payload.metadata.trustGraph?.terminalAuthority,
            'backend_execution_contract'
        );
        assert.equal(
            payload.metadata.trustGraph?.failOpenBehavior,
            'local_behavior'
        );
        assert.equal(payload.metadata.trustGraph?.verificationRequired, true);
        assert.deepEqual(payload.metadata.trustGraph?.scopeValidation, {
            ok: true,
            normalizedScope: {
                userId: '[redacted]',
                projectId: '[redacted]',
            },
        });
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                payload.metadata.trustGraph ?? {},
                'adapterBundle'
            ),
            false
        );
        assert.ok(
            typeof payload.metadata.trustGraph?.provenanceJoin
                ?.externalEvidenceBundleId === 'string'
        );
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                payload.metadata.trustGraph?.provenanceJoin ?? {},
                'scopeTuple'
            ),
            false
        );
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('chat TrustGraph ON/OFF keeps action authority stable in runtime path', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });

    const runRequest = async (trustGraphEnabled: boolean) => {
        const server = await createTestServer({
            ...(trustGraphEnabled && {
                executionContractTrustGraph: {
                    adapter: new StubTrustGraphEvidenceAdapter('success'),
                    budget: {
                        timeoutMs: 100,
                        maxCalls: 1,
                    },
                    ownershipValidationPolicy:
                        TrustGraphOwnershipValidationPolicy.required({
                            policyId: 'chat_handler_runtime_policy',
                        }),
                    scopeOwnershipValidator,
                },
            }),
        });

        try {
            const response = await fetch(`${server.url}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-secret',
                },
                body: JSON.stringify(
                    createChatRequest({
                        surfaceContext: {
                            userId: 'user_1',
                            channelId: 'project_1',
                        },
                    })
                ),
            });

            assert.equal(response.status, 200);
            return (await response.json()) as {
                action: string;
                message: string;
                metadata: ResponseMetadata & {
                    trustGraph?: unknown;
                };
            };
        } finally {
            await server.close();
        }
    };

    try {
        const withoutTrustGraph = await runRequest(false);
        const withTrustGraph = await runRequest(true);

        assert.equal(withoutTrustGraph.action, 'message');
        assert.equal(withTrustGraph.action, 'message');
        assert.equal(withoutTrustGraph.message, withTrustGraph.message);
        assert.equal(withoutTrustGraph.metadata.provenance, 'Inferred');
        assert.equal(withTrustGraph.metadata.provenance, 'Inferred');
        assert.equal(withoutTrustGraph.metadata.trustGraph, undefined);
        assert.ok(withTrustGraph.metadata.trustGraph);
    } finally {
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('chat TrustGraph ownership deny fails closed and skips adapter invocation', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    let adapterInvoked = false;
    const server = await createTestServer({
        executionContractTrustGraph: {
            adapter: {
                async getEvidenceBundle() {
                    adapterInvoked = true;
                    throw new Error(
                        'adapter should not execute when ownership denies'
                    );
                },
            },
            budget: {
                timeoutMs: 100,
                maxCalls: 1,
            },
            ownershipValidationPolicy:
                TrustGraphOwnershipValidationPolicy.required({
                    policyId: 'chat_handler_runtime_policy',
                }),
            scopeOwnershipValidator:
                createScopeOwnershipValidatorFromTenancyService({
                    validatorId: 'backend_tenancy_v1',
                    service: {
                        validateScopeOwnership: async () => ({
                            owned: false,
                            checkedAt: TEST_TIMESTAMP,
                            evidence: ['ownership_lookup:deny'],
                            denialReason: 'tenant_mismatch',
                            details: 'scope is outside tenant boundary',
                        }),
                    },
                }),
        },
    });

    try {
        const response = await fetch(`${server.url}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify(
                createChatRequest({
                    surfaceContext: {
                        userId: 'user_1',
                        channelId: 'project_1',
                    },
                })
            ),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            action: string;
            metadata: ResponseMetadata & {
                trustGraph?: {
                    adapterStatus?: string;
                    scopeValidation?: {
                        ok?: boolean;
                        details?: string;
                    };
                };
            };
        };
        assert.equal(payload.action, 'message');
        assert.equal(
            payload.metadata.trustGraph?.adapterStatus,
            'scope_denied'
        );
        assert.equal(payload.metadata.trustGraph?.scopeValidation?.ok, false);
        assert.match(
            payload.metadata.trustGraph?.scopeValidation?.details ?? '',
            /tenant_mismatch/i
        );
        assert.equal(adapterInvoked, false);
    } finally {
        await server.close();
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('chat TrustGraph adapter timeout/error still returns local response', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const scopeOwnershipValidator =
        createScopeOwnershipValidatorFromTenancyService({
            validatorId: 'backend_tenancy_v1',
            service: {
                validateScopeOwnership: async () => ({
                    owned: true,
                    checkedAt: TEST_TIMESTAMP,
                    evidence: ['ownership_lookup:allow'],
                }),
            },
        });

    const runCase = async (mode: 'timeout' | 'failure') => {
        const server = await createTestServer({
            executionContractTrustGraph: {
                adapter: new StubTrustGraphEvidenceAdapter(mode),
                budget: {
                    timeoutMs: 50,
                    maxCalls: 1,
                },
                ownershipValidationPolicy:
                    TrustGraphOwnershipValidationPolicy.required({
                        policyId: 'chat_handler_runtime_policy',
                    }),
                scopeOwnershipValidator,
            },
        });

        try {
            const response = await fetch(`${server.url}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-secret',
                },
                body: JSON.stringify(
                    createChatRequest({
                        surfaceContext: {
                            userId: 'user_1',
                            channelId: 'project_1',
                        },
                    })
                ),
            });

            assert.equal(response.status, 200);
            return (await response.json()) as {
                action: string;
                message: string;
                metadata: ResponseMetadata & {
                    trustGraph?: { adapterStatus?: string };
                };
            };
        } finally {
            await server.close();
        }
    };

    try {
        const timeoutPayload = await runCase('timeout');
        assert.equal(timeoutPayload.action, 'message');
        assert.equal(timeoutPayload.message, 'service response');
        assert.equal(
            timeoutPayload.metadata.trustGraph?.adapterStatus,
            'timeout'
        );

        const errorPayload = await runCase('failure');
        assert.equal(errorPayload.action, 'message');
        assert.equal(errorPayload.message, 'service response');
        assert.equal(errorPayload.metadata.trustGraph?.adapterStatus, 'error');
    } finally {
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('Execution Contract TrustGraph config disabled and kill switch both remove advisory path', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    const runCase = async (
        config: RuntimeConfig['executionContractTrustGraph']
    ) => {
        const resolved =
            resolveExecutionContractTrustGraphRuntimeOptions(config);
        const server = await createTestServer({
            executionContractTrustGraph: resolved,
        });

        try {
            const response = await fetch(`${server.url}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-secret',
                },
                body: JSON.stringify(
                    createChatRequest({
                        surfaceContext: {
                            userId: 'user_1',
                            channelId: 'project_1',
                        },
                    })
                ),
            });
            assert.equal(response.status, 200);
            return (await response.json()) as {
                metadata: ResponseMetadata & {
                    trustGraph?: unknown;
                };
            };
        } finally {
            await server.close();
        }
    };

    try {
        const disabledPayload = await runCase(
            createExecutionContractTrustGraphRuntimeConfig({
                enabled: false,
                adapter: {
                    mode: 'stub',
                    endpointUrl: null,
                    apiToken: null,
                    configRef: null,
                    stubMode: 'success',
                },
            })
        );
        assert.equal(disabledPayload.metadata.trustGraph, undefined);

        const killSwitchPayload = await runCase(
            createExecutionContractTrustGraphRuntimeConfig({
                enabled: true,
                killSwitchExternalRetrieval: true,
                adapter: {
                    mode: 'stub',
                    endpointUrl: null,
                    apiToken: null,
                    configRef: null,
                    stubMode: 'success',
                },
            })
        );
        assert.equal(killSwitchPayload.metadata.trustGraph, undefined);
    } finally {
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});

test('Execution Contract TrustGraph runtime wiring threads ownership validation timeout budget', () => {
    const config = createExecutionContractTrustGraphRuntimeConfig({
        enabled: true,
        timeoutMs: 321,
        adapter: {
            mode: 'none',
            endpointUrl: null,
            apiToken: null,
            configRef: null,
            stubMode: 'success',
        },
        ownership: {
            bindingMode: 'none',
            validatorId: 'backend_tenancy_http_v1',
            endpointUrl: null,
            apiToken: null,
        },
    });

    const resolved = resolveExecutionContractTrustGraphRuntimeOptions(config);
    assert.equal(
        resolved?.scopeValidationPolicy?.ownershipValidationTimeoutMs,
        321
    );
});

test('Execution Contract TrustGraph runtime wiring fails fast when http adapter endpoint is missing', () => {
    const config = createExecutionContractTrustGraphRuntimeConfig({
        enabled: true,
        adapter: {
            mode: 'http',
            endpointUrl: null,
            apiToken: 'adapter-secret',
            configRef: null,
            stubMode: 'success',
        },
    });

    assert.throws(
        () => resolveExecutionContractTrustGraphRuntimeOptions(config),
        /execution_contract_trustgraph_http_adapter_missing_endpoint/
    );
});

test('Execution Contract TrustGraph runtime wiring fails fast when http adapter token is missing', () => {
    const config = createExecutionContractTrustGraphRuntimeConfig({
        enabled: true,
        adapter: {
            mode: 'http',
            endpointUrl: 'http://trustgraph.internal/evidence',
            apiToken: null,
            configRef: null,
            stubMode: 'success',
        },
    });

    assert.throws(
        () => resolveExecutionContractTrustGraphRuntimeOptions(config),
        /execution_contract_trustgraph_http_adapter_missing_api_token/
    );
});

test('Execution Contract TrustGraph runtime wiring does not fail startup when feature is disabled', () => {
    const config = createExecutionContractTrustGraphRuntimeConfig({
        enabled: false,
        adapter: {
            mode: 'http',
            endpointUrl: null,
            apiToken: null,
            configRef: null,
            stubMode: 'success',
        },
    });

    const resolved = resolveExecutionContractTrustGraphRuntimeOptions(config);
    assert.equal(resolved, undefined);
});

test('Execution Contract TrustGraph observability emits deny timeout and error events', async () => {
    const env = process.env as MutableEnv;
    const previousTraceToken = env.TRACE_API_TOKEN;
    const previousTurnstileSecret = env.TURNSTILE_SECRET_KEY;
    const previousTurnstileSite = env.TURNSTILE_SITE_KEY;
    const originalWarn = logger.warn;
    const observedEvents: Array<Record<string, unknown>> = [];

    env.TRACE_API_TOKEN = 'trace-secret';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_SITE_KEY = 'turnstile-site';

    logger.warn = ((message: unknown) => {
        if (typeof message === 'object' && message !== null) {
            const payload = message as Record<string, unknown>;
            if (
                payload.event ===
                'chat.execution_contract_trustgraph.runtime_outcome'
            ) {
                observedEvents.push(payload);
            }
        }
        return undefined;
    }) as unknown as typeof logger.warn;

    type ExecutionContractTrustGraphOptions = NonNullable<
        CreateChatServiceOptions['executionContractTrustGraph']
    >;
    const run = async (input: {
        adapter: ExecutionContractTrustGraphOptions['adapter'];
        ownershipValidator: ExecutionContractTrustGraphOptions['scopeOwnershipValidator'];
    }) => {
        const server = await createTestServer({
            executionContractTrustGraph: {
                adapter: input.adapter,
                budget: {
                    timeoutMs: 50,
                    maxCalls: 1,
                },
                ownershipValidationPolicy:
                    TrustGraphOwnershipValidationPolicy.required({
                        policyId: 'chat_handler_runtime_policy',
                    }),
                scopeOwnershipValidator: input.ownershipValidator,
            },
        });

        try {
            const response = await fetch(`${server.url}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-secret',
                },
                body: JSON.stringify(
                    createChatRequest({
                        surfaceContext: {
                            userId: 'user_1',
                            channelId: 'project_1',
                        },
                    })
                ),
            });
            assert.equal(response.status, 200);
        } finally {
            await server.close();
        }
    };

    try {
        await run({
            adapter: new StubTrustGraphEvidenceAdapter('success'),
            ownershipValidator: createScopeOwnershipValidatorFromTenancyService(
                {
                    validatorId: 'backend_tenancy_v1',
                    service: {
                        validateScopeOwnership: async () => ({
                            owned: false,
                            checkedAt: TEST_TIMESTAMP,
                            evidence: ['ownership_lookup:deny'],
                            denialReason: 'tenant_mismatch',
                            details: 'scope is outside tenant boundary',
                        }),
                    },
                }
            ),
        });
        await run({
            adapter: new StubTrustGraphEvidenceAdapter('timeout'),
            ownershipValidator: createScopeOwnershipValidatorFromTenancyService(
                {
                    validatorId: 'backend_tenancy_v1',
                    service: {
                        validateScopeOwnership: async () => ({
                            owned: true,
                            checkedAt: TEST_TIMESTAMP,
                            evidence: ['ownership_lookup:allow'],
                        }),
                    },
                }
            ),
        });
        await run({
            adapter: new StubTrustGraphEvidenceAdapter('failure'),
            ownershipValidator: createScopeOwnershipValidatorFromTenancyService(
                {
                    validatorId: 'backend_tenancy_v1',
                    service: {
                        validateScopeOwnership: async () => ({
                            owned: true,
                            checkedAt: TEST_TIMESTAMP,
                            evidence: ['ownership_lookup:allow'],
                        }),
                    },
                }
            ),
        });

        assert.ok(
            observedEvents.some((event) => event.scopeDenied === true),
            'expected scope-denied observability event'
        );
        assert.ok(
            observedEvents.some((event) => event.timeout === true),
            'expected timeout observability event'
        );
        assert.ok(
            observedEvents.some((event) => event.adapterError === true),
            'expected adapter-error observability event'
        );
    } finally {
        logger.warn = originalWarn;
        env.TRACE_API_TOKEN = previousTraceToken;
        env.TURNSTILE_SECRET_KEY = previousTurnstileSecret;
        env.TURNSTILE_SITE_KEY = previousTurnstileSite;
    }
});
