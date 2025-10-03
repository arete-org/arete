import { VoiceConnection } from '@discordjs/voice';
import { logger } from '../utils/logger.js';
import prism from 'prism-media';
import { AUDIO_CONSTANTS, TIMEOUT_CONSTANTS } from '../constants/voice.js';
import { createCaptureResampler } from './audioTransforms.js';
import { EventEmitter } from 'events';

interface ActiveReceiver {
    cleanup: () => void;
}

interface AudioChunkEvent {
    guildId: string;
    userId: string;
    audioBuffer: Buffer;
}

export class AudioCaptureHandler extends EventEmitter {
    private readonly captureInitialized: Set<string> = new Set();
    private readonly activeReceivers: Map<string, ActiveReceiver> = new Map();

    constructor() {
        super();
        this.setMaxListeners(50);
    }

    public setupAudioCapture(connection: VoiceConnection, _unusedRealtimeSession: unknown, guildId: string): void {
        const receiver = connection.receiver;

        if (this.captureInitialized.has(guildId)) {
            logger.debug(`Audio capture already initialized for guild ${guildId}`);
            return;
        }

        try {
            receiver.speaking.removeAllListeners('start');
            receiver.speaking.removeAllListeners('end');
        } catch (error) {
            logger.warn(`Failed to clear existing speaking listeners for guild ${guildId}: ${error}`);
        }

        receiver.speaking.on('start', (userId: string) => {
            this.startReceiverStream(guildId, userId, receiver);
        });

        receiver.speaking.on('end', (userId: string) => {
            const key = this.getCaptureKey(guildId, userId);
            const active = this.activeReceivers.get(key);
            if (!active) {
                return;
            }
            logger.debug(`[${key}] Discord speaking event ended`);
            active.cleanup();
        });

        this.captureInitialized.add(guildId);
        logger.debug(`Audio capture setup completed for guild ${guildId}`);
    }

    public isCaptureInitialized(guildId: string): boolean {
        return this.captureInitialized.has(guildId);
    }

    private getCaptureKey(guildId: string, userId: string): string {
        return `${guildId}:${userId}`;
    }

    private startReceiverStream(guildId: string, userId: string, receiver: any): void {
        const captureKey = this.getCaptureKey(guildId, userId);
        if (this.activeReceivers.has(captureKey)) {
            logger.debug(`[${captureKey}] Receiver already active`);
            return;
        }

        logger.debug(`[${captureKey}] Starting PCM capture stream`);

        const opusStream = receiver.subscribe(userId, {
            end: {
                behavior: 'afterSilence',
                duration: TIMEOUT_CONSTANTS.SILENCE_DURATION,
            },
        });

        const decoder = new prism.opus.Decoder({
            rate: AUDIO_CONSTANTS.DISCORD_SAMPLE_RATE,
            channels: AUDIO_CONSTANTS.CHANNELS,
            frameSize: AUDIO_CONSTANTS.DISCORD_FRAME_SIZE,
        });
        const resampler = createCaptureResampler();
        const pcmStream = opusStream.pipe(decoder).pipe(resampler);

        const onData = (chunk: Buffer) => {
            if (chunk.length === 0) return;

            const event: AudioChunkEvent = { guildId, userId, audioBuffer: chunk };
            this.emit('audioChunk', event);
        };

        const cleanup = () => {
            logger.debug(`[${captureKey}] Cleaning up PCM stream`);
            pcmStream.off('data', onData);
            pcmStream.removeAllListeners();
            resampler.removeAllListeners();
            decoder.removeAllListeners();
            try {
                decoder.unpipe(resampler);
            } catch {}
            try {
                opusStream.unpipe(decoder);
            } catch {}
            opusStream.removeAllListeners();
            this.activeReceivers.delete(captureKey);
            this.emitSpeakerSilence(guildId, userId);
        };

        pcmStream.on('data', onData);
        pcmStream.once('end', cleanup);
        pcmStream.once('close', cleanup);
        pcmStream.on('error', (err: Error) => {
            logger.error(`[${captureKey}] PCM stream error:`, err);
            cleanup();
        });

        decoder.on('error', (err: Error) => {
            logger.error(`[${captureKey}] Decoder error:`, err);
            cleanup();
        });

        opusStream.on('error', (err: Error) => {
            logger.error(`[${captureKey}] Opus stream error:`, err);
            cleanup();
        });

        this.activeReceivers.set(captureKey, { cleanup });
    }

    private emitSpeakerSilence(guildId: string, userId: string): void {
        this.emit('speakerSilence', { guildId, userId });
    }

    public cleanupGuild(guildId: string): void {
        for (const key of Array.from(this.activeReceivers.keys())) {
            if (!key.startsWith(`${guildId}:`)) continue;
            const receiver = this.activeReceivers.get(key);
            receiver?.cleanup();
        }

        this.captureInitialized.delete(guildId);
        logger.debug(`Cleaned up audio capture for guild ${guildId}`);
    }

    public getDebugInfo(): any {
        return {
            captureInitialized: this.captureInitialized.size,
            activeReceivers: this.activeReceivers.size,
            audioChunkListeners: this.listenerCount('audioChunk'),
            speakerSilenceListeners: this.listenerCount('speakerSilence'),
        };
    }
}

export type { AudioChunkEvent };
