/**
 * @description: Validates trusted internal voice TTS handler availability behavior.
 * @footnote-scope: test
 * @footnote-module: InternalVoiceTtsHandlerTests
 * @footnote-risk: medium - Missing tests could hide trusted-route outage behavior regressions.
 * @footnote-ethics: high - Voice boundaries must fail clearly when synthesis providers are unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createInternalVoiceTtsHandler } from '../src/handlers/internalVoiceTts.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';

type TestServer = {
    url: string;
    close: () => Promise<void>;
};

const createInternalVoiceTtsServer = async (): Promise<TestServer> => {
    const handler = createInternalVoiceTtsHandler({
        internalVoiceTtsService: null,
        logRequest: () => undefined,
        maxBodyBytes: 50_000,
        traceApiToken: 'trace-secret',
        serviceToken: null,
        serviceRateLimiter: new SimpleRateLimiter({
            limit: 20,
            window: 60_000,
        }),
    });

    const server = http.createServer((req, res) => {
        if ((req.url ?? '') === '/api/internal/voice/tts') {
            void handler.handleInternalVoiceTtsRequest(req, res);
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

test('internal voice TTS endpoint returns provider_unavailable when service is missing', async () => {
    const server = await createInternalVoiceTtsServer();

    try {
        const response = await fetch(`${server.url}/api/internal/voice/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                task: 'synthesize',
                text: 'hello world',
                options: {
                    model: 'gpt-4o-mini-tts',
                    voice: 'alloy',
                },
                outputFormat: 'mp3',
            }),
        });

        assert.equal(response.status, 503);
        const payload = (await response.json()) as {
            error: string;
            details?: string;
        };
        assert.equal(payload.error, 'Internal voice TTS provider unavailable');
        assert.equal(payload.details, 'provider_unavailable');
    } finally {
        await server.close();
    }
});
