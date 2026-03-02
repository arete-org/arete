/**
 * @description: Covers Turnstile hostname validation for the reflect auth helper.
 * @footnote-scope: test
 * @footnote-module: ReflectAuthTests
 * @footnote-risk: medium - Missing tests could allow successful CAPTCHA responses for the wrong host.
 * @footnote-ethics: medium - Hostname checks protect the public reflect path from abuse and misconfiguration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyTurnstileCaptcha } from '../src/handlers/reflectAuth.js';

type MutableEnv = NodeJS.ProcessEnv & {
    TURNSTILE_SECRET_KEY?: string;
    TURNSTILE_ALLOWED_HOSTNAMES?: string;
};

test('verifyTurnstileCaptcha rejects successful responses with the wrong hostname', async () => {
    const env = process.env as MutableEnv;
    const previousSecret = env.TURNSTILE_SECRET_KEY;
    const previousAllowedHostnames = env.TURNSTILE_ALLOWED_HOSTNAMES;
    const originalFetch = globalThis.fetch;

    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    env.TURNSTILE_ALLOWED_HOSTNAMES = 'app.example.com';

    globalThis.fetch = (async () => {
        return new Response(
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
        );
    }) as typeof fetch;

    try {
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
    } finally {
        globalThis.fetch = originalFetch;
        env.TURNSTILE_SECRET_KEY = previousSecret;
        env.TURNSTILE_ALLOWED_HOSTNAMES = previousAllowedHostnames;
    }
});

test('verifyTurnstileCaptcha accepts request-host matches when no explicit allowlist is set', async () => {
    const env = process.env as MutableEnv;
    const previousSecret = env.TURNSTILE_SECRET_KEY;
    const previousAllowedHostnames = env.TURNSTILE_ALLOWED_HOSTNAMES;
    const originalFetch = globalThis.fetch;

    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    delete env.TURNSTILE_ALLOWED_HOSTNAMES;

    globalThis.fetch = (async () => {
        return new Response(
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
        );
    }) as typeof fetch;

    try {
        const result = await verifyTurnstileCaptcha({
            clientIp: '127.0.0.1',
            requestHost: 'localhost:3000',
            requestOrigin: 'http://localhost:3000',
            turnstileToken: 'captcha-token',
            tokenSource: 'header',
        });

        assert.deepEqual(result, { success: true });
    } finally {
        globalThis.fetch = originalFetch;
        env.TURNSTILE_SECRET_KEY = previousSecret;
        env.TURNSTILE_ALLOWED_HOSTNAMES = previousAllowedHostnames;
    }
});
