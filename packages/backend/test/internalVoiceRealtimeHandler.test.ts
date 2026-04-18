/**
 * @description: Covers trusted realtime voice websocket upgrade behavior at the backend boundary.
 * @footnote-scope: test
 * @footnote-module: InternalVoiceRealtimeHandlerTests
 * @footnote-risk: medium - Missing tests could hide auth or upgrade regressions for live voice sessions.
 * @footnote-ethics: high - These checks protect a privacy-sensitive internal voice boundary from accidental exposure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type {
    InternalVoiceRealtimeServerEvent,
    InternalVoiceSessionContext,
} from '@footnote/contracts/voice';
import type {
    RealtimeVoiceRuntime,
    RealtimeVoiceSession,
} from '@footnote/agent-runtime';
import type { BackendLLMCostRecord } from '../src/services/llmCostRecorder.js';

import { createInternalVoiceRealtimeHandler } from '../src/handlers/internalVoiceRealtime.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';

class FakeUpgradeSocket extends Duplex {
    public written = '';
    public destroyedByHandler = false;
    public endedByHandler = false;

    public _read(): void {}

    public _write(
        chunk: string | Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void
    ): void {
        this.written += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        callback();
    }

    public override destroy(error?: Error): this {
        this.destroyedByHandler = true;
        return super.destroy(error);
    }

    public override end(cb?: () => void): this;
    public override end(chunk: string | Buffer, cb?: () => void): this;
    public override end(
        chunk: string | Buffer,
        encoding: BufferEncoding,
        cb?: () => void
    ): this;
    public override end(
        chunk?: string | Buffer | (() => void),
        encoding?: BufferEncoding | (() => void),
        cb?: () => void
    ): this {
        this.endedByHandler = true;
        if (typeof chunk === 'function') {
            return super.end(chunk);
        }
        if (typeof encoding === 'function') {
            return super.end(chunk, encoding);
        }
        if (typeof encoding === 'string') {
            return super.end(chunk, encoding, cb);
        }
        return super.end(chunk, cb);
    }
}

class StubRealtimeSession implements RealtimeVoiceSession {
    public readonly sentClientEvents: Array<{ type: string }> = [];
    private readonly listeners: Array<
        (event: InternalVoiceRealtimeServerEvent) => void
    > = [];

    public async send(event: { type: string }): Promise<void> {
        this.sentClientEvents.push(event);
    }

    public onEvent(
        listener: (event: InternalVoiceRealtimeServerEvent) => void
    ): void {
        this.listeners.push(listener);
    }

    public close(_reason?: string): void {}

    public emitServerEvent(event: InternalVoiceRealtimeServerEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

type RealtimeHandlerHarness = {
    close: () => Promise<void>;
    connect: (headers?: Record<string, string>) => Promise<WebSocket>;
    lastSession: () => StubRealtimeSession | null;
    recordedUsage: BackendLLMCostRecord[];
    requests: Array<{
        instructions: string;
        context: InternalVoiceSessionContext;
        options?: {
            model?: string;
            voice?: string;
            temperature?: number;
            maxResponseOutputTokens?: number;
        };
    }>;
};

const createRealtimeHandlerHarness =
    async (): Promise<RealtimeHandlerHarness> => {
        const requests: RealtimeHandlerHarness['requests'] = [];
        const recordedUsage: BackendLLMCostRecord[] = [];
        let currentSession: StubRealtimeSession | null = null;
        let lastContext: InternalVoiceSessionContext = {
            participants: [],
        };
        const runtime: RealtimeVoiceRuntime = {
            kind: 'stub-realtime-runtime',
            async createSession(request) {
                currentSession = new StubRealtimeSession();
                requests.push({
                    instructions: request.instructions,
                    context: lastContext,
                    options: request.options,
                });
                return currentSession;
            },
        };

        const { handleUpgrade } = createInternalVoiceRealtimeHandler({
            realtimeVoiceRuntime: runtime,
            traceApiToken: 'trace-token',
            serviceToken: 'service-token',
            serviceRateLimiter: new SimpleRateLimiter({
                limit: 10,
                window: 60000,
            }),
            buildInstructions: (context) => {
                lastContext = context;
                return `participants=${context.participants.length}`;
            },
            recordUsage: (record) => {
                recordedUsage.push(record);
            },
        });

        const server = http.createServer((_req, res) => {
            res.statusCode = 404;
            res.end();
        });

        server.on('upgrade', (req, socket, head) => {
            handleUpgrade(req, socket, head);
        });

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address === 'object');

        return {
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
            connect: (headers = {}) =>
                new Promise((resolve, reject) => {
                    const ws = new WebSocket(
                        `ws://127.0.0.1:${address.port}/api/internal/voice/realtime`,
                        {
                            headers: {
                                'X-Trace-Token': 'trace-token',
                                ...headers,
                            },
                        }
                    );
                    ws.once('open', () => resolve(ws));
                    ws.once('error', reject);
                }),
            lastSession: () => currentSession,
            recordedUsage,
            requests,
        };
    };

const waitForJsonMessage = async (
    ws: WebSocket
): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: WebSocket.RawData) => {
            cleanup();
            try {
                resolve(JSON.parse(data.toString()) as Record<string, unknown>);
            } catch (error) {
                reject(error);
            }
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            ws.off('message', onMessage);
            ws.off('error', onError);
        };
        ws.on('message', onMessage);
        ws.on('error', onError);
    });

const closeWebSocket = async (ws: WebSocket): Promise<void> =>
    new Promise((resolve) => {
        if (
            ws.readyState === WebSocket.CLOSED ||
            ws.readyState === WebSocket.CLOSING
        ) {
            resolve();
            return;
        }

        ws.once('close', () => resolve());
        ws.close();
    });

test('internal realtime handler rejects websocket upgrades without trusted auth', () => {
    const { handleUpgrade } = createInternalVoiceRealtimeHandler({
        realtimeVoiceRuntime: null,
        traceApiToken: 'trace-token',
        serviceToken: 'service-token',
        serviceRateLimiter: new SimpleRateLimiter({ limit: 10, window: 60000 }),
        buildInstructions: () => 'test instructions',
    });
    const socket = new FakeUpgradeSocket();
    const request = {
        method: 'GET',
        headers: {},
    } as IncomingMessage;

    handleUpgrade(request, socket, Buffer.alloc(0));

    assert.match(socket.written, /401 Unauthorized/);
    assert.match(socket.written, /Missing trusted service credentials/);
    assert.equal(socket.endedByHandler, true);
});

test('internal realtime handler returns provider_unavailable when runtime is missing', () => {
    const { handleUpgrade } = createInternalVoiceRealtimeHandler({
        realtimeVoiceRuntime: null,
        traceApiToken: 'trace-token',
        serviceToken: null,
        serviceRateLimiter: new SimpleRateLimiter({ limit: 10, window: 60000 }),
        buildInstructions: () => 'test instructions',
    });
    const socket = new FakeUpgradeSocket();
    const request = {
        method: 'GET',
        headers: {
            'x-trace-token': 'trace-token',
        },
    } as IncomingMessage;

    handleUpgrade(request, socket, Buffer.alloc(0));

    assert.match(socket.written, /503 Service Unavailable/);
    assert.match(
        socket.written,
        /Internal voice realtime provider unavailable/
    );
    assert.match(socket.written, /provider_unavailable/);
    assert.equal(socket.endedByHandler, true);
});

test('internal realtime handler rejects invalid realtime payloads after websocket upgrade', async () => {
    const harness = await createRealtimeHandlerHarness();

    try {
        const ws = await harness.connect();
        ws.send(
            JSON.stringify({
                type: 'session.start',
                context: {
                    participants: [{ id: 'user-1' }],
                },
            })
        );

        const message = await waitForJsonMessage(ws);
        assert.equal(message.type, 'error');
        assert.match(String(message.message), /Invalid realtime event/);
        await closeWebSocket(ws);
    } finally {
        await harness.close();
    }
});

test('internal realtime handler starts a session and forwards session.ready to the client', async () => {
    const harness = await createRealtimeHandlerHarness();

    try {
        const ws = await harness.connect();
        ws.send(
            JSON.stringify({
                type: 'session.start',
                context: {
                    participants: [
                        {
                            id: 'user-1',
                            displayName: 'Alice',
                        },
                    ],
                },
                options: {
                    model: 'gpt-realtime',
                    voice: 'alloy',
                },
            })
        );

        const session = await new Promise<StubRealtimeSession>(
            (resolve, reject) => {
                const startedAt = Date.now();
                const poll = () => {
                    const current = harness.lastSession();
                    if (current) {
                        resolve(current);
                        return;
                    }
                    if (Date.now() - startedAt > 1000) {
                        reject(new Error('Realtime session was not created.'));
                        return;
                    }
                    setTimeout(poll, 10);
                };
                poll();
            }
        );

        assert.equal(harness.requests.length, 1);
        assert.equal(harness.requests[0].instructions, 'participants=1');
        assert.deepEqual(harness.requests[0].context.participants, [
            {
                id: 'user-1',
                displayName: 'Alice',
            },
        ]);

        session.emitServerEvent({ type: 'session.ready' });
        const readyMessage = await waitForJsonMessage(ws);
        assert.deepEqual(readyMessage, { type: 'session.ready' });

        session.emitServerEvent({
            type: 'response.done',
            responseId: 'resp_123',
            usage: {
                tokensPrompt: 50,
                tokensCompletion: 25,
                model: 'gpt-realtime',
            },
        });

        assert.equal(harness.recordedUsage.length, 1);
        assert.equal(harness.recordedUsage[0].feature, 'voice_realtime');
        assert.equal(harness.recordedUsage[0].model, 'gpt-realtime');
        assert.equal(harness.recordedUsage[0].promptTokens, 50);
        assert.equal(harness.recordedUsage[0].completionTokens, 25);

        await closeWebSocket(ws);
    } finally {
        await harness.close();
    }
});
