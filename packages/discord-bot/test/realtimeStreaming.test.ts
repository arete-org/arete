/**
 * @description: Tests realtime streaming flow integration for audio handlers.
 * @footnote-scope: test
 * @footnote-module: RealtimeStreamingTests
 * @footnote-risk: low - Test failures indicate streaming regressions only.
 * @footnote-ethics: low - No user content is processed in test fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { VoiceConnection } from '@discordjs/voice';
import { RealtimeAudioHandler } from '../src/realtime/RealtimeAudioHandler.js';
import { VoiceSessionManager } from '../src/voice/VoiceSessionManager.js';
import { AudioCaptureHandler } from '../src/voice/AudioCaptureHandler.js';
import type { RealtimeSession } from '../src/utils/realtimeService.js';
import type { AudioPlaybackHandler } from '../src/voice/AudioPlaybackHandler.js';

type SentPayload = { type: string; [key: string]: unknown };

class FakeRealtimeSession {
    public readonly chunks: {
        speaker: string;
        buffer: Buffer;
        userId?: string;
    }[] = [];

    async sendAudio(
        buffer: Buffer,
        speaker: string,
        userId?: string
    ): Promise<void> {
        this.chunks.push({ speaker, buffer: Buffer.from(buffer), userId });
    }

    clearAudio(): void {}
    disconnect(): void {}
}

const noopPlaybackHandler = {} as AudioPlaybackHandler;
const noopConnection = {} as VoiceConnection;

const waitForPipeline = async (session: { audioPipeline: Promise<void> }) => {
    await session.audioPipeline;
    await new Promise((resolve) => setImmediate(resolve));
};

test('RealtimeAudioHandler forwards audio chunks without committing', async () => {
    const handler = new RealtimeAudioHandler();
    const sent: SentPayload[] = [];
    const sendEvent = (payload: SentPayload) => {
        sent.push(payload);
    };
    const chunk = Buffer.from([0, 1, 2, 3]);

    await handler.sendAudio(sendEvent, chunk, 'Alice', 'user-1');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'input_audio.append');
});

test('RealtimeAudioHandler keeps append-only turns stable across repeated calls', async () => {
    const handler = new RealtimeAudioHandler();
    const sent: SentPayload[] = [];
    const sendEvent = (payload: SentPayload) => {
        sent.push(payload);
    };

    await handler.sendAudio(
        sendEvent,
        Buffer.from([1, 2, 3, 4]),
        'Alice',
        'user-1'
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'input_audio.append');

    await handler.sendAudio(
        sendEvent,
        Buffer.from([5, 6, 7, 8]),
        'Alice',
        'user-1'
    );
    assert.equal(sent.length, 2);
    assert.deepEqual(
        sent.map((payload) => payload.type),
        ['input_audio.append', 'input_audio.append']
    );
});

test('RealtimeAudioHandler keeps both speakers as separate append events', async () => {
    const handler = new RealtimeAudioHandler();
    const sent: SentPayload[] = [];
    const sendEvent = (payload: SentPayload) => {
        sent.push(payload);
    };

    await handler.sendAudio(sendEvent, Buffer.from([1, 2]), 'Alex', 'user-1');
    await handler.sendAudio(sendEvent, Buffer.from([3, 4]), 'Alex', 'user-2');

    assert.deepEqual(
        sent.map((payload) => payload.type),
        ['input_audio.append', 'input_audio.append']
    );
});

test('VoiceSessionManager forwards multi-speaker audio with display names', async () => {
    const manager = new VoiceSessionManager();
    const audioCapture = new AudioCaptureHandler();
    const realtimeSession =
        new FakeRealtimeSession() as unknown as RealtimeSession &
            FakeRealtimeSession;
    const participants = new Map([
        ['user-1', 'Alice'],
        ['user-2', 'Bob'],
    ]);

    const session = manager.createSession(
        noopConnection,
        realtimeSession,
        audioCapture,
        noopPlaybackHandler,
        participants
    );

    manager.addSession('guild-1', session);

    audioCapture.emit('audioChunk', {
        guildId: 'guild-1',
        userId: 'user-1',
        audioBuffer: Buffer.from([1, 2]),
    });
    audioCapture.emit('audioChunk', {
        guildId: 'guild-1',
        userId: 'user-2',
        audioBuffer: Buffer.from([3, 4]),
    });
    await waitForPipeline(session);

    assert.deepEqual(
        realtimeSession.chunks.map(
            ({ speaker }: { speaker: string }) => speaker
        ),
        ['Alice', 'Bob']
    );
    assert.deepEqual(
        Array.from(realtimeSession.chunks[0].buffer.values()),
        [1, 2]
    );
    assert.deepEqual(
        Array.from(realtimeSession.chunks[1].buffer.values()),
        [3, 4]
    );

    manager.removeSession('guild-1');
});
