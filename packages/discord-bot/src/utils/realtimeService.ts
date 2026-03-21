/**
 * @description: Manages Discord's side of a backend-owned realtime voice session.
 * @footnote-scope: core
 * @footnote-module: RealtimeService
 * @footnote-risk: high - Session failures can break live voice replies or leave websocket state stuck.
 * @footnote-ethics: high - Live voice sessions handle privacy-sensitive audio and shape user-facing bot behavior.
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
    InternalVoiceRealtimeUsage,
    InternalVoiceSessionContext,
} from '@footnote/contracts/voice';
import { InternalVoiceRealtimeServerEventSchema } from '@footnote/contracts/voice';

/**
 * @footnote-logger: realtimeService
 * @logs: Backend websocket connection lifecycle and schema validation outcomes for realtime voice.
 * @footnote-risk: high - Missing logs hide realtime outages or protocol drift.
 * @footnote-ethics: high - Realtime audio is privacy-sensitive; log metadata only.
 */
const realtimeLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'realtimeService' })
        : logger;

/**
 * Runtime options used when opening a new backend realtime session.
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
 *
 * The backend normalizes provider-native events before they reach Discord, but
 * the Discord voice layer still uses these local event names so existing voice
 * orchestration code does not need to understand provider protocol details.
 */
export interface RealtimeResponseTextDeltaEvent {
    type: 'response.text.delta';
    delta: string;
}

/**
 * Incremental audio delta emitted while a realtime response is streaming.
 */
export interface RealtimeResponseAudioDeltaEvent {
    type: 'response.output_audio.delta';
    delta: string; // base64 encoded audio data
}

/**
 * Event emitted when the backend marks the current realtime response as complete.
 */
export interface RealtimeResponseCompletedEvent {
    type: 'response.completed';
    response_id: string;
    usage?: InternalVoiceRealtimeUsage;
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
 * Manages a connection to the backend realtime voice boundary.
 */
export class RealtimeSession extends EventEmitter {
    private wsManager: RealtimeWebSocketManager;
    private audioHandler: RealtimeAudioHandler;
    private eventHandler: RealtimeEventHandler;
    private sessionConfig: RealtimeSessionConfig;
    private sessionContext: InternalVoiceSessionContext;
    private sessionReady = false;
    private sessionReadyPromise: Promise<void> | null = null;
    private resolveSessionReady: (() => void) | null = null;
    private rejectSessionReady: ((error: Error) => void) | null = null;

    constructor(options: RealtimeSessionOptions = {}) {
        super();

        this.wsManager = new RealtimeWebSocketManager();
        this.audioHandler = new RealtimeAudioHandler();
        this.eventHandler = new RealtimeEventHandler();
        this.sessionConfig = new RealtimeSessionConfig(options);
        this.sessionContext = options.context ?? { participants: [] };

        // The event handler translates backend-owned protocol events into the
        // local event names that the older Discord voice flow already expects.
        this.eventHandler.on('event', (event: RealtimeEvent) => {
            this.emit(event.type, event);
        });

        // Audio and text also get their own convenience events so playback and
        // logging code can subscribe without parsing the raw event payload.
        this.eventHandler.on('audio', (audioData: Buffer) => {
            this.emit('audio', audioData);
        });

        this.eventHandler.on('text', (text: string) => {
            this.emit('text', text);
        });

        this.wsManager.onMessage((data) => {
            this.handleBackendEvent(data.toString());
        });
    }

    /**
     * Connect to the backend realtime voice boundary.
     */
    public async connect(): Promise<void> {
        const wsUrl = this.buildBackendRealtimeUrl(
            runtimeConfig.backendBaseUrl
        );
        realtimeLogger.info('Connecting to backend realtime websocket.', {
            url: wsUrl,
        });
        const headers: Record<string, string> = {};
        if (runtimeConfig.serviceToken) {
            headers['X-Service-Token'] = runtimeConfig.serviceToken;
        }
        if (runtimeConfig.traceApiToken) {
            headers['X-Trace-Token'] = runtimeConfig.traceApiToken;
        }
        if (Object.keys(headers).length === 0) {
            realtimeLogger.error(
                'Missing trusted service credentials for realtime websocket.'
            );
            throw new Error(
                'Realtime session requires a trusted service credential.'
            );
        }

        await this.wsManager.connect(wsUrl, headers);
        realtimeLogger.info('Backend realtime websocket connected.');
        this.sendClientEvent({
            type: 'session.start',
            context: this.sessionContext,
            options: this.sessionConfig.getOptions(),
        });
        await this.waitForSessionReady();
    }

    /**
     * Disconnect from the backend realtime voice boundary.
     */
    public disconnect(): void {
        realtimeLogger.info('Disconnecting backend realtime websocket.');
        this.wsManager.disconnect();
    }

    public async sendAudio(
        audioBuffer: Buffer,
        speakerLabel: string,
        speakerId?: string
    ): Promise<void> {
        await this.waitForSessionReady();
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
     * Compatibility shim for older callers.
     *
     * Server VAD owns the turn boundary, so this now intentionally does
     * nothing instead of sending a manual commit.
     */
    public async commitAudio(): Promise<void> {
        return;
    }

    /**
     * Clear the current audio buffer.
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

        // The audio handler is append-only now, so there is no manual commit
        // to send here.
        await this.audioHandler.flushAudio(this.sendClientEvent.bind(this));
    }

    /**
     * Start a new conversation turn after text or audio input has been queued.
     */
    public async createResponse(): Promise<void> {
        await this.waitForSessionReady();
        this.sendClientEvent({ type: 'response.create' });
    }

    public async waitForResponseCompleted(): Promise<void> {
        if (this.eventHandler) {
            return this.eventHandler.waitForResponseCompleted();
        }
        throw new Error('Event handler not initialized');
    }

    public async sendGreeting(): Promise<void> {
        await this.waitForSessionReady();
        this.sendClientEvent({ type: 'input_text.create', text: 'Hello!' });
        await this.createResponse();
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

    private ensureSessionReadyPromise(): Promise<void> {
        if (this.sessionReady) {
            return Promise.resolve();
        }
        if (this.sessionReadyPromise) {
            return this.sessionReadyPromise;
        }

        if (!this.wsManager.isConnectionReady()) {
            return Promise.reject(
                new Error('Realtime websocket is not connected.')
            );
        }

        const ws = this.wsManager.getWebSocket();
        if (!ws) {
            return Promise.reject(
                new Error('Realtime websocket is not connected.')
            );
        }

        this.sessionReadyPromise = new Promise((resolve, reject) => {
            const cleanup = () => {
                this.wsManager.off('event', handleEvent);
                ws.off('close', handleClose);
                ws.off('error', handleSocketError);
                this.resolveSessionReady = null;
                this.rejectSessionReady = null;
                this.sessionReadyPromise = null;
            };

            const resolveReady = () => {
                cleanup();
                resolve();
            };

            const rejectReady = (error: Error) => {
                cleanup();
                reject(error);
            };

            const handleEvent = (data: unknown) => {
                if (!data || typeof data !== 'object') {
                    return;
                }
                const event = data as InternalVoiceRealtimeServerEvent;
                if (event.type === 'session.ready') {
                    this.markSessionReady();
                    return;
                }
                if (event.type === 'error') {
                    rejectReady(new Error(event.message));
                    return;
                }
                if (event.type === 'session.closed') {
                    rejectReady(
                        new Error(event.reason ?? 'Realtime session closed.')
                    );
                }
            };

            const handleClose = (code: number, reason: Buffer) => {
                const suffix = reason?.length
                    ? `: ${reason.toString()}`
                    : '';
                rejectReady(
                    new Error(
                        `Realtime websocket closed before ready (${code})${suffix}`
                    )
                );
            };

            const handleSocketError = (error: Error) => {
                rejectReady(error);
            };

            this.resolveSessionReady = resolveReady;
            this.rejectSessionReady = rejectReady;
            this.wsManager.on('event', handleEvent);
            ws.on('close', handleClose);
            ws.on('error', handleSocketError);
        });

        return this.sessionReadyPromise;
    }

    private async waitForSessionReady(): Promise<void> {
        await this.ensureSessionReadyPromise();
    }

    private markSessionReady(): void {
        if (this.sessionReady) {
            return;
        }
        this.sessionReady = true;
        this.resolveSessionReady?.();
    }

    private handleBackendEvent(raw: string): void {
        let parsed: InternalVoiceRealtimeServerEvent;
        try {
            parsed = JSON.parse(raw) as InternalVoiceRealtimeServerEvent;
        } catch (error) {
            realtimeLogger.warn(
                '[realtime] Ignoring malformed backend event payload.',
                {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
            return;
        }

        const validation =
            InternalVoiceRealtimeServerEventSchema.safeParse(parsed);
        if (!validation.success) {
            realtimeLogger.warn(
                '[realtime] Ignoring invalid backend event shape.',
                {
                    issues: validation.error.issues,
                }
            );
            return;
        }

        const event = validation.data;
        if (event.type === 'session.ready') {
            this.markSessionReady();
            realtimeLogger.info('Backend realtime session ready.');
            this.emit('connected');
            return;
        }

        // The backend contract does not expose a separate "audio done" event.
        // Locally we still emit one when the response completes so the playback
        // pipeline can reset per-response audio state without reassembling the
        // raw backend protocol itself.
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
            if (!this.sessionReady) {
                this.rejectSessionReady?.(
                    new Error(event.reason ?? 'session closed')
                );
            }
            realtimeLogger.warn('Backend realtime session closed.', {
                reason: event.reason ?? 'session closed',
                code: event.code,
            });
            this.emit('error', new Error(event.reason ?? 'session closed'));
        }

        if (event.type === 'error' && !this.sessionReady) {
            this.rejectSessionReady?.(new Error(event.message));
        }
    }
}

const mapInternalEventToRealtimeEvent = (
    event: InternalVoiceRealtimeServerEvent
): RealtimeEvent | null => {
    switch (event.type) {
        case 'output_audio.delta':
            // Keep the Discord-local event name explicit about output audio so
            // it stays easy to distinguish from microphone input buffering.
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
                usage: event.usage,
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

