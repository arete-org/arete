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
import { AudioCaptureHandler, AudioChunkEvent } from './AudioCaptureHandler.js';
import { AudioPlaybackHandler } from './AudioPlaybackHandler.js';

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
};

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

        session.audioCaptureHandler.on('audioChunk', chunkHandler);

        const sessionWithHandlers = session as VoiceSessionWithHandlers;
        sessionWithHandlers.audioChunkHandler = chunkHandler;

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
        voiceSessionLogger.debug(
            `Forwarding ${audioBuffer.length} bytes for ${label} (${userId}) in guild ${guildId}`
        );

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

    private cleanupSessionEventListeners(session: VoiceSession): void {
        const sessionWithHandlers = session as VoiceSessionWithHandlers;
        const chunkHandler = sessionWithHandlers.audioChunkHandler;
        if (chunkHandler) {
            session.audioCaptureHandler.off('audioChunk', chunkHandler);
            delete sessionWithHandlers.audioChunkHandler;
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

