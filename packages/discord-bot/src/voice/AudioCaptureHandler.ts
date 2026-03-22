/**
 * @description: Captures and processes real-time user voice data from Discord voice channels.
 * @footnote-scope: core
 * @footnote-module: AudioCaptureHandler
 * @footnote-risk: high - Handles Opus decoding, PCM conversion, and audio chunk emission. Failures can cause audio loss, processing errors, or memory leaks.
 * @footnote-ethics: high - Processes user voice data in real-time, directly affecting privacy, consent, and the handling of sensitive audio information.
 */

import type {
    VoiceConnection,
    VoiceConnectionState,
    VoiceReceiver,
    VoiceUserData,
} from '@discordjs/voice';
import { EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice';
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

const MAX_DECRYPT_RETRIES = 3;
const DECRYPT_RETRY_DELAY_MS = 400;
const MAX_SSRC_WAIT_RETRIES = 6;
const SSRC_WAIT_DELAY_MS = 120;
const MAX_SSRC_STALE_MS = 1000;
const FIRST_PCM_TIMEOUT_MS = 1500;
const MAX_NO_PCM_RETRIES = 2;
const SPEAKING_END_GRACE_MS = 250;

interface ActiveReceiver {
    cleanup: (reason?: string) => void;
}

interface SsrcMapListenerSet {
    onCreate: (newData: VoiceUserData) => void;
    onUpdate: (oldData: VoiceUserData | undefined, newData: VoiceUserData) => void;
    onDelete: (deletedData: VoiceUserData) => void;
}

interface AudioChunkEvent {
    guildId: string;
    userId: string;
    audioBuffer: Buffer;
}

interface SpeakerStartEvent {
    guildId: string;
    userId: string;
    activeSpeakerCount: number;
}

interface SpeakerSilenceEvent {
    guildId: string;
    userId: string;
    durationMs: number;
    chunkCount: number;
    totalBytes: number;
    reason: string;
}

interface AudioCaptureDebugInfo {
    captureInitialized: number;
    activeReceivers: number;
    audioChunkListeners: number;
    speakerStartListeners: number;
    speakerSilenceListeners: number;
}

export class AudioCaptureHandler extends EventEmitter {
    private readonly captureInitialized: Set<string> = new Set();
    private readonly activeReceivers: Map<string, ActiveReceiver> = new Map();
    private readonly ignoredUserIdsByGuild: Map<string, Set<string>> =
        new Map();
    private readonly connectionByGuild: Map<string, VoiceConnection> = new Map();
    private readonly connectionStateListeners: Map<
        string,
        (oldState: VoiceConnectionState, newState: VoiceConnectionState) => void
    > = new Map();
    private readonly ssrcMapListeners: Map<string, SsrcMapListenerSet> =
        new Map();
    private readonly decryptRetryCounts: Map<string, number> = new Map();
    private readonly decryptRetryTimers: Map<
        string,
        ReturnType<typeof setTimeout>
    > = new Map();
    private readonly ssrcRetryCounts: Map<string, number> = new Map();
    private readonly ssrcRetryTimers: Map<
        string,
        ReturnType<typeof setTimeout>
    > = new Map();
    private readonly lastSsrcUpdateMs: Map<string, number> = new Map();
    private readonly noPcmRetryCounts: Map<string, number> = new Map();
    private readonly endCleanupTimers: Map<
        string,
        ReturnType<typeof setTimeout>
    > = new Map();

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

        this.registerConnectionDebuggers(connection, guildId);

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
            const captureKey = this.getCaptureKey(guildId, userId);
            const pendingEndTimer = this.endCleanupTimers.get(captureKey);
            if (pendingEndTimer) {
                clearTimeout(pendingEndTimer);
                this.endCleanupTimers.delete(captureKey);
            }
            if (this.activeReceivers.has(captureKey)) {
                audioCaptureLogger.debug(
                    `[${captureKey}] Receiver already active`
                );
                return;
            }

            audioCaptureLogger.debug(`[${captureKey}] Speaking started`);
            this.emitSpeakerStart(guildId, userId);
            this.startReceiverStream(guildId, userId, receiver, {
                reason: 'speaking_start',
            });
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
            const pendingTimer = this.endCleanupTimers.get(key);
            if (pendingTimer) {
                clearTimeout(pendingTimer);
            }
            const cleanupTimer = setTimeout(() => {
                this.endCleanupTimers.delete(key);
                if (this.activeReceivers.has(key)) {
                    active.cleanup('speaking_end_grace');
                }
            }, SPEAKING_END_GRACE_MS);
            this.endCleanupTimers.set(key, cleanupTimer);
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
        receiver: VoiceReceiver,
        options: { isRetry?: boolean; reason?: string; forceStart?: boolean } = {}
    ): void {
        const captureKey = this.getCaptureKey(guildId, userId);
        if (this.activeReceivers.has(captureKey)) {
            audioCaptureLogger.debug(`[${captureKey}] Receiver already active`);
            return;
        }

        if (!options.isRetry) {
            this.decryptRetryCounts.set(captureKey, 0);
        }

        const ssrcData = receiver.ssrcMap.get(userId);
        const lastSsrcUpdate = this.lastSsrcUpdateMs.get(captureKey);
        const ssrcIsStale =
            lastSsrcUpdate !== undefined &&
            Date.now() - lastSsrcUpdate > MAX_SSRC_STALE_MS;
        if (!ssrcData && !options.forceStart) {
            this.scheduleSsrcRetry(
                captureKey,
                guildId,
                userId,
                receiver,
                options.reason
            );
            return;
        }

        if (options.forceStart && !ssrcData) {
            audioCaptureLogger.warn(
                `[${captureKey}] SSRC not mapped after retries; starting capture anyway`
            );
        } else if (ssrcData && ssrcIsStale) {
            this.lastSsrcUpdateMs.set(captureKey, Date.now());
        } else if (ssrcData && lastSsrcUpdate === undefined) {
            this.lastSsrcUpdateMs.set(captureKey, Date.now());
        }

        const captureStartedAt = Date.now();
        let chunkCount = 0;
        let totalBytes = 0;

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
        let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;

        const onData = (chunk: Buffer) => {
            if (chunk.length === 0) return;

            chunkCount += 1;
            totalBytes += chunk.length;
            if (firstChunkTimer) {
                clearTimeout(firstChunkTimer);
                firstChunkTimer = undefined;
            }
            const event: AudioChunkEvent = {
                guildId,
                userId,
                audioBuffer: chunk,
            };
            this.emit('audioChunk', event);
        };

        const cleanup = (reason = 'unknown') => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            const durationMs = Date.now() - captureStartedAt;
            audioCaptureLogger.debug(
                `[${captureKey}] PCM capture summary`,
                { durationMs, chunkCount, totalBytes, reason }
            );
            this.emitSpeakerSilence({
                guildId,
                userId,
                durationMs,
                chunkCount,
                totalBytes,
                reason,
            });
            if (firstChunkTimer) {
                clearTimeout(firstChunkTimer);
                firstChunkTimer = undefined;
            }
            const pendingEndTimer = this.endCleanupTimers.get(captureKey);
            if (pendingEndTimer) {
                clearTimeout(pendingEndTimer);
                this.endCleanupTimers.delete(captureKey);
            }
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
            this.ssrcRetryCounts.delete(captureKey);
            this.noPcmRetryCounts.delete(captureKey);
        };

        firstChunkTimer = setTimeout(() => {
            if (cleanedUp) {
                return;
            }
            const isStillSpeaking = receiver.speaking.users.has(userId);
            if (!isStillSpeaking) {
                audioCaptureLogger.debug(
                    `[${captureKey}] No PCM received within ${FIRST_PCM_TIMEOUT_MS}ms; speaker ended before PCM`
                );
                cleanup('no_pcm_timeout_speaker_end');
                return;
            }
            const noPcmAttempts =
                (this.noPcmRetryCounts.get(captureKey) ?? 0) + 1;
            this.noPcmRetryCounts.set(captureKey, noPcmAttempts);
            if (noPcmAttempts > MAX_NO_PCM_RETRIES) {
                audioCaptureLogger.warn(
                    `[${captureKey}] No PCM received within ${FIRST_PCM_TIMEOUT_MS}ms after ${MAX_NO_PCM_RETRIES} retries; giving up`
                );
                cleanup('no_pcm_timeout');
                return;
            }
            audioCaptureLogger.warn(
                `[${captureKey}] No PCM received within ${FIRST_PCM_TIMEOUT_MS}ms; resubscribing (${noPcmAttempts}/${MAX_NO_PCM_RETRIES})`
            );
            cleanup('no_pcm_timeout');
            this.startReceiverStream(guildId, userId, receiver, {
                isRetry: true,
                reason: 'no_pcm_timeout',
                forceStart: true,
            });
        }, FIRST_PCM_TIMEOUT_MS);

        pcmStream.on('data', onData);
        pcmStream.once('end', () => cleanup('pcm_end'));
        pcmStream.once('close', () => cleanup('pcm_close'));
        pcmStream.on('error', (err: Error) => {
            audioCaptureLogger.error(`[${captureKey}] PCM stream error:`, err);
            cleanup('pcm_error');
        });

        decoder.on('error', (err: Error) => {
            audioCaptureLogger.error(`[${captureKey}] Decoder error:`, err);
            cleanup('decoder_error');
        });

        opusStream.on('error', (err: Error) => {
            audioCaptureLogger.error(`[${captureKey}] Opus stream error:`, err);
            const shouldRetry = this.handleDecryptFailure(
                captureKey,
                guildId,
                userId,
                receiver,
                err
            );
            cleanup('opus_error');
            if (shouldRetry) {
                this.scheduleDecryptRetry(captureKey, guildId, userId, receiver);
            }
        });
        this.activeReceivers.set(captureKey, { cleanup });
    }

    private registerConnectionDebuggers(
        connection: VoiceConnection,
        guildId: string
    ): void {
        const existingConnection = this.connectionByGuild.get(guildId);
        if (existingConnection && existingConnection !== connection) {
            audioCaptureLogger.warn(
                `Voice connection replaced for guild ${guildId}; re-binding receiver listeners`
            );
            this.detachConnectionDebuggers(guildId, existingConnection);
            this.captureInitialized.delete(guildId);
        }

        this.connectionByGuild.set(guildId, connection);

        if (!this.connectionStateListeners.has(guildId)) {
            const onStateChange = (
                oldState: VoiceConnectionState,
                newState: VoiceConnectionState
            ) => {
                const oldSummary = this.describeConnectionState(oldState);
                const newSummary = this.describeConnectionState(newState);
                audioCaptureLogger.debug(
                    `[voice-connection:${guildId}] State change`,
                    {
                        oldStatus: oldSummary.status,
                        newStatus: newSummary.status,
                        oldNetworkingStatus: oldSummary.networkingStatus,
                        newNetworkingStatus: newSummary.networkingStatus,
                        encryptionMode:
                            connection.receiver.connectionData
                                ?.encryptionMode,
                    }
                );

                if (
                    oldSummary.networkingRef &&
                    newSummary.networkingRef &&
                    oldSummary.networkingRef !== newSummary.networkingRef
                ) {
                    audioCaptureLogger.warn(
                        `[voice-connection:${guildId}] Networking instance replaced; receiver bindings may have been refreshed`
                    );
                }

                if (
                    newState.status === VoiceConnectionStatus.Ready &&
                    oldState.status !== VoiceConnectionStatus.Ready
                ) {
                    this.resubscribeActiveSpeakers(guildId, connection.receiver);
                }
            };

            connection.on('stateChange', onStateChange);
            this.connectionStateListeners.set(guildId, onStateChange);
        }

        if (!this.ssrcMapListeners.has(guildId)) {
            const onCreate = (newData: VoiceUserData) => {
                const ssrcKey = this.getCaptureKey(guildId, newData.userId);
                this.lastSsrcUpdateMs.set(ssrcKey, Date.now());
            };
            const onUpdate = (
                _oldData: VoiceUserData | undefined,
                newData: VoiceUserData
            ) => {
                const ssrcKey = this.getCaptureKey(guildId, newData.userId);
                this.lastSsrcUpdateMs.set(ssrcKey, Date.now());
            };
            const onDelete = (deletedData: VoiceUserData) => {
                const ssrcKey = this.getCaptureKey(guildId, deletedData.userId);
                this.lastSsrcUpdateMs.delete(ssrcKey);
            };

            connection.receiver.ssrcMap.on('create', onCreate);
            connection.receiver.ssrcMap.on('update', onUpdate);
            connection.receiver.ssrcMap.on('delete', onDelete);
            this.ssrcMapListeners.set(guildId, { onCreate, onUpdate, onDelete });
        }
    }

    private detachConnectionDebuggers(
        guildId: string,
        connection: VoiceConnection
    ): void {
        const stateListener = this.connectionStateListeners.get(guildId);
        if (stateListener) {
            connection.off('stateChange', stateListener);
            this.connectionStateListeners.delete(guildId);
        }

        const ssrcListeners = this.ssrcMapListeners.get(guildId);
        if (ssrcListeners) {
            connection.receiver.ssrcMap.off('create', ssrcListeners.onCreate);
            connection.receiver.ssrcMap.off('update', ssrcListeners.onUpdate);
            connection.receiver.ssrcMap.off('delete', ssrcListeners.onDelete);
            this.ssrcMapListeners.delete(guildId);
        }
    }

    private describeConnectionState(state: VoiceConnectionState): {
        status: VoiceConnectionState['status'];
        networkingStatus?: string;
        networkingRef?: unknown;
    } {
        if ('networking' in state) {
            const networkingState = state.networking?.state as
                | { status?: string }
                | undefined;
            return {
                status: state.status,
                networkingStatus: networkingState?.status,
                networkingRef: state.networking,
            };
        }
        return { status: state.status };
    }

    private handleDecryptFailure(
        captureKey: string,
        guildId: string,
        userId: string,
        receiver: VoiceReceiver,
        error: Error
    ): boolean {
        const message = String(error?.message ?? error);
        const isDecryptFailure =
            message.includes('DecryptionFailed') ||
            message.includes('Failed to decrypt');

        if (!isDecryptFailure) {
            return false;
        }

        const attempt = (this.decryptRetryCounts.get(captureKey) ?? 0) + 1;
        this.decryptRetryCounts.set(captureKey, attempt);

        if (attempt > MAX_DECRYPT_RETRIES) {
            audioCaptureLogger.warn(
                `[${captureKey}] Decryption failed; giving up after ${MAX_DECRYPT_RETRIES} retries`
            );
            return false;
        }

        const connectionState = receiver.voiceConnection.state;
        audioCaptureLogger.warn(
            `[${captureKey}] Decryption failed; scheduling retry ${attempt}/${MAX_DECRYPT_RETRIES}`,
            {
                connectionStatus: connectionState.status,
            }
        );

        return true;
    }

    private scheduleDecryptRetry(
        captureKey: string,
        guildId: string,
        userId: string,
        receiver: VoiceReceiver
    ): void {
        const existingTimer = this.decryptRetryTimers.get(captureKey);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const retryTimer = setTimeout(() => {
            this.decryptRetryTimers.delete(captureKey);

            if (this.activeReceivers.has(captureKey)) {
                return;
            }
            if (this.shouldIgnoreUser(guildId, userId)) {
                return;
            }
            if (receiver.voiceConnection.state.status !== VoiceConnectionStatus.Ready) {
                audioCaptureLogger.debug(
                    `[${captureKey}] Skipping decrypt retry because connection is not ready`
                );
                return;
            }

            this.startReceiverStream(guildId, userId, receiver, {
                isRetry: true,
                reason: 'decrypt_retry',
            });
        }, DECRYPT_RETRY_DELAY_MS);

        this.decryptRetryTimers.set(captureKey, retryTimer);
    }

    private getActiveSpeakerCount(guildId: string): number {
        let count = 0;
        for (const key of this.activeReceivers.keys()) {
            if (key.startsWith(`${guildId}:`)) {
                count += 1;
            }
        }
        return count;
    }

    private emitSpeakerStart(guildId: string, userId: string): void {
        const activeSpeakerCount = this.getActiveSpeakerCount(guildId);
        const event: SpeakerStartEvent = {
            guildId,
            userId,
            activeSpeakerCount,
        };
        this.emit('speakerStart', event);
    }

    private emitSpeakerSilence(event: SpeakerSilenceEvent): void {
        this.emit('speakerSilence', event);
    }

    private scheduleSsrcRetry(
        captureKey: string,
        guildId: string,
        userId: string,
        receiver: VoiceReceiver,
        reason?: string
    ): void {
        const attempt = (this.ssrcRetryCounts.get(captureKey) ?? 0) + 1;
        this.ssrcRetryCounts.set(captureKey, attempt);

        if (attempt > MAX_SSRC_WAIT_RETRIES) {
            audioCaptureLogger.warn(
                `[${captureKey}] SSRC mapping not ready after ${MAX_SSRC_WAIT_RETRIES} retries`
            );
            this.startReceiverStream(guildId, userId, receiver, {
                isRetry: true,
                reason: reason ?? 'ssrc_wait_exhausted',
                forceStart: true,
            });
            return;
        }

        const existingTimer = this.ssrcRetryTimers.get(captureKey);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const retryTimer = setTimeout(() => {
            this.ssrcRetryTimers.delete(captureKey);

            if (this.activeReceivers.has(captureKey)) {
                return;
            }
            if (this.shouldIgnoreUser(guildId, userId)) {
                return;
            }

            this.startReceiverStream(guildId, userId, receiver, {
                isRetry: true,
                reason: reason ?? 'ssrc_wait',
            });
        }, SSRC_WAIT_DELAY_MS);

        this.ssrcRetryTimers.set(captureKey, retryTimer);
    }

    private resubscribeActiveSpeakers(
        guildId: string,
        receiver: VoiceReceiver
    ): void {
        const activeSpeakers = Array.from(receiver.speaking.users.keys());
        if (activeSpeakers.length === 0) {
            return;
        }

        audioCaptureLogger.debug(
            `[voice-connection:${guildId}] Connection ready; re-subscribing to active speakers`,
            {
                speakerCount: activeSpeakers.length,
            }
        );

        for (const userId of activeSpeakers) {
            if (this.shouldIgnoreUser(guildId, userId)) {
                continue;
            }
            this.startReceiverStream(guildId, userId, receiver, {
                isRetry: true,
                reason: 'connection_ready',
            });
        }
    }

    public cleanupGuild(guildId: string): void {
        for (const key of Array.from(this.activeReceivers.keys())) {
            if (!key.startsWith(`${guildId}:`)) continue;
            const receiver = this.activeReceivers.get(key);
            receiver?.cleanup();
        }

        for (const key of Array.from(this.ssrcRetryTimers.keys())) {
            if (!key.startsWith(`${guildId}:`)) continue;
            const timer = this.ssrcRetryTimers.get(key);
            if (timer) {
                clearTimeout(timer);
            }
            this.ssrcRetryTimers.delete(key);
            this.ssrcRetryCounts.delete(key);
        }

        for (const key of Array.from(this.decryptRetryTimers.keys())) {
            if (!key.startsWith(`${guildId}:`)) continue;
            const timer = this.decryptRetryTimers.get(key);
            if (timer) {
                clearTimeout(timer);
            }
            this.decryptRetryTimers.delete(key);
            this.decryptRetryCounts.delete(key);
        }

        for (const key of Array.from(this.lastSsrcUpdateMs.keys())) {
            if (!key.startsWith(`${guildId}:`)) continue;
            this.lastSsrcUpdateMs.delete(key);
        }

        const connection = this.connectionByGuild.get(guildId);
        if (connection) {
            this.detachConnectionDebuggers(guildId, connection);
            this.connectionByGuild.delete(guildId);
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
            speakerStartListeners: this.listenerCount('speakerStart'),
            speakerSilenceListeners: this.listenerCount('speakerSilence'),
        };
    }
}

export type { AudioChunkEvent, SpeakerStartEvent, SpeakerSilenceEvent };

