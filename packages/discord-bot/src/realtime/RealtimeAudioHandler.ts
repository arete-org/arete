/**
 * @description: Manages real-time audio streaming to the backend realtime voice boundary.
 * @footnote-scope: core
 * @footnote-module: RealtimeAudioHandler
 * @footnote-risk: high - Handles audio buffering, speaker annotation, and commit timing. Failures can cause audio desync, dropped frames, or API errors.
 * @footnote-ethics: high - Streams user audio to external AI services, affecting privacy, data handling, and the quality of real-time AI interactions.
 */

import { logger } from '../utils/logger.js';
import type { InternalVoiceRealtimeClientEvent } from '@footnote/contracts/voice';

const COMMIT_INACTIVITY_MS = 320;

/**
 * @footnote-logger: realtimeAudioHandler
 * @logs: Audio buffer lifecycle and commit cadence for realtime voice streaming.
 * @footnote-risk: high - Missing logs make audio dropouts hard to debug.
 * @footnote-ethics: high - Audio is privacy-sensitive; log sizes and timing only.
 */
const audioLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'realtimeAudioHandler' })
        : logger;

interface PendingSpeaker {
    label: string;
    userId?: string;
}

/**
 * Streams PCM audio to the realtime API and commits buffers on cadence.
 */
export class RealtimeAudioHandler {
    private pendingCommit = false;
    private lastAppendTime = 0;
    private pendingSpeaker: PendingSpeaker | null = null;
    private commitTimer: NodeJS.Timeout | null = null;

    public async sendAudio(
        sendEvent: (event: InternalVoiceRealtimeClientEvent) => void,
        audioBuffer: Buffer,
        speakerLabel: string,
        speakerId?: string
    ): Promise<void> {
        if (!audioBuffer || audioBuffer.length === 0) {
            audioLogger.debug('[realtime] Ignoring empty audio buffer');
            return;
        }

        if (this.pendingSpeaker && this.pendingSpeaker.label !== speakerLabel) {
            await this.flushAudio(sendEvent);
        }

        sendEvent({
            type: 'input_audio.append',
            audioBase64: audioBuffer.toString('base64'),
            speakerLabel,
            speakerId,
        });

        this.pendingSpeaker = { label: speakerLabel, userId: speakerId };
        this.lastAppendTime = Date.now();
        this.pendingCommit = true;

        audioLogger.debug(
            `[realtime] Sent audio chunk (${audioBuffer.length} bytes) for ${speakerLabel}`
        );

        this.scheduleCommit(sendEvent);
    }

    private scheduleCommit(
        sendEvent: (event: InternalVoiceRealtimeClientEvent) => void
    ): void {
        if (this.commitTimer) {
            clearTimeout(this.commitTimer);
        }

        this.commitTimer = setTimeout(() => {
            void this.flushAudio(sendEvent).catch((error) => {
                audioLogger.error('[realtime] Failed to flush audio buffer:', error);
            });
        }, COMMIT_INACTIVITY_MS);
    }

    public async flushAudio(
        sendEvent: (event: InternalVoiceRealtimeClientEvent) => void
    ): Promise<void> {
        if (!this.pendingCommit) {
            return;
        }

        if (this.commitTimer) {
            clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }

        const elapsed = Date.now() - this.lastAppendTime;
        if (elapsed < 20) {
            await new Promise((resolve) => setTimeout(resolve, 20 - elapsed));
        }

        sendEvent({ type: 'input_audio.commit' });
        audioLogger.debug('[realtime] Committed audio buffer');

        this.pendingCommit = false;
        this.pendingSpeaker = null;
    }

    public clearAudio(
        sendEvent: (event: InternalVoiceRealtimeClientEvent) => void
    ): void {
        sendEvent({ type: 'input_audio.clear' });
        this.pendingCommit = false;
        this.pendingSpeaker = null;
        if (this.commitTimer) {
            clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }

        audioLogger.debug('[realtime] Cleared audio buffer');
    }

    public resetState(): void {
        this.pendingCommit = false;
        this.pendingSpeaker = null;
        this.lastAppendTime = 0;
        if (this.commitTimer) {
            clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }
    }
}

