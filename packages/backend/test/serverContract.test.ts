/**
 * @description: Locks down baseline backend transport contracts at the real server boundary.
 * Covers CORS, route negotiation, static/SPA/CSP behavior, webhook signature handling, NDJSON streaming, and upgrade dispatch.
 * @footnote-scope: test
 * @footnote-module: ServerContractTests
 * @footnote-risk: high - Missing server-level contracts can let route and transport behavior drift during refactors.
 * @footnote-ethics: medium - Stable transport behavior supports transparency and reliable safety controls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHmac } from 'node:crypto';

import { startBackendServerContractHarness } from './serverContractHarness.js';

const createChatRequestPayload = (): Record<string, unknown> => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'hello from contract test',
    conversation: [
        {
            role: 'user',
            content: 'hello from contract test',
        },
    ],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
});

const createInternalImageStreamPayload = (): Record<string, unknown> => ({
    task: 'generate',
    prompt: 'draw one geometric icon',
    textModel: 'gpt-5-mini',
    imageModel: 'gpt-image-1-mini',
    size: '1024x1024',
    quality: 'low',
    background: 'auto',
    style: 'vivid',
    allowPromptAdjustment: true,
    outputFormat: 'png',
    outputCompression: 100,
    stream: true,
    user: {
        username: 'contract-test',
        nickname: 'contract-test',
        guildName: 'contract-test',
    },
});

const readUpgradeResponse = async ({
    host,
    port,
    pathname,
    headers = {},
}: {
    host: string;
    port: number;
    pathname: string;
    headers?: Record<string, string>;
}): Promise<string> =>
    await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const chunks: string[] = [];
        let accumulated = '';
        let settled = false;

        const cleanup = () => {
            socket.removeAllListeners();
            socket.on('error', () => undefined);
            if (!socket.destroyed) {
                socket.destroy();
            }
        };

        const finish = (value: string) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(value);
        };

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        socket.on('connect', () => {
            const mergedHeaders: Record<string, string> = {
                Host: `${host}:${port}`,
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version': '13',
                ...headers,
            };
            const headerLines = Object.entries(mergedHeaders)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\r\n');
            const request = `GET ${pathname} HTTP/1.1\r\n${headerLines}\r\n\r\n`;
            socket.write(request);
        });

        socket.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            chunks.push(text);
            accumulated += text;

            if (accumulated.includes('\r\n\r\n')) {
                finish(chunks.join(''));
            }
        });

        socket.on('end', () => {
            finish(chunks.join(''));
        });

        socket.on('close', () => {
            finish(chunks.join(''));
        });

        socket.on('error', fail);

        setTimeout(() => {
            finish(chunks.join(''));
        }, 750).unref();
    });

test('backend server contract baseline routes and transport behavior stay stable', async (t) => {
    const harness = await startBackendServerContractHarness();
    t.after(async () => {
        await harness.stop();
    });

    await t.test(
        '/api/chat OPTIONS responds as CORS preflight contract',
        async () => {
            const response = await fetch(`${harness.baseUrl}/api/chat`, {
                method: 'OPTIONS',
                headers: {
                    Origin: 'https://allowed.example',
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'Content-Type',
                },
            });

            assert.equal(response.status, 204);
            assert.equal(
                response.headers.get('access-control-allow-origin'),
                'https://allowed.example'
            );
            assert.equal(
                response.headers.get('access-control-allow-methods'),
                'POST, OPTIONS'
            );
            assert.match(response.headers.get('vary') ?? '', /origin/i);
        }
    );

    await t.test(
        '/api/chat returns provider-unavailable 503 when no runtime provider is configured',
        async () => {
            const response = await fetch(`${harness.baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': 'trace-token',
                },
                body: JSON.stringify(createChatRequestPayload()),
            });

            assert.equal(response.status, 503);
            assert.match(
                response.headers.get('content-type') ?? '',
                /application\/json/i
            );

            const payload = (await response.json()) as {
                error?: string;
                details?: string;
            };
            assert.equal(payload.error, 'Generation provider unavailable');
            assert.equal(payload.details, 'provider_unavailable');
        }
    );

    await t.test(
        '/api/traces/{id} negotiates Accept and sets Vary: Accept',
        async () => {
            const traceId = 'server-contract-missing-trace-id';
            const jsonResponse = await fetch(
                `${harness.baseUrl}/api/traces/${encodeURIComponent(traceId)}`,
                {
                    headers: {
                        Accept: 'application/json',
                    },
                }
            );

            assert.equal(jsonResponse.status, 404);
            assert.match(
                jsonResponse.headers.get('content-type') ?? '',
                /application\/json/i
            );
            assert.match(jsonResponse.headers.get('vary') ?? '', /accept/i);

            const htmlResponse = await fetch(
                `${harness.baseUrl}/api/traces/${encodeURIComponent(traceId)}`,
                {
                    headers: {
                        Accept: 'text/html',
                    },
                }
            );

            assert.equal(htmlResponse.status, 200);
            assert.match(
                htmlResponse.headers.get('content-type') ?? '',
                /text\/html/i
            );
            assert.match(htmlResponse.headers.get('vary') ?? '', /accept/i);
            assert.ok(
                (htmlResponse.headers.get('content-security-policy') ?? '')
                    .length > 0
            );
        }
    );

    await t.test(
        '/config.json keeps config transport contract stable',
        async () => {
            const response = await fetch(`${harness.baseUrl}/config.json`);
            assert.equal(response.status, 200);
            assert.match(
                response.headers.get('content-type') ?? '',
                /application\/json/i
            );
            assert.equal(response.headers.get('cache-control'), 'no-store');

            const payload = (await response.json()) as {
                turnstileSiteKey?: string;
            };
            assert.equal(typeof payload.turnstileSiteKey, 'string');
        }
    );

    await t.test(
        'static asset and SPA fallback behavior remain stable with CSP on HTML',
        async () => {
            const staticResponse = await fetch(
                `${harness.baseUrl}${harness.staticFixture.routePath}`
            );
            assert.equal(staticResponse.status, 200);
            assert.match(
                staticResponse.headers.get('content-type') ?? '',
                /application\/javascript/i
            );
            assert.equal(
                staticResponse.headers.get('content-security-policy'),
                null
            );
            assert.match(await staticResponse.text(), /SERVER_CONTRACT_ASSET/);

            const spaResponse = await fetch(
                `${harness.baseUrl}/contract/spa/fallback/route`
            );
            assert.equal(spaResponse.status, 200);
            assert.match(
                spaResponse.headers.get('content-type') ?? '',
                /text\/html/i
            );
            assert.ok(
                (spaResponse.headers.get('content-security-policy') ?? '')
                    .length > 0
            );
        }
    );

    await t.test(
        'webhook raw-body signature path rejects invalid signatures and accepts valid signatures',
        async () => {
            const payloadText =
                '{"action":"created","discussion":{"number":42,"title":"A","body":"B","category":{"name":"General"}},"repository":{"full_name":"acme/server-contract"}}';
            const validSignature = `sha256=${createHmac('sha256', 'server-contract-secret').update(payloadText).digest('hex')}`;

            const invalidResponse = await fetch(
                `${harness.baseUrl}/api/webhook/github`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Hub-Signature-256': 'sha256=deadbeef',
                    },
                    body: payloadText,
                }
            );
            assert.equal(invalidResponse.status, 401);
            assert.deepEqual(await invalidResponse.json(), {
                error: 'Invalid signature',
            });

            const validResponse = await fetch(
                `${harness.baseUrl}/api/webhook/github`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Hub-Signature-256': validSignature,
                    },
                    body: payloadText,
                }
            );
            assert.equal(validResponse.status, 200);
            assert.deepEqual(await validResponse.json(), {
                message: 'Ignored: not Blog category',
            });
        }
    );

    await t.test(
        '/api/internal/voice/realtime upgrade route dispatch and rejection behavior remain stable',
        async () => {
            const matchedRouteResponse = await readUpgradeResponse({
                host: harness.host,
                port: harness.port,
                pathname: '/api/internal/voice/realtime',
                headers: {
                    'X-Trace-Token': 'trace-token',
                },
            });
            assert.match(matchedRouteResponse, /503 Service Unavailable/);
            assert.match(
                matchedRouteResponse,
                /Internal voice realtime provider unavailable/
            );

            const unmatchedRouteResponse = await readUpgradeResponse({
                host: harness.host,
                port: harness.port,
                pathname: '/api/internal/voice/realtime/extra',
                headers: {
                    'X-Trace-Token': 'trace-token',
                },
            });
            assert.doesNotMatch(
                unmatchedRouteResponse,
                /101 Switching Protocols/
            );
        }
    );
});

test('/api/internal/image stream path keeps NDJSON response contract', async (t) => {
    const harness = await startBackendServerContractHarness({
        envOverrides: {
            OPENAI_API_KEY: 'test-openai-key',
            OPENAI_REQUEST_TIMEOUT_MS: '50',
        },
    });
    t.after(async () => {
        await harness.stop();
    });

    const response = await fetch(`${harness.baseUrl}/api/internal/image`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Trace-Token': 'trace-token',
        },
        body: JSON.stringify(createInternalImageStreamPayload()),
    });

    assert.equal(response.status, 200);
    assert.equal(
        response.headers.get('content-type'),
        'application/x-ndjson; charset=utf-8'
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');

    const lines = (await response.text())
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    assert.ok(lines.length > 0);

    const parsedEvents = lines.map(
        (line) => JSON.parse(line) as { type: string }
    );
    for (const event of parsedEvents) {
        assert.ok(
            event.type === 'partial_image' ||
                event.type === 'result' ||
                event.type === 'error'
        );
    }
    const terminalType = parsedEvents[parsedEvents.length - 1]?.type;
    assert.ok(terminalType === 'result' || terminalType === 'error');
});
