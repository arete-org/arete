/**
 * @description: Captures and processes real-time user voice data from Discord voice channels.
 * @footnote-scope: core
 * @footnote-module: AudioCaptureHandler
 * @footnote-risk: high - Handles Opus decoding, PCM conversion, and audio chunk emission. Failures can cause audio loss, processing errors, or memory leaks.
 * @footnote-ethics: high - Processes user voice data in real-time, directly affecting privacy, consent, and the handling of sensitive audio information.
 */

import type { VoiceConnection, VoiceReceiver } from '@discordjs/voice';
import { EndBehaviorType } from '@discordjs/voice';
import { logger } from '../utils/logger.js';
import prism from 'prism-media';
import { AUDIO_CONSTANTS, TIMEOUT_CONSTANTS } from '../constants/voice.js';
import { createCaptureResampler } from './audioTransforms.js';
import { EventEmitter } from 'events';

/**
 * @footnote-logger: audioCaptureHandler
 * @logs: Voice capture lifecycle events and PCM chunk metadata.
 * @footnote-risk: high - Missing logs make audio capture dropouts hard to diagnose.
 * @footnote-ethics: high - Voice data is sensitive; log sizes and IDs only.
 */
const audioCaptureLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'audioCaptureHandler' })
        : logger;

interface ActiveReceiver {
    cleanup: () => void;
}

interface AudioChunkEvent {
    guildId: string;
    userId: string;
    audioBuffer: Buffer;
}

interface AudioCaptureDebugInfo {
    captureInitialized: number;
    activeReceivers: number;
    audioChunkListeners: number;
    speakerSilenceListeners: number;
}

export class AudioCaptureHandler extends EventEmitter {
    private readonly captureInitialized: Set<string> = new Set();
    private readonly activeReceivers: Map<string, ActiveReceiver> = new Map();
    private readonly ignoredUserIdsByGuild: Map<string, Set<string>> =
        new Map();

    constructor() {
        super();
        this.setMaxListeners(50);
    }

    public setupAudioCapture(
        connection: VoiceConnection,
        _unusedRealtimeSession: unknown,
        guildId: string,
        ignoredUserIds: Set<string> = new Set()
    ): void {
        const receiver = connection.receiver;

        this.ignoredUserIdsByGuild.set(guildId, new Set(ignoredUserIds));
        audioCaptureLogger.debug(
            `Updated ignored user list for guild ${guildId}`,
            { ignoredUserCount: ignoredUserIds.size }
        );

        if (this.captureInitialized.has(guildId)) {
            audioCaptureLogger.debug(
                `Audio capture already initialized for guild ${guildId}`
            );
            return;
        }

        try {
            receiver.speaking.removeAllListeners('start');
            receiver.speaking.removeAllListeners('end');
        } catch (error) {
            audioCaptureLogger.warn(
                `Failed to clear existing speaking listeners for guild ${guildId}: ${error}`
            );
        }

        receiver.speaking.on('start', (userId: string) => {
            if (this.shouldIgnoreUser(guildId, userId)) {
                audioCaptureLogger.debug(
                    `[${this.getCaptureKey(guildId, userId)}] Ignoring bot/self audio capture`
                );
                return;
            }
            audioCaptureLogger.debug(
                `[${this.getCaptureKey(guildId, userId)}] Speaking started`
            );
            this.startReceiverStream(guildId, userId, receiver);
        });

        receiver.speaking.on('end', (userId: string) => {
            if (this.shouldIgnoreUser(guildId, userId)) {
                return;
            }
            const key = this.getCaptureKey(guildId, userId);
            const active = this.activeReceivers.get(key);
            if (!active) {
                return;
            }
            audioCaptureLogger.debug(`[${key}] Discord speaking event ended`);
            active.cleanup();
        });

        this.captureInitialized.add(guildId);
        audioCaptureLogger.debug(`Audio capture setup completed for guild ${guildId}`);
    }

    public isCaptureInitialized(guildId: string): boolean {
        return this.captureInitialized.has(guildId);
    }

    private getCaptureKey(guildId: string, userId: string): string {
        return `${guildId}:${userId}`;
    }

    private shouldIgnoreUser(guildId: string, userId: string): boolean {
        return this.ignoredUserIdsByGuild.get(guildId)?.has(userId) ?? false;
    }

    private startReceiverStream(
        guildId: string,
        userId: string,
        receiver: VoiceReceiver
    ): void {
        const captureKey = this.getCaptureKey(guildId, userId);
        if (this.activeReceivers.has(captureKey)) {
            audioCaptureLogger.debug(`[${captureKey}] Receiver already active`);
            return;
        }

        audioCaptureLogger.debug(`[${captureKey}] Starting PCM capture stream`);

        const opusStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
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
        let cleanedUp = false;
        let firstChunkLogged = false;

        const onData = (chunk: Buffer) => {
            if (chunk.length === 0) return;

            if (!firstChunkLogged) {
                firstChunkLogged = true;
                audioCaptureLogger.debug(
                    `[${captureKey}] First PCM chunk received`,
                    { bytes: chunk.length }
                );
            }
            const event: AudioChunkEvent = {
                guildId,
                userId,
                audioBuffer: chunk,
            };
            this.emit('audioChunk', event);
        };

        const cleanup = () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            audioCaptureLogger.debug(`[${captureKey}] Cleaning up PCM stream`);
            pcmStream.off('data', onData);
            pcmStream.removeAllListeners();
            resampler.removeAllListeners();
            decoder.removeAllListeners();
            try {
                decoder.unpipe(resampler);
            } catch {
                // Ignore errors during cleanup
            }
            try {
                opusStream.unpipe(decoder);
            } catch {
                // Ignore errors during cleanup
            }
            try {
                pcmStream.destroy();
            } catch {
                // Ignore errors during cleanup
            }
            try {
                decoder.destroy();
            } catch {
                // Ignore errors during cleanup
            }
            try {
                opusStream.destroy();
            } catch {
                // Ignore errors during cleanup
            }
            opusStream.removeAllListeners();
            this.activeReceivers.delete(captureKey);
        };

        pcmStream.on('data', onData);
        pcmStream.once('end', cleanup);
        pcmStream.once('close', cleanup);
        pcmStream.on('error', (err: Error) => {
            audioCaptureLogger.error(`[${captureKey}] PCM stream error:`, err);
            cleanup();
        });

        decoder.on('error', (err: Error) => {
            audioCaptureLogger.error(`[${captureKey}] Decoder error:`, err);
            cleanup();
        });

        opusStream.on('error', (err: Error) => {
            audioCaptureLogger.error(`[${captureKey}] Opus stream error:`, err);
            cleanup();
        });

        this.activeReceivers.set(captureKey, { cleanup });
    }

    public cleanupGuild(guildId: string): void {
        for (const key of Array.from(this.activeReceivers.keys())) {
            if (!key.startsWith(`${guildId}:`)) continue;
            const receiver = this.activeReceivers.get(key);
            receiver?.cleanup();
        }

        this.captureInitialized.delete(guildId);
        this.ignoredUserIdsByGuild.delete(guildId);
        audioCaptureLogger.debug(`Cleaned up audio capture for guild ${guildId}`);
    }

    public getDebugInfo(): AudioCaptureDebugInfo {
        return {
            captureInitialized: this.captureInitialized.size,
            activeReceivers: this.activeReceivers.size,
            audioChunkListeners: this.listenerCount('audioChunk'),
            speakerSilenceListeners: this.listenerCount('speakerSilence'),
        };
    }
}

export type { AudioChunkEvent };

