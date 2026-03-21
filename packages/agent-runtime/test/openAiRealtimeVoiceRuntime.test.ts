/**
 * @description: Covers the OpenAI-backed realtime voice runtime adapter.
 * @footnote-scope: test
 * @footnote-module: OpenAiRealtimeVoiceRuntimeTests
 * @footnote-risk: medium - Missing tests could hide websocket lifecycle regressions in live voice sessions.
 * @footnote-ethics: high - These checks protect reliable behavior in privacy-sensitive realtime audio flows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { createOpenAiRealtimeVoiceRuntime } from '../src/index.js';

class FakeRealtimeWebSocket extends EventEmitter {
    public readyState: number = WebSocket.CONNECTING;
    public readonly sentPayloads: string[] = [];
    private didAckSession = false;

    public send(payload: string): void {
        this.sentPayloads.push(payload);

        if (this.didAckSession) {
            return;
        }

        try {
            const parsed = JSON.parse(payload) as { type?: string };
            if (parsed.type === 'session.update') {
                this.didAckSession = true;
                setImmediate(() => {
                    this.emitJsonMessage({ type: 'session.updated' });
                });
            }
        } catch {
            // Ignore malformed client payloads in the fake socket.
        }
    }

    public close(): void {
        this.readyState = WebSocket.CLOSED;
        this.emit('close', 1000, Buffer.from('closed'));
    }

    public open(): void {
        this.readyState = WebSocket.OPEN;
        this.emit('open');
    }

    public emitJsonMessage(payload: Record<string, unknown>): void {
        this.emit('message', Buffer.from(JSON.stringify(payload)));
    }
}

const createRuntimeWithSocket = () => {
    const socket = new FakeRealtimeWebSocket();
    const runtime = createOpenAiRealtimeVoiceRuntime({
        apiKey: 'test-key',
        createWebSocket: () => {
            setImmediate(() => {
                socket.open();
            });
            return socket as unknown as WebSocket;
        },
    });

    return { runtime, socket };
};

test('realtime voice runtime replays session.ready to late listeners', async () => {
    const { runtime } = createRuntimeWithSocket();
    const session = await runtime.createSession({
        instructions: 'Be concise.',
    });

    const seenEvents: string[] = [];
    session.onEvent((event) => {
        seenEvents.push(event.type);
    });

    assert.deepEqual(seenEvents, ['session.ready']);
});

test('realtime voice runtime emits session.ready only once', async () => {
    const { runtime, socket } = createRuntimeWithSocket();
    const session = await runtime.createSession({
        instructions: 'Be concise.',
    });

    const seenEvents: string[] = [];
    session.onEvent((event) => {
        seenEvents.push(event.type);
    });

    socket.emitJsonMessage({ type: 'session.created' });
    socket.emitJsonMessage({ type: 'session.updated' });

    assert.deepEqual(seenEvents, ['session.ready']);
});

test('realtime voice runtime commits buffered audio without a synthetic conversation item', async () => {
    const { runtime, socket } = createRuntimeWithSocket();
    const session = await runtime.createSession({
        instructions: 'Be concise.',
    });

    await session.send({
        type: 'input_audio.append',
        audioBase64: Buffer.from([1, 2, 3]).toString('base64'),
        speakerLabel: 'Alice',
        speakerId: 'user-1',
    });
    await session.send({ type: 'input_audio.commit' });

    const payloadTypes = socket.sentPayloads
        .map((payload) => JSON.parse(payload) as { type?: string })
        .map((payload) => payload.type);

    assert.ok(payloadTypes.includes('input_audio_buffer.append'));
    assert.ok(payloadTypes.includes('input_audio_buffer.commit'));
    assert.equal(payloadTypes.includes('conversation.item.create'), false);
});
