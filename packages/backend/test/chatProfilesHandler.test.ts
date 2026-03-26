/**
 * @description: Verifies /api/chat/profiles returns enabled model profile options safely.
 * @footnote-scope: test
 * @footnote-module: ChatProfilesHandlerTests
 * @footnote-risk: low - These tests only validate read-only profile option filtering and transport behavior.
 * @footnote-ethics: medium - Accurate profile visibility supports transparent user model selection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import type { RuntimeConfig } from '../src/config/types.js';
import { runtimeConfig } from '../src/config.js';
import { createChatProfilesHandler } from '../src/handlers/chatProfiles.js';

type MutableRuntimeConfig = RuntimeConfig;

type TestServer = {
    url: string;
    close: () => Promise<void>;
};

const createTestServer = (): Promise<TestServer> =>
    new Promise((resolve) => {
        const handler = createChatProfilesHandler({
            logRequest: () => undefined,
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

test('chat profiles endpoint returns only enabled profiles', async () => {
    const mutableRuntimeConfig = runtimeConfig as MutableRuntimeConfig;
    const previousCatalog = mutableRuntimeConfig.modelProfiles.catalog;
    const server = await createTestServer();

    mutableRuntimeConfig.modelProfiles.catalog = [
        {
            id: 'enabled-profile',
            description: 'Enabled profile',
            provider: 'openai',
            providerModel: 'gpt-5-mini',
            enabled: true,
            tierBindings: [],
            capabilities: { canUseSearch: true },
        },
        {
            id: 'disabled-profile',
            description: 'Disabled profile',
            provider: 'openai',
            providerModel: 'gpt-5-nano',
            enabled: false,
            tierBindings: [],
            capabilities: { canUseSearch: false },
        },
    ];

    try {
        const response = await fetch(`${server.url}/api/chat/profiles`, {
            method: 'GET',
        });
        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            profiles: Array<{ id: string; description?: string }>;
        };
        assert.deepEqual(payload.profiles, [
            { id: 'enabled-profile', description: 'Enabled profile' },
        ]);
    } finally {
        mutableRuntimeConfig.modelProfiles.catalog = previousCatalog;
        await server.close();
    }
});

test('chat profiles endpoint returns an empty list when catalog has no enabled profiles', async () => {
    const mutableRuntimeConfig = runtimeConfig as MutableRuntimeConfig;
    const previousCatalog = mutableRuntimeConfig.modelProfiles.catalog;
    const server = await createTestServer();

    mutableRuntimeConfig.modelProfiles.catalog = [];

    try {
        const response = await fetch(`${server.url}/api/chat/profiles`, {
            method: 'GET',
        });
        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            profiles: Array<{ id: string; description?: string }>;
        };
        assert.deepEqual(payload.profiles, []);
    } finally {
        mutableRuntimeConfig.modelProfiles.catalog = previousCatalog;
        await server.close();
    }
});

test('chat profiles endpoint rejects unsupported methods', async () => {
    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/chat/profiles`, {
            method: 'POST',
        });
        assert.equal(response.status, 405);
        const payload = (await response.json()) as { error: string };
        assert.equal(payload.error, 'Method not allowed');
    } finally {
        await server.close();
    }
});
