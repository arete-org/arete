/**
 * @arete-module: RealtimeService
 * @arete-risk: high
 * @arete-ethics: high
 * @arete-scope: core
 *
 * @description: Core real-time AI session management and WebSocket coordination.
 *
 * @impact
 * Risk: Session failures can break all real-time AI functionality and waste resources. Manages WebSocket connections, session lifecycle, and audio streaming coordination.
 * Ethics: Controls real-time AI interactions in voice channels, affecting user privacy, consent, and the quality of live AI participation.
 */

import { EventEmitter } from 'events';
import { RealtimeWebSocketManager } from '../realtime/RealtimeWebSocketManager.js';
import { RealtimeAudioHandler } from '../realtime/RealtimeAudioHandler.js';
import { RealtimeEventHandler } from '../realtime/RealtimeEventHandler.js';
import { RealtimeSessionConfig } from '../realtime/RealtimeSessionConfig.js';

export interface RealtimeSessionOptions {
    model?: 'gpt-realtime' | 'gpt-4o-realtime-preview' | 'gpt-4o-mini-realtime-preview';
    voice?: 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer';
    instructions?: string;
    temperature?: number;
    maxResponseOutputTokens?: number;
}

export interface RealtimeEvent {
    type: string;
    [key: string]: unknown;
}

export interface AudioChunk {
    data: Buffer;
    timestamp: number;
}

export interface RealtimeResponseTextDeltaEvent {
    type: 'response.text.delta';
    delta: string;
}

export interface RealtimeResponseAudioDeltaEvent {
    type: 'response.audio.delta';
    delta: string; // base64 encoded audio data
}

export interface RealtimeResponseCompletedEvent {
    type: 'response.completed';
    response_id: string;
    [key: string]: unknown;
}

export interface RealtimeErrorEvent {
    type: 'error';
    error: {
        message: string;
        code: string;
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

    constructor(options: RealtimeSessionOptions = {}) {
        super();

        this.wsManager = new RealtimeWebSocketManager();
        this.audioHandler = new RealtimeAudioHandler();
        this.eventHandler = new RealtimeEventHandler();
        this.sessionConfig = new RealtimeSessionConfig(options);

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
    }

    /**
     * Connect to OpenAI's Realtime API
     */
    public async connect(): Promise<void> {
        const wsUrl = `wss://api.openai.com/v1/realtime?model=${this.sessionConfig.getModel()}`;
        const headers = {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        };

        await this.wsManager.connect(wsUrl, headers);
        this.eventHandler.setupWebSocketEventHandlers(this.wsManager);

        // Send session configuration
        const ws = this.wsManager.getWebSocket();
        if (ws) {
            this.sessionConfig.sendSessionConfig(ws);
            this.sessionConfig.enableVAD(ws);
        }
    }

    /**
     * Disconnect from the Realtime API
     */
    public disconnect(): void {
        this.wsManager.disconnect();
    }

    public async sendAudio(audioBuffer: Buffer, speakerLabel: string, speakerId?: string): Promise<void> {
        const ws = this.wsManager.getWebSocket();
        if (ws && this.audioHandler) {
            await this.audioHandler.sendAudio(ws, this.eventHandler, audioBuffer, speakerLabel, speakerId);
        }
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
        const ws = this.wsManager.getWebSocket();
        if (ws) {
            this.audioHandler.clearAudio(ws);
        }
    }

    public async flushAudio(): Promise<void> {
        const ws = this.wsManager.getWebSocket();
        if (ws && this.audioHandler) {
            await this.audioHandler.flushAudio(ws, this.eventHandler);
        }
    }

    /**
     * Start a new conversation turn
     */
    public createResponse(): void {
        const ws = this.wsManager.getWebSocket();
        if (ws) {
            this.sessionConfig.createResponse(ws);
        }
    }

    public async waitForResponseCompleted(): Promise<void> {
        if (this.eventHandler) {
            return this.eventHandler.waitForResponseCompleted();
        }
        throw new Error('Event handler not initialized');
    }

    public waitForAudioCollected(): Promise<void> {
        if (this.eventHandler) {
            return this.eventHandler.waitForAudioCollected();
        }
        throw new Error('Event handler not initialized');
    }

    public async sendGreeting(): Promise<void> {
        const ws = this.wsManager.getWebSocket();
        if (!ws) return;

        await new Promise(resolve => setTimeout(resolve, 300));

        ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello!' }] }
        }));

        ws.send(JSON.stringify({
            type: 'response.create',
            response: {
                output_modalities: ['audio'],
                instructions: (`${this.sessionConfig.getInstructions() ?? ''}` + " Say: Hello!").trim()
            }
        }));
    }
}

