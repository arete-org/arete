/**
 * @description: Covers Discord-side mapping of backend realtime voice events.
 * @footnote-scope: test
 * @footnote-module: RealtimeServiceTests
 * @footnote-risk: medium - Missing tests could let protocol cleanup break live playback or completion handling.
 * @footnote-ethics: medium - These checks help keep the live voice UX predictable for users.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RealtimeSession } from '../src/utils/realtimeService.js';

type RealtimeSessionWithPrivateHandler = RealtimeSession & {
    handleBackendEvent: (raw: string) => void;
};

test('RealtimeSession maps backend audio, text, and completion events into local listeners', async () => {
    const session = new RealtimeSession() as RealtimeSessionWithPrivateHandler;
    const seenAudio: Buffer[] = [];
    const seenText: string[] = [];
    const seenEventTypes: string[] = [];

    session.on('audio', (audio) => {
        seenAudio.push(audio as Buffer);
    });
    session.on('text', (text) => {
        seenText.push(text as string);
    });
    session.on('response.output_audio.done', () => {
        seenEventTypes.push('response.output_audio.done');
    });
    session.on('response.completed', () => {
        seenEventTypes.push('response.completed');
    });

    session.handleBackendEvent(
        JSON.stringify({
            type: 'output_audio.delta',
            audioBase64: Buffer.from([1, 2, 3]).toString('base64'),
        })
    );
    session.handleBackendEvent(
        JSON.stringify({
            type: 'output_text.delta',
            text: 'hello there',
        })
    );
    session.handleBackendEvent(
        JSON.stringify({
            type: 'response.completed',
            responseId: 'resp_123',
        })
    );

    assert.deepEqual(
        seenAudio.map((buffer) => Array.from(buffer.values())),
        [[1, 2, 3]]
    );
    assert.deepEqual(seenText, ['hello there']);
    assert.deepEqual(seenEventTypes, [
        'response.output_audio.done',
        'response.completed',
    ]);

    session.removeAllListeners();
});

test('RealtimeSession emits connected when the backend reports session.ready', () => {
    const session = new RealtimeSession() as RealtimeSessionWithPrivateHandler;
    let connected = false;

    session.on('connected', () => {
        connected = true;
    });

    session.handleBackendEvent(JSON.stringify({ type: 'session.ready' }));

    assert.equal(connected, true);
    session.removeAllListeners();
});
