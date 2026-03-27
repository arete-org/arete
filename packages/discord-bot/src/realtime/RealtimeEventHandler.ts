/**
 * @description: Routes realtime API events and streams text/audio deltas.
 * @footnote-scope: core
 * @footnote-module: RealtimeEventHandler
 * @footnote-risk: high - Event mishandling can break live audio or message delivery.
 * @footnote-ethics: high - Realtime audio flow affects privacy and user expectations.
 */
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import {
    RealtimeEvent,
    RealtimeResponseTextDeltaEvent,
    RealtimeResponseAudioDeltaEvent,
    RealtimeResponseDoneEvent,
    RealtimeErrorEvent,
} from '../utils/realtimeService.js';

export class RealtimeEventHandler extends EventEmitter {
    private audioBuffer: Buffer[] = [];
    private isCollectingAudio = false;
    private audioChunkCount = 0;
    private totalAudioBytes = 0;

    constructor() {
        super();
        this.setMaxListeners(20); // Increase max listeners to prevent memory leak warnings
        this.setupInternalEventHandlers();
    }

    private setupInternalEventHandlers(): void {
        // Text deltas are already normalized by the backend websocket handler.
        // This local handler just forwards them into the existing Discord
        // event flow.
        this.on(
            'response.output_text.delta',
            (event: RealtimeResponseTextDeltaEvent) => {
                this.emit('text', event.delta);
            }
        );

        // Stream output audio chunks immediately so playback can begin before
        // the full response finishes.
        this.on(
            'response.output_audio.delta',
            (event: RealtimeResponseAudioDeltaEvent) => {
                try {
                    if (!event.delta) {
                        logger.warn(
                            '[RealtimeEventHandler] Received empty audio delta'
                        );
                        return;
                    }

                    const audioData = Buffer.from(event.delta, 'base64');

                    // Playback wants bytes, not protocol envelopes.
                    this.emit('audio', audioData);

                    // Keep the raw event available for listeners that care
                    // about the exact per-chunk payload.
                    this.emit('event', {
                        type: 'response.output_audio.delta',
                        delta: event.delta,
                        audioData: audioData,
                    });

                    // We keep a temporary per-response buffer only so the
                    // handler knows whether it needs to clear streaming state
                    // when the response finishes.
                    if (!this.isCollectingAudio) {
                        this.isCollectingAudio = true;
                        this.audioBuffer = [];
                        this.audioChunkCount = 0;
                        this.totalAudioBytes = 0;
                        logger.debug(
                            '[RealtimeEventHandler] Audio stream started'
                        );
                    }
                    this.audioChunkCount += 1;
                    this.totalAudioBytes += audioData.length;
                    this.audioBuffer.push(audioData);
                } catch (error) {
                    logger.error(
                        '[RealtimeEventHandler] Error processing audio delta:',
                        error
                    );
                }
            }
        );

        // The Discord playback path already saw each streamed chunk. When the
        // response ends we clear local buffer state, but we do not emit a
        // second concatenated audio payload.
        this.on('response.output_audio.done', () => {
            logger.debug('[RealtimeEventHandler] Audio stream completed', {
                chunks: this.audioChunkCount,
                totalBytes: this.totalAudioBytes,
            });
            this.isCollectingAudio = false;
            this.audioBuffer = [];
            this.audioChunkCount = 0;
            this.totalAudioBytes = 0;
        });

        this.on('response.done', (event: RealtimeResponseDoneEvent) => {
            this.emit('responseComplete', event);
        });

        this.on('error', (event: RealtimeErrorEvent) => {
            logger.error('Realtime API error:', event.error);
        });
    }

    public handleEvent(event: RealtimeEvent): void {
        if (event.type === 'response.done' && 'response_id' in event) {
            logger.debug('[realtime] Response completed', {
                responseId: event.response_id,
            });
        }

        // Everything that reaches this point is already part of the
        // backend-owned realtime contract or a small local compatibility event
        // such as `response.output_audio.done`.
        this.emit(event.type, event);
        this.emit('event', event);

        if (event.type === 'error') {
            if (isRealtimeErrorEvent(event)) {
                logger.error(`[realtime] Error from server:`, event.error);
                return;
            }
            logger.error(
                '[realtime] Error event received without error payload'
            );
        }
    }

    public waitForResponseCompleted(): Promise<void> {
        return new Promise((resolve) => {
            const listener = () => {
                this.off('response.done', listener);
                resolve();
            };
            this.on('response.done', listener);
        });
    }
}

const isRealtimeErrorEvent = (
    event: RealtimeEvent
): event is RealtimeEvent & {
    type: 'error';
    error: RealtimeErrorEvent['error'];
} => {
    return (
        typeof event === 'object' &&
        event !== null &&
        'error' in event &&
        event.type === 'error'
    );
};
