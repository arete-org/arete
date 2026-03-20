/**
 * @description: Covers trusted realtime voice websocket upgrade behavior at the backend boundary.
 * @footnote-scope: test
 * @footnote-module: InternalVoiceRealtimeHandlerTests
 * @footnote-risk: medium - Missing tests could hide auth or upgrade regressions for live voice sessions.
 * @footnote-ethics: high - These checks protect a privacy-sensitive internal voice boundary from accidental exposure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { createInternalVoiceRealtimeHandler } from '../src/handlers/internalVoiceRealtime.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';

class FakeUpgradeSocket extends Duplex {
    public written = '';
    public destroyedByHandler = false;

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
}

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
    assert.equal(socket.destroyedByHandler, true);
});
