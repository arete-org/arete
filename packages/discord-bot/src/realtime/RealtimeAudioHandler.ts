/**
 * @description: Manages real-time audio streaming to the backend realtime voice boundary.
 * @footnote-scope: core
 * @footnote-module: RealtimeAudioHandler
 * @footnote-risk: high - Handles audio buffering and speaker annotation. Failures can cause audio desync, dropped frames, or API errors.
 * @footnote-ethics: high - Streams user audio to external AI services, affecting privacy, data handling, and the quality of real-time AI interactions.
 */

import { logger } from '../utils/logger.js';
import type { InternalVoiceRealtimeClientEvent } from '@footnote/contracts/voice';

/**
 * @footnote-logger: realtimeAudioHandler
 * @logs: Audio buffer lifecycle for realtime voice streaming.
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
 * The backend session uses server-managed turn detection, so Discord streams
 * audio bytes and lets the provider decide when to commit/respond.
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
