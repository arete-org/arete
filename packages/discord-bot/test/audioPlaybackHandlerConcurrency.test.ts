/**
 * @description: Exercises audio playback concurrency and resource cleanup paths.
 * @arete-scope: test
 * @arete-module: AudioPlaybackHandlerConcurrencyTests
 * @arete-risk: low - Test failures highlight concurrency regressions only.
 * @arete-ethics: low - No user data is processed in test fixtures.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AudioPlayerStatus, VoiceConnection } from '@discordjs/voice';

import { AudioPlaybackHandler } from '../src/voice/AudioPlaybackHandler.js';

class MockAudioPlayer extends EventEmitter {
    public state = { status: AudioPlayerStatus.Idle };

    public play(): void {}
    public stop(): void {}
}

class MockOpusEncoder extends EventEmitter {
    public end(): void {}
}

class MockPipeline {
    private pendingWrite: Promise<void> | null = null;
    private resolvePendingWrite: (() => void) | null = null;
    private firstWrite = true;
    private readonly pcmStream = new PassThrough();

    constructor(
        private readonly onFirstWrite: () => void,
        private readonly player: MockAudioPlayer,
        private readonly encoder: MockOpusEncoder,
    ) {}

    public getPlayer(): MockAudioPlayer {
        return this.player;
    }

    public hasResource(): boolean {
        return true;
    }

    public getPCMStream(): PassThrough {
        return this.pcmStream;
    }

    public getOpusEncoder(): MockOpusEncoder {
        return this.encoder;
    }

    public markResourceCreated(): void {}

    public async writePCM(_pcm: Buffer): Promise<void> {
        if (this.firstWrite) {
            this.firstWrite = false;
            this.onFirstWrite();
            this.pendingWrite = new Promise((resolve) => {
                this.resolvePendingWrite = resolve;
            });
        }

        if (this.pendingWrite) {
            await this.pendingWrite;
        }
    }

    public async flushResidualBuffer(): Promise<void> {}

    public async destroy(): Promise<void> {
        if (this.pendingWrite) {
            await this.pendingWrite;
        }
    }

    public releaseWrite(): void {
        this.resolvePendingWrite?.();
    }
}

test('player errors do not allow overlapping processAudioQueue executions', async () => {
    const handler = new AudioPlaybackHandler();
    const handlerTestHarness = handler as unknown as {
        pipelines: Map<string, MockPipeline>;
        audioQueues: Map<string, Buffer[]>;
        isProcessingQueue: Map<string, boolean>;
        cleanupPipeline: (guildId: string) => void;
        retryProcessingQueue: (connection: VoiceConnection) => void;
        processAudioQueue: (connection: VoiceConnection) => Promise<void>;
    };
    const guildId = 'guild-id';

    const connection = {
        joinConfig: { guildId },
        state: { status: 'ready' },
        subscribe: () => ({})
    } as unknown as VoiceConnection;

    const originalSetTimeout = global.setTimeout;
    const scheduledCallbacks: Array<() => void> = [];

    global.setTimeout = ((fn: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
        const callback = () => fn(...args);
        scheduledCallbacks.push(callback);
        return {
            ref() {
                return this;
            },
            unref() {
                return this;
            },
            hasRef() {
                return false;
            },
        } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    const player = new MockAudioPlayer();
    const encoder = new MockOpusEncoder();

    const pipeline = new MockPipeline(() => {
        player.emit('error', new Error('player failure'));
    }, player, encoder);

    handlerTestHarness.pipelines.set(guildId, pipeline);

    const queue = [Buffer.alloc(2, 0x01), Buffer.alloc(2, 0x02)];
    handlerTestHarness.audioQueues.set(guildId, queue);

    encoder.once('error', () => {
        const q = handlerTestHarness.audioQueues.get(guildId);
        handlerTestHarness.cleanupPipeline(guildId);
        if (q && q.length > 0) {
            handlerTestHarness.retryProcessingQueue(connection);
        }
    });

    player.on('error', () => {
        handlerTestHarness.cleanupPipeline(guildId);
        handlerTestHarness.retryProcessingQueue(connection);
    });

    const originalProcess = handlerTestHarness.processAudioQueue.bind(handlerTestHarness);
    let currentRuns = 0;
    let maxConcurrentRuns = 0;

    handlerTestHarness.processAudioQueue = async function wrappedProcess(connectionArg: VoiceConnection): Promise<void> {
        currentRuns++;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, currentRuns);
        try {
            return await originalProcess(connectionArg);
        } finally {
            currentRuns--;
        }
    };

    try {
        const processingPromise = handlerTestHarness.processAudioQueue(connection);

        assert.equal(currentRuns, 1, 'initial processing run should be active');
        assert.ok(scheduledCallbacks.length > 0, 'player error should schedule a retry');

        const scheduled = scheduledCallbacks.shift()!;
        const flagDuringRetry = handlerTestHarness.isProcessingQueue.get(guildId);
        scheduled();

        assert.equal(flagDuringRetry, true, 'retry should see processing already in progress');
        assert.equal(maxConcurrentRuns, 1, 'processing runs must not overlap');

        queue.length = 0;
        pipeline.releaseWrite();

        await processingPromise;
        assert.equal(handlerTestHarness.isProcessingQueue.get(guildId), false, 'processing flag should reset after completion');
    } finally {
        global.setTimeout = originalSetTimeout;
        handlerTestHarness.processAudioQueue = originalProcess;
        pipeline.releaseWrite();
    }
});
