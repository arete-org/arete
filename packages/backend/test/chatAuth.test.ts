/**
 * @description: Covers Turnstile hostname validation for the chat auth helper.
 * @footnote-scope: test
 * @footnote-module: ChatAuthTests
 * @footnote-risk: medium - Missing tests could allow successful CAPTCHA responses for the wrong host.
 * @footnote-ethics: medium - Hostname checks protect the public chat path from abuse and misconfiguration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeConfig } from '../src/config.js';
import { verifyTurnstileCaptcha } from '../src/handlers/chatAuth.js';

type SerialTestFn = (
    context: import('node:test').TestContext
) => void | Promise<void>;

const serialTest = (name: string, fn: SerialTestFn) =>
    test(name, { concurrency: false }, fn);

const withTurnstileConfig = async (
    config: {
        secretKey: string;
        allowedHostnames: string[];
    },
    run: () => Promise<void>
) => {
    const previousTurnstile = { ...runtimeConfig.turnstile };
    runtimeConfig.turnstile = {
        ...runtimeConfig.turnstile,
        secretKey: config.secretKey,
        allowedHostnames: config.allowedHostnames,
    };
    try {
        await run();
    } finally {
        runtimeConfig.turnstile = previousTurnstile;
    }
};

serialTest(
    'verifyTurnstileCaptcha rejects successful responses with the wrong hostname',
    async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    hostname: 'evil.example.com',
                    'challenge-ts': new Date().toISOString(),
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            )) as typeof fetch;

        try {
            await withTurnstileConfig(
                {
                    secretKey: 'turnstile-secret',
                    allowedHostnames: ['app.example.com'],
                },
                async () => {
                    const result = await verifyTurnstileCaptcha({
                        clientIp: '203.0.113.10',
                        requestHost: 'app.example.com:3000',
                        requestOrigin: 'https://app.example.com',
                        turnstileToken: 'captcha-token',
                        tokenSource: 'header',
                    });

                    assert.equal(result.success, false);
                    if (result.success) {
                        return;
                    }

                    assert.equal(result.error.statusCode, 403);
                    assert.deepEqual(result.error.payload, {
                        error: 'CAPTCHA verification failed',
                        details: 'hostname mismatch',
                    });
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
);

serialTest(
    'verifyTurnstileCaptcha accepts successful responses only when the hostname is explicitly allowed',
    async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    hostname: 'LOCALHOST',
                    'challenge-ts': new Date().toISOString(),
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            )) as typeof fetch;

        try {
            await withTurnstileConfig(
                {
                    secretKey: 'turnstile-secret',
                    allowedHostnames: ['localhost'],
                },
                async () => {
                    const result = await verifyTurnstileCaptcha({
                        clientIp: '127.0.0.1',
                        requestHost: 'localhost:3000',
                        requestOrigin: 'http://localhost:3000',
                        turnstileToken: 'captcha-token',
                        tokenSource: 'header',
                    });

                    assert.deepEqual(result, { success: true });
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
);

serialTest(
    'verifyTurnstileCaptcha accepts successful responses when allowlist is unset and hostname matches request host',
    async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    hostname: 'ai.jordanmakes.dev',
                    'challenge-ts': new Date().toISOString(),
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            )) as typeof fetch;

        try {
            await withTurnstileConfig(
                {
                    secretKey: 'turnstile-secret',
                    allowedHostnames: [],
                },
                async () => {
                    const result = await verifyTurnstileCaptcha({
                        clientIp: '203.0.113.10',
                        requestHost: 'ai.jordanmakes.dev:443',
                        requestOrigin: undefined,
                        turnstileToken: 'captcha-token',
                        tokenSource: 'header',
                    });

                    assert.deepEqual(result, { success: true });
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
);

serialTest(
    'verifyTurnstileCaptcha accepts successful responses when allowlist is unset and hostname matches request origin',
    async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    hostname: 'ai.jordanmakes.dev',
                    'challenge-ts': new Date().toISOString(),
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            )) as typeof fetch;

        try {
            await withTurnstileConfig(
                {
                    secretKey: 'turnstile-secret',
                    allowedHostnames: [],
                },
                async () => {
                    const result = await verifyTurnstileCaptcha({
                        clientIp: '203.0.113.10',
                        requestHost: 'backend.internal:3000',
                        requestOrigin: 'https://ai.jordanmakes.dev',
                        turnstileToken: 'captcha-token',
                        tokenSource: 'header',
                    });

                    assert.deepEqual(result, { success: true });
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
);

serialTest(
    'verifyTurnstileCaptcha rejects successful responses when allowlist is unset and hostname matches neither request host nor origin',
    async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    hostname: 'evil.example.com',
                    'challenge-ts': new Date().toISOString(),
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            )) as typeof fetch;

        try {
            await withTurnstileConfig(
                {
                    secretKey: 'turnstile-secret',
                    allowedHostnames: [],
                },
                async () => {
                    const result = await verifyTurnstileCaptcha({
                        clientIp: '203.0.113.10',
                        requestHost: 'ai.jordanmakes.dev:443',
                        requestOrigin: 'https://ai.jordanmakes.dev',
                        turnstileToken: 'captcha-token',
                        tokenSource: 'header',
                    });

                    assert.equal(result.success, false);
                    if (result.success) {
                        return;
                    }

                    assert.equal(result.error.statusCode, 403);
                    assert.deepEqual(result.error.payload, {
                        error: 'CAPTCHA verification failed',
                        details: 'hostname mismatch',
                    });
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
);
