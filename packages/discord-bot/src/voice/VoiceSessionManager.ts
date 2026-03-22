/**
 * @description: Manages voice session state and coordinates audio event handling.
 * @footnote-scope: core
 * @footnote-module: VoiceSessionManager
 * @footnote-risk: high - Handles session creation, audio chunk forwarding, and cleanup. Failures can cause memory leaks, orphaned sessions, or audio processing errors.
 * @footnote-ethics: high - Manages the lifecycle of voice interactions, affecting when and how user audio is processed and how AI responses are delivered.
 */

import { VoiceConnection } from '@discordjs/voice';
import { RealtimeSession } from '../utils/realtimeService.js';
import { logger } from '../utils/logger.js';
import {
    AudioCaptureHandler,
    AudioChunkEvent,
    SpeakerSilenceEvent,
} from './AudioCaptureHandler.js';
import { AudioPlaybackHandler } from './AudioPlaybackHandler.js';
import { AUDIO_CONSTANTS } from '../constants/voice.js';
import { runtimeConfig } from '../config.js';

/**
 * @footnote-logger: voiceSessionManager
 * @logs: Session lifecycle and audio forwarding metadata for realtime voice.
 * @footnote-risk: high - Missing logs hide dropped audio or stalled sessions.
 * @footnote-ethics: high - Voice sessions are privacy sensitive; log metadata only.
 */
const voiceSessionLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'voiceSessionManager' })
        : logger;

export interface VoiceSession {
    connection: VoiceConnection;
    realtimeSession: RealtimeSession;
    audioCaptureHandler: AudioCaptureHandler;
    audioPlaybackHandler: AudioPlaybackHandler;
    isActive: boolean;
    lastAudioTime: number;
    initiatingUserId?: string;
    participantLabels: Map<string, string>;
    audioPipeline: Promise<void>;
}

type VoiceSessionWithHandlers = VoiceSession & {
    audioChunkHandler?: (event: AudioChunkEvent) => void;
    speakerSilenceHandler?: (event: SpeakerSilenceEvent) => void;
};

const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const DEFAULT_SILENCE_TAIL_MS = 600;
const MIN_SILENCE_TAIL_MS = 200;
const MAX_SILENCE_TAIL_MS = 1200;

export class VoiceSessionManager {
    private activeSessions: Map<string, VoiceSession> = new Map();

    public createSession(
        connection: VoiceConnection,
        realtimeSession: RealtimeSession,
        audioCaptureHandler: AudioCaptureHandler,
        audioPlaybackHandler: AudioPlaybackHandler,
        participants: Map<string, string>,
        initiatingUserId?: string
    ): VoiceSession {
        return {
            connection,
            realtimeSession,
            audioCaptureHandler,
            audioPlaybackHandler,
            isActive: false,
            lastAudioTime: Date.now(),
            initiatingUserId,
            participantLabels: new Map(participants),
            audioPipeline: Promise.resolve(),
        };
    }

    public addSession(guildId: string, session: VoiceSession): void {
        voiceSessionLogger.debug(
            `Adding session for guild ${guildId}, current sessions: ${this.activeSessions.size}`
        );

        const existingSession = this.activeSessions.get(guildId);
        if (existingSession) {
            voiceSessionLogger.warn(
                `Session already exists for guild ${guildId}, cleaning up existing session`
            );
            this.cleanupSessionEventListeners(existingSession);
        }

        this.activeSessions.set(guildId, session);

        const chunkHandler = (event: AudioChunkEvent) => {
            if (event.guildId !== guildId) return;
            this.enqueueAudioTask(guildId, async () => {
                await this.forwardAudioChunk(
                    guildId,
                    event.userId,
                    event.audioBuffer
                );
            });
        };

        const silenceHandler = (event: SpeakerSilenceEvent) => {
            if (event.guildId !== guildId) return;
            if (event.chunkCount === 0 || event.totalBytes === 0) {
                return;
            }
            this.enqueueAudioTask(guildId, async () => {
                await this.appendSilenceTail(
                    guildId,
                    event.userId
                );
            });
        };

        session.audioCaptureHandler.on('audioChunk', chunkHandler);
        session.audioCaptureHandler.on('speakerSilence', silenceHandler);

        const sessionWithHandlers = session as VoiceSessionWithHandlers;
        sessionWithHandlers.audioChunkHandler = chunkHandler;
        sessionWithHandlers.speakerSilenceHandler = silenceHandler;

        voiceSessionLogger.debug(
            `Added voice session for guild ${guildId}, total sessions: ${this.activeSessions.size}`
        );
    }

    private enqueueAudioTask(guildId: string, task: () => Promise<void>): void {
        const session = this.activeSessions.get(guildId);
            if (!session) return;

            session.audioPipeline = session.audioPipeline
            .catch((error) => {
                voiceSessionLogger.error(
                    `Audio pipeline error for guild ${guildId}:`,
                    error
                );
            })
            .then(task)
            .catch((error) => {
                voiceSessionLogger.error(
                    `Failed audio task for guild ${guildId}:`,
                    error
                );
            });
    }

    private async forwardAudioChunk(
        guildId: string,
        userId: string,
        audioBuffer: Buffer
    ): Promise<void> {
        const session = this.activeSessions.get(guildId);
        if (!session) {
            voiceSessionLogger.warn(
                `No session found for guild ${guildId} when forwarding audio chunk`
            );
            return;
        }

        if (!audioBuffer || audioBuffer.length === 0) {
            return;
        }

        const label = session.participantLabels.get(userId) || userId;

        try {
            await session.realtimeSession.sendAudio(audioBuffer, label, userId);
            session.lastAudioTime = Date.now();
        } catch (error) {
            voiceSessionLogger.error(
                `Failed to forward audio chunk for guild ${guildId}:`,
                error
            );
            throw error;
        }
    }

    private getSilenceTailMs(): number | null {
        if (runtimeConfig.realtime.turnDetection !== 'server_vad') {
            return null;
        }

        const configuredMs =
            runtimeConfig.realtime.turnDetectionConfig?.serverVad
                ?.silenceDurationMs;
        const baseMs =
            typeof configuredMs === 'number'
                ? configuredMs
                : DEFAULT_SILENCE_TAIL_MS;

        return Math.min(
            MAX_SILENCE_TAIL_MS,
            Math.max(MIN_SILENCE_TAIL_MS, baseMs)
        );
    }

    private async appendSilenceTail(
        guildId: string,
        userId: string
    ): Promise<void> {
        const session = this.activeSessions.get(guildId);
        if (!session) {
            return;
        }

        const tailMs = this.getSilenceTailMs();
        if (!tailMs) {
            return;
        }

        const totalSamples = Math.max(
            1,
            Math.floor((AUDIO_CONSTANTS.REALTIME_SAMPLE_RATE * tailMs) / 1000)
        );
        const totalBytes = totalSamples * BYTES_PER_SAMPLE;
        const chunkSize = AUDIO_CONSTANTS.MIN_AUDIO_BUFFER_SIZE;
        const label = session.participantLabels.get(userId) || userId;

        voiceSessionLogger.debug(
            `Appending ${tailMs}ms silence tail for ${label} (${userId}) in guild ${guildId}`,
            { totalBytes }
        );

        let remaining = totalBytes;
        while (remaining > 0) {
            const size = Math.min(chunkSize, remaining);
            const silenceChunk = Buffer.alloc(size);
            await session.realtimeSession.sendAudio(
                silenceChunk,
                label,
                userId
            );
            remaining -= size;
        }
        session.lastAudioTime = Date.now();
    }

    private cleanupSessionEventListeners(session: VoiceSession): void {
        const sessionWithHandlers = session as VoiceSessionWithHandlers;
        const chunkHandler = sessionWithHandlers.audioChunkHandler;
        if (chunkHandler) {
            session.audioCaptureHandler.off('audioChunk', chunkHandler);
            delete sessionWithHandlers.audioChunkHandler;
        }
        const silenceHandler = sessionWithHandlers.speakerSilenceHandler;
        if (silenceHandler) {
            session.audioCaptureHandler.off('speakerSilence', silenceHandler);
            delete sessionWithHandlers.speakerSilenceHandler;
        }
    }

    public updateParticipantLabel(
        guildId: string,
        userId: string,
        displayName: string
    ): void {
        const session = this.activeSessions.get(guildId);
        if (!session) return;
        session.participantLabels.set(userId, displayName);
    }

    public removeParticipant(guildId: string, userId: string): void {
        const session = this.activeSessions.get(guildId);
        if (!session) return;
        session.participantLabels.delete(userId);
    }

    public getSession(guildId: string): VoiceSession | undefined {
        return this.activeSessions.get(guildId);
    }

    public removeSession(guildId: string): void {
        const session = this.activeSessions.get(guildId);
        if (session) {
            try {
                this.cleanupSessionEventListeners(session);
                session.realtimeSession.disconnect();
            } catch (error) {
                voiceSessionLogger.error(
                    'Error disconnecting realtime session:',
                    error
                );
            }
        }
        this.activeSessions.delete(guildId);
        voiceSessionLogger.debug(
            `Removed voice session for guild ${guildId}, remaining sessions: ${this.activeSessions.size}`
        );
    }

    public getAllSessions(): Map<string, VoiceSession> {
        return this.activeSessions;
    }

    public hasSession(guildId: string): boolean {
        return this.activeSessions.has(guildId);
    }
}

