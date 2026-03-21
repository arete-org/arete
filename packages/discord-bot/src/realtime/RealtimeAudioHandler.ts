/**
 * @description: Manages real-time audio streaming to the backend realtime voice boundary.
 * @footnote-scope: core
 * @footnote-module: RealtimeAudioHandler
 * @footnote-risk: high - Handles audio buffering, speaker annotation, and commit timing. Failures can cause audio desync, dropped frames, or API errors.
 * @footnote-ethics: high - Streams user audio to external AI services, affecting privacy, data handling, and the quality of real-time AI interactions.
 */

import { logger } from '../utils/logger.js';
import type { InternalVoiceRealtimeClientEvent } from '@footnote/contracts/voice';

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

/**
 * Streams PCM audio to the backend realtime voice boundary.
 *
 * The backend session uses server VAD, so the provider owns turn boundaries
 * and the Discord client only appends audio bytes.
 */
export class RealtimeAudioHandler {
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

        sendEvent({
            type: 'input_audio.append',
            audioBase64: audioBuffer.toString('base64'),
            speakerLabel,
            speakerId,
        });

        audioLogger.debug(
            `[realtime] Sent audio chunk (${audioBuffer.length} bytes) for ${speakerLabel}`
        );
    }

    public async flushAudio(
        sendEvent: (event: InternalVoiceRealtimeClientEvent) => void
    ): Promise<void> {
        // Intentionally no-op. Server VAD owns the commit and response
        // boundary, so the Discord client should not send manual commits here.
        void sendEvent;
    }

    public clearAudio(
        sendEvent: (event: InternalVoiceRealtimeClientEvent) => void
    ): void {
        sendEvent({ type: 'input_audio.clear' });

        audioLogger.debug('[realtime] Cleared audio buffer');
    }

    public resetState(): void {
        // No local audio state to reset while server VAD owns turn handling.
    }
}

