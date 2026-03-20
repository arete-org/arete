/**
 * @description: Core real-time AI session management and WebSocket coordination.
 * @footnote-scope: core
 * @footnote-module: RealtimeService
 * @footnote-risk: high - Session failures can break all real-time AI functionality and waste resources. Manages WebSocket connections, session lifecycle, and audio streaming coordination.
 * @footnote-ethics: high - Controls real-time AI interactions in voice channels, affecting user privacy, consent, and the quality of live AI participation.
 */

import { EventEmitter } from 'events';
import { runtimeConfig } from '../config.js';
import { RealtimeWebSocketManager } from '../realtime/RealtimeWebSocketManager.js';
import { RealtimeAudioHandler } from '../realtime/RealtimeAudioHandler.js';
import { RealtimeEventHandler } from '../realtime/RealtimeEventHandler.js';
import { RealtimeSessionConfig } from '../realtime/RealtimeSessionConfig.js';
import { logger } from '../utils/logger.js';
import type {
    InternalVoiceRealtimeClientEvent,
    InternalVoiceRealtimeOptions,
    InternalVoiceRealtimeServerEvent,
    InternalVoiceSessionContext,
} from '@footnote/contracts/voice';
import { InternalVoiceRealtimeServerEventSchema } from '@footnote/contracts/voice';

/**
 * Runtime options used when opening a new OpenAI realtime session.
 */
export interface RealtimeSessionOptions {
    context?: InternalVoiceSessionContext;
    model?: InternalVoiceRealtimeOptions['model'];
    voice?: InternalVoiceRealtimeOptions['voice'];
    temperature?: number;
    maxResponseOutputTokens?: number;
}

/**
 * Base event shape forwarded from the realtime event handler.
 */
export interface RealtimeEvent {
    type: string;
    [key: string]: unknown;
}

/**
 * Audio payload tagged with the timestamp captured by the realtime pipeline.
 */
export interface AudioChunk {
    data: Buffer;
    timestamp: number;
}

/**
 * Incremental text delta emitted while a realtime response is streaming.
 */
export interface RealtimeResponseTextDeltaEvent {
    type: 'response.text.delta';
    delta: string;
}

/**
 * Incremental audio delta emitted while a realtime response is streaming.
 */
export interface RealtimeResponseAudioDeltaEvent {
    type: 'response.audio.delta';
    delta: string; // base64 encoded audio data
}

/**
 * Event emitted when OpenAI marks the current realtime response as complete.
 */
export interface RealtimeResponseCompletedEvent {
    type: 'response.completed';
    response_id: string;
    [key: string]: unknown;
}

/**
 * Structured error event forwarded from the realtime API.
 */
export interface RealtimeErrorEvent {
    type: 'error';
    error: {
        message: string;
        code?: string;
        [key: string]: unknown;
    };
}

/**
 * Manages a connection to OpenAI's Realtime API
 */
export class RealtimeSession extends EventEmitter {
    private wsManager: RealtimeWebSocketManager;
    private audioHandler: RealtimeAudioHandler;
    private eventHandler: RealtimeEventHandler;
    private sessionConfig: RealtimeSessionConfig;
    private sessionContext: InternalVoiceSessionContext;

    constructor(options: RealtimeSessionOptions = {}) {
        super();

        this.wsManager = new RealtimeWebSocketManager();
        this.audioHandler = new RealtimeAudioHandler();
        this.eventHandler = new RealtimeEventHandler();
        this.sessionConfig = new RealtimeSessionConfig(options);
        this.sessionContext = options.context ?? { participants: [] };

        // Forward all events from eventHandler to RealtimeSession
        this.eventHandler.on('event', (event: RealtimeEvent) => {
            // Emit the event with its type
            this.emit(event.type, event);
        });

        // Special handling for audio events to ensure they're properly forwarded
        this.eventHandler.on('audio', (audioData: Buffer) => {
            this.emit('audio', audioData);
        });

        // Forward text events
        this.eventHandler.on('text', (text: string) => {
            this.emit('text', text);
        });

        this.wsManager.onMessage((data) => {
            this.handleBackendEvent(data.toString());
        });
    }

    /**
     * Connect to OpenAI's Realtime API
     */
    public async connect(): Promise<void> {
        const wsUrl = this.buildBackendRealtimeUrl(
            runtimeConfig.backendBaseUrl
        );
        const headers: Record<string, string> = {};
        if (runtimeConfig.traceApiToken) {
            headers['X-Trace-Token'] = runtimeConfig.traceApiToken;
        }

        await this.wsManager.connect(wsUrl, headers);
        this.sendClientEvent({
            type: 'session.start',
            context: this.sessionContext,
            options: this.sessionConfig.getOptions(),
        });
    }

    /**
     * Disconnect from the Realtime API
     */
    public disconnect(): void {
        this.wsManager.disconnect();
    }

    public async sendAudio(
        audioBuffer: Buffer,
        speakerLabel: string,
        speakerId?: string
    ): Promise<void> {
        if (!this.audioHandler) {
            return;
        }

        await this.audioHandler.sendAudio(
            this.sendClientEvent.bind(this),
            audioBuffer,
            speakerLabel,
            speakerId
        );
    }

    /**
     * Commit the current audio buffer for processing
     */
    public async commitAudio(): Promise<void> {
        await this.flushAudio();
    }

    /**
     * Clear the current audio buffer
     */
    public clearAudio(): void {
        if (!this.audioHandler) {
            return;
        }

        this.audioHandler.clearAudio(this.sendClientEvent.bind(this));
    }

    public async flushAudio(): Promise<void> {
        if (!this.audioHandler) {
            return;
        }

        await this.audioHandler.flushAudio(this.sendClientEvent.bind(this));
    }

    /**
     * Start a new conversation turn
     */
    public createResponse(): void {
        this.sendClientEvent({ type: 'response.create' });
    }

    public async waitForResponseCompleted(): Promise<void> {
        if (this.eventHandler) {
            return this.eventHandler.waitForResponseCompleted();
        }
        throw new Error('Event handler not initialized');
    }

    public waitForAudioCollected(): Promise<void> {
        return Promise.resolve();
    }

    public async sendGreeting(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 300));
        this.sendClientEvent({ type: 'input_text.create', text: 'Hello!' });
        this.sendClientEvent({ type: 'response.create' });
    }

    private buildBackendRealtimeUrl(baseUrl: string): string {
        const trimmed = baseUrl.trim().replace(/\/+$/, '');
        if (!trimmed) {
            return 'ws://localhost:3000/api/internal/voice/realtime';
        }

        const hasProtocol = /^https?:\/\//i.test(trimmed);
        const normalized = hasProtocol ? trimmed : `http://${trimmed}`;
        const wsScheme = normalized.startsWith('https://') ? 'wss://' : 'ws://';
        const withoutScheme = normalized.replace(/^https?:\/\//i, '');
        return `${wsScheme}${withoutScheme}/api/internal/voice/realtime`;
    }

    private sendClientEvent(event: InternalVoiceRealtimeClientEvent): void {
        if (!this.wsManager.isConnectionReady()) {
            throw new Error('Session is not connected');
        }

        this.wsManager.send(JSON.stringify(event));
    }

    private handleBackendEvent(raw: string): void {
        let parsed: InternalVoiceRealtimeServerEvent;
        try {
            parsed = JSON.parse(raw) as InternalVoiceRealtimeServerEvent;
        } catch (error) {
            logger.warn('[realtime] Ignoring malformed backend event payload.', {
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }

        const validation =
            InternalVoiceRealtimeServerEventSchema.safeParse(parsed);
        if (!validation.success) {
            logger.warn('[realtime] Ignoring invalid backend event shape.', {
                issues: validation.error.issues,
            });
            return;
        }

        const event = validation.data;
        if (event.type === 'session.ready') {
            this.emit('connected');
            return;
        }

        // Emit an audio-done signal when the response completes so the audio
        // handler can clear its per-response buffer.
        if (event.type === 'response.completed') {
            this.eventHandler.handleEvent({
                type: 'response.output_audio.done',
            });
        }

        const mapped = mapInternalEventToRealtimeEvent(event);
        if (mapped) {
            this.eventHandler.handleEvent(mapped);
        }

        if (event.type === 'session.closed') {
            this.emit('error', new Error(event.reason ?? 'session closed'));
        }
    }
}

const mapInternalEventToRealtimeEvent = (
    event: InternalVoiceRealtimeServerEvent
): RealtimeEvent | null => {
    switch (event.type) {
        case 'output_audio.delta':
            return {
                type: 'response.output_audio.delta',
                delta: event.audioBase64,
            };
        case 'output_text.delta':
            return {
                type: 'response.text.delta',
                delta: event.text,
            };
        case 'response.completed':
            return {
                type: 'response.completed',
                response_id: event.responseId ?? '',
            };
        case 'error':
            return {
                type: 'error',
                error: {
                    message: event.message,
                    code: event.code,
                },
            };
        default:
            return null;
    }
};

