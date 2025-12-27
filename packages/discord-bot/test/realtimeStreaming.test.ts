/**
 * @description: Tests realtime streaming flow integration for audio handlers.
 * @arete-scope: test
 * @arete-module: RealtimeStreamingTests
 * @arete-risk: low - Test failures indicate streaming regressions only.
 * @arete-ethics: low - No user content is processed in test fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import type { VoiceConnection } from '@discordjs/voice';
import { RealtimeAudioHandler } from '../src/realtime/RealtimeAudioHandler.js';
import { VoiceSessionManager } from '../src/voice/VoiceSessionManager.js';
import { AudioCaptureHandler } from '../src/voice/AudioCaptureHandler.js';
import { RealtimeEventHandler } from '../src/realtime/RealtimeEventHandler.js';
import type { RealtimeSession } from '../src/utils/realtimeService.js';
import type { AudioPlaybackHandler } from '../src/voice/AudioPlaybackHandler.js';

type SentItemContent = { type: string; text?: string };
type SentItem = { content: SentItemContent[] };
type SentPayload = { type: string; item?: SentItem };
type TestWebSocket = WebSocket & { sent: SentPayload[] };

class MockWebSocket {
    public sent: SentPayload[] = [];
    public readyState = 1;

    send(payload: string) {
        this.sent.push(JSON.parse(payload) as SentPayload);
    }
}

class MockEventHandler extends RealtimeEventHandler {
    public collected = 0;

    constructor() {
        super();
    }

    async waitForAudioCollected(): Promise<void> {
        this.collected += 1;
    }
}

class FakeRealtimeSession {
    public readonly chunks: { speaker: string; buffer: Buffer; userId?: string }[] = [];
    public flushes = 0;

    async sendAudio(buffer: Buffer, speaker: string, userId?: string): Promise<void> {
        this.chunks.push({ speaker, buffer: Buffer.from(buffer), userId });
    }

    async flushAudio(): Promise<void> {
        this.flushes += 1;
    }

    clearAudio(): void {}
    disconnect(): void {}
}

const noopPlaybackHandler = {} as AudioPlaybackHandler;
const noopConnection = {} as VoiceConnection;

const waitForPipeline = async (session: { audioPipeline: Promise<void> }) => {
    await session.audioPipeline;
    await new Promise(resolve => setImmediate(resolve));
};

test('RealtimeAudioHandler annotates speaker label before commit', async () => {
    const handler = new RealtimeAudioHandler();
    const ws = new MockWebSocket() as unknown as TestWebSocket;
    const eventHandler = new MockEventHandler();
    const chunk = Buffer.from([0, 1, 2, 3]);

    await handler.sendAudio(ws, eventHandler, chunk, 'Alice', 'user-1');
    await handler.flushAudio(ws, eventHandler);

    assert.equal(ws.sent.length, 4);
    assert.equal(ws.sent[0].type, 'input_audio_buffer.append');
    assert.equal(ws.sent[1].type, 'input_audio_buffer.append');
    assert.equal(ws.sent[2].type, 'conversation.item.create');
    assert.equal(ws.sent[2].item?.content[0]?.type, 'input_text');
    assert.match(ws.sent[2].item?.content[0]?.text ?? '', /Alice/);
    assert.equal(ws.sent[2].item?.content[1]?.type, 'input_audio_buffer');
    assert.equal(ws.sent[3].type, 'input_audio_buffer.commit');
    assert.equal(eventHandler.collected, 1);
});

test('VoiceSessionManager forwards multi-speaker audio with display names', async () => {
    const manager = new VoiceSessionManager();
    const audioCapture = new AudioCaptureHandler();
    const realtimeSession = new FakeRealtimeSession() as unknown as RealtimeSession & FakeRealtimeSession;
    const participants = new Map([
        ['user-1', 'Alice'],
        ['user-2', 'Bob'],
    ]);

    const session = manager.createSession(
        noopConnection,
        realtimeSession,
        audioCapture,
        noopPlaybackHandler,
        participants,
    );

    manager.addSession('guild-1', session);

    audioCapture.emit('audioChunk', { guildId: 'guild-1', userId: 'user-1', audioBuffer: Buffer.from([1, 2]) });
    audioCapture.emit('audioChunk', { guildId: 'guild-1', userId: 'user-2', audioBuffer: Buffer.from([3, 4]) });
    audioCapture.emit('speakerSilence', { guildId: 'guild-1', userId: 'user-1' });

    await waitForPipeline(session);

    assert.deepEqual(
        realtimeSession.chunks.map(({ speaker }: { speaker: string }) => speaker),
        ['Alice', 'Bob'],
    );
    assert.deepEqual(Array.from(realtimeSession.chunks[0].buffer.values()), [1, 2]);
    assert.deepEqual(Array.from(realtimeSession.chunks[1].buffer.values()), [3, 4]);
    assert.equal(realtimeSession.flushes, 1);

    manager.removeSession('guild-1');
});
