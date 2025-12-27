/**
 * @description: Routes realtime API events and streams text/audio deltas.
 * @arete-scope: core
 * @arete-module: RealtimeEventHandler
 * @arete-risk: high - Event mishandling can break live audio or message delivery.
 * @arete-ethics: high - Realtime audio flow affects privacy and user expectations.
 */
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { RealtimeEvent, RealtimeResponseTextDeltaEvent, RealtimeResponseAudioDeltaEvent, RealtimeResponseCompletedEvent, RealtimeErrorEvent } from '../utils/realtimeService.js';
import { RealtimeWebSocketManager } from './RealtimeWebSocketManager.js';

export class RealtimeEventHandler extends EventEmitter {
    private wsManager: RealtimeWebSocketManager | null = null;
    private isEventHandlersSetup = false;
    private audioBuffer: Buffer[] = [];
    private isCollectingAudio = false;

    constructor() {
        super();
        this.setMaxListeners(20); // Increase max listeners to prevent memory leak warnings
        this.setupInternalEventHandlers();
    }

    private setupInternalEventHandlers(): void {
        // Handle AI responses
        this.on('response.text.delta', (event: RealtimeResponseTextDeltaEvent) => {
            this.emit('text', event.delta);
        });

        // Handle model output audio - stream chunks immediately
        this.on('response.output_audio.delta', (event: RealtimeResponseAudioDeltaEvent) => {
            try {
                if (!event.delta) {
                    logger.warn('[RealtimeEventHandler] Received empty audio delta');
                    return;
                }
                
                const audioData = Buffer.from(event.delta, 'base64');
                logger.debug(`[RealtimeEventHandler] Processing audio chunk: ${audioData.length} bytes`);
                
                // Emit the audio data immediately for real-time playback
                this.emit('audio', audioData);
                
                // Also emit the raw event for other handlers
                this.emit('event', { 
                    type: 'response.output_audio.delta', 
                    delta: event.delta,
                    audioData: audioData
                });
                
                // Buffer the audio data for potential later use
                if (!this.isCollectingAudio) {
                    this.isCollectingAudio = true;
                    this.audioBuffer = [];
                }
                this.audioBuffer.push(audioData);
                
            } catch (error) {
                logger.error('[RealtimeEventHandler] Error processing audio delta:', error);
            }
        });

        // Handle audio completion - finalize and clear buffer without re-emitting duplicate events
        this.on('response.output_audio.done', () => {
            logger.debug('[RealtimeEventHandler] Audio stream completed');
            
            // We already emit streaming deltas as 'audio'. Do NOT emit the full concatenated audio again.
            // Just clear the collection state to prepare for the next stream.
            if (this.isCollectingAudio) {
                const bufferedChunks = this.audioBuffer.slice();
                const totalBytes = bufferedChunks.reduce((n, b) => n + b.length, 0);
                logger.debug(`[RealtimeEventHandler] Final buffered length: ${totalBytes} bytes`);
            }
            this.isCollectingAudio = false;
            this.audioBuffer = [];
        });

        // Handle response completion
        this.on('response.completed', (event: RealtimeResponseCompletedEvent) => {
            this.emit('responseComplete', event);
        });

        // Handle errors
        this.on('error', (event: RealtimeErrorEvent) => {
            logger.error('Realtime API error:', event.error);
        });

        // Handle audio buffer collected
        this.on('conversation.item.input_audio_buffer.collected', () => {
            this.emit('audio_collected');
        });
    }

    public handleEvent(event: RealtimeEvent): void {
        logger.debug(`[realtime] Handling event: ${event.type}`);

        // Special handling for audio buffer events
        if (event.type === 'input_audio_buffer.committed' ||
            event.type === 'conversation.item.input_audio_buffer.collected' ||
            event.type === 'audio_collected') {

            logger.debug(`[realtime] Audio buffer event received: ${event.type}, emitting audio_collected`);
            
            // Emit the audio_collected event with the original event data
            this.emit('audio_collected', event);

            // Also emit a generic event for backward compatibility, but avoid duplication
            if (event.type !== 'audio_collected') {
                const { type, ...rest } = event;
                this.emit('event', { type: 'audio_collected', ...rest });
            }
        } else {
            // Emit both the specific event type and a generic 'event' for other events
            this.emit(event.type, event);
            this.emit('event', event);
        }

        // Log any errors we receive
        if (event.type === 'error') {
            if (isRealtimeErrorEvent(event)) {
                logger.error(`[realtime] Error from server:`, event.error);
                return;
            }
            logger.error('[realtime] Error event received without error payload');
        }
    }

    public setupWebSocketEventHandlers(wsManager: RealtimeWebSocketManager): void {
        // Only set up event handlers once per WebSocket manager
        if (this.wsManager === wsManager && this.isEventHandlersSetup) {
            return;
        }

        // Clean up previous event handlers if switching WebSocket managers
        if (this.wsManager && this.wsManager !== wsManager) {
            this.cleanupWebSocketEventHandlers();
        }

        this.wsManager = wsManager;
        this.isEventHandlersSetup = true;

        wsManager.onMessage((data) => {
            try {
                const event = JSON.parse(data.toString()) as RealtimeEvent;
                this.handleEvent(event);
            } catch (error) {
                logger.error('Error parsing WebSocket message:', error);
            }
        });

        // Set up cleanup when WebSocket disconnects
        wsManager.onClose((_code, _reason) => {
            logger.warn(`WebSocket closed unexpectedly, cleaning up event handlers`);
            this.cleanupWebSocketEventHandlers();
        });
    }

    private cleanupWebSocketEventHandlers(): void {
        this.wsManager = null;
        this.isEventHandlersSetup = false;
    }

    public waitForResponseCompleted(): Promise<void> {
        return new Promise((resolve) => {
            const listener = () => {
                this.off('response.completed', listener);
                resolve();
            };
            this.on('response.completed', listener);
        });
    }

    public waitForAudioCollected(): Promise<void> {
        return new Promise((resolve) => {
            const listener = () => {
                this.off('audio_collected', listener);
                resolve();
            };
            this.on('audio_collected', listener);
        });
    }
}

const isRealtimeErrorEvent = (
    event: RealtimeEvent
): event is RealtimeEvent & { type: 'error'; error: RealtimeErrorEvent['error'] } => {
    return typeof event === 'object' && event !== null && 'error' in event && event.type === 'error';
};
