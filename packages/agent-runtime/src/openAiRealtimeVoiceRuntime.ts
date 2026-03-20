/**
 * @description: Calls the OpenAI realtime API behind Footnote's shared voice runtime boundary.
 * @footnote-scope: core
 * @footnote-module: OpenAiRealtimeVoiceRuntime
 * @footnote-risk: high - Incorrect websocket handling can drop audio or leak sessions.
 * @footnote-ethics: high - Realtime audio flows handle sensitive voice data and must be treated carefully.
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type {
    InternalVoiceRealtimeOptions,
    InternalVoiceRealtimeServerEvent,
} from '@footnote/contracts/voice';
import type {
    RealtimeVoiceClientCommand,
    RealtimeVoiceRuntime,
    RealtimeVoiceSession,
    RealtimeVoiceSessionRequest,
} from './index.js';

type OpenAiRealtimeRuntimeDebugData = Record<string, unknown>;

export interface OpenAiRealtimeRuntimeLogger {
    debug?: (message: string, data?: OpenAiRealtimeRuntimeDebugData) => void;
    warn?: (message: string, data?: OpenAiRealtimeRuntimeDebugData) => void;
    error?: (message: string, data?: OpenAiRealtimeRuntimeDebugData) => void;
}

export interface CreateOpenAiRealtimeVoiceRuntimeOptions {
    apiKey?: string;
    logger?: OpenAiRealtimeRuntimeLogger;
    defaultModel?: NonNullable<InternalVoiceRealtimeOptions['model']>;
    defaultVoice?: NonNullable<InternalVoiceRealtimeOptions['voice']>;
    kind?: string;
    requestTimeoutMs?: number;
    createWebSocket?: (
        url: string,
        headers: Record<string, string>
    ) => WebSocket;
}

// Defaults are still here as a safety net when callers omit config-driven values.
const DEFAULT_MODEL = 'gpt-realtime';
const DEFAULT_VOICE = 'echo';
// OpenAI realtime audio is 24kHz PCM16 mono.
const REALTIME_SAMPLE_RATE = 24000;
// Minimum buffer size (100ms at 24kHz) before commit to keep audio stable.
const MIN_AUDIO_BUFFER_SIZE = 4800;

const createRequestAbortContext = (
    requestSignal: AbortSignal | undefined,
    requestTimeoutMs: number | undefined
): {
    signal?: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
} => {
    if (
        requestTimeoutMs === undefined ||
        !Number.isFinite(requestTimeoutMs) ||
        requestTimeoutMs <= 0
    ) {
        return {
            signal: requestSignal,
            cleanup: () => undefined,
            didTimeout: () => false,
        };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, requestTimeoutMs);

    let abortListener: (() => void) | null = null;
    if (requestSignal) {
        if (requestSignal.aborted) {
            controller.abort(requestSignal.reason);
        } else {
            abortListener = () => controller.abort(requestSignal.reason);
            requestSignal.addEventListener('abort', abortListener, {
                once: true,
            });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutHandle);
            if (requestSignal && abortListener) {
                requestSignal.removeEventListener('abort', abortListener);
            }
        },
        didTimeout: () => timedOut,
    };
};

// Speaker annotations preserve Discord identity context inside the provider
// transcript without exposing raw Discord IDs in plain text.
const buildSpeakerAnnotation = (
    speakerLabel?: string,
    speakerId?: string
): string | null => {
    if (!speakerLabel) {
        return null;
    }

    if (speakerId) {
        return `<discord_speaker id="${speakerId}">${speakerLabel}</discord_speaker>`;
    }

    return `<discord_speaker>${speakerLabel}</discord_speaker>`;
};

// Convert provider-native events into Footnote-owned session events.
const mapServerEvent = (
    rawEvent: Record<string, unknown>
): InternalVoiceRealtimeServerEvent | null => {
    const type = rawEvent.type;
    if (type === 'response.output_audio.delta') {
        return {
            type: 'output_audio.delta',
            audioBase64: typeof rawEvent.delta === 'string' ? rawEvent.delta : '',
        };
    }

    if (type === 'response.text.delta') {
        return {
            type: 'output_text.delta',
            text: typeof rawEvent.delta === 'string' ? rawEvent.delta : '',
        };
    }

    if (type === 'response.completed') {
        return {
            type: 'response.completed',
            responseId:
                typeof rawEvent.response_id === 'string'
                    ? rawEvent.response_id
                    : undefined,
        };
    }

    if (type === 'error') {
        const errorPayload =
            rawEvent.error && typeof rawEvent.error === 'object'
                ? (rawEvent.error as Record<string, unknown>)
                : {};
        return {
            type: 'error',
            message:
                typeof errorPayload.message === 'string'
                    ? errorPayload.message
                    : 'Realtime session error',
            code:
                typeof errorPayload.code === 'string'
                    ? errorPayload.code
                    : undefined,
        };
    }

    return null;
};

class OpenAiRealtimeVoiceSession implements RealtimeVoiceSession {
    private ws: WebSocket;
    private emitter = new EventEmitter();
    private logger?: OpenAiRealtimeRuntimeLogger;
    private instructions: string;
    private options?: InternalVoiceRealtimeOptions;
    // Track audio chunks until commit so we can pad short buffers and tag speakers.
    private pendingSpeaker: { label: string; id?: string } | null = null;
    private pendingBytes = 0;
    private pendingCommit = false;
    // `session.ready` is emitted during session setup, before backend callers
    // can attach listeners. Keep the first ready event so late listeners still
    // learn that the session is usable without changing the public contract.
    private sessionReadyEvent: Extract<
        InternalVoiceRealtimeServerEvent,
        { type: 'session.ready' }
    > | null = null;

    constructor(
        ws: WebSocket,
        instructions: string,
        options?: InternalVoiceRealtimeOptions,
        logger?: OpenAiRealtimeRuntimeLogger
    ) {
        this.ws = ws;
        this.instructions = instructions;
        this.options = options;
        this.logger = logger;

        this.ws.on('message', (data) => {
            try {
                const parsed = JSON.parse(data.toString()) as Record<
                    string,
                    unknown
                >;
                if (
                    !this.sessionReadyEvent &&
                    (parsed.type === 'session.created' ||
                        parsed.type === 'session.updated')
                ) {
                    this.emitEvent({ type: 'session.ready' });
                }

                const mapped = mapServerEvent(parsed);
                if (mapped) {
                    this.emitEvent(mapped);
                }
            } catch (error) {
                this.logger?.warn?.('Realtime message parse failed.', {
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
        });

        this.ws.on('close', (_code, reason) => {
            this.emitEvent({
                type: 'session.closed',
                reason: reason?.toString() || undefined,
            });
        });

        this.ws.on('error', (error) => {
            this.emitEvent({
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }

    public onEvent(
        listener: (event: InternalVoiceRealtimeServerEvent) => void
    ): void {
        this.emitter.on('event', listener);

        // Replay the latched ready signal for listeners that subscribe after
        // createSession() returns. This avoids a race between session setup and
        // backend websocket forwarding.
        if (this.sessionReadyEvent) {
            listener(this.sessionReadyEvent);
        }
    }

    public emitEvent(event: InternalVoiceRealtimeServerEvent): void {
        if (event.type === 'session.ready') {
            // `session.ready` is a one-time state transition. Ignore duplicate
            // emissions so existing listeners and replayed listeners both see
            // one stable readiness signal.
            if (this.sessionReadyEvent) {
                return;
            }
            this.sessionReadyEvent = event;
        }
        this.emitter.emit('event', event);
    }

    private sendPayload(payload: Record<string, unknown>): void {
        if (this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Realtime websocket is not open.');
        }

        this.ws.send(JSON.stringify(payload));
    }

    // Ensure the provider receives a well-formed audio buffer and any speaker
    // annotation before we commit the audio for processing.
    private async flushPendingAudio(): Promise<void> {
        if (!this.pendingCommit) {
            return;
        }

        if (this.pendingBytes > 0 && this.pendingBytes < MIN_AUDIO_BUFFER_SIZE) {
            const deficit = MIN_AUDIO_BUFFER_SIZE - this.pendingBytes;
            const silence = Buffer.alloc(deficit).toString('base64');
            this.sendPayload({
                type: 'input_audio_buffer.append',
                audio: silence,
            });
            this.pendingBytes += deficit;
        }

        const annotation = buildSpeakerAnnotation(
            this.pendingSpeaker?.label,
            this.pendingSpeaker?.id
        );
        if (annotation) {
            this.sendPayload({
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_text', text: annotation },
                        { type: 'input_audio_buffer' },
                    ],
                },
            });
        }

        this.sendPayload({ type: 'input_audio_buffer.commit' });
        this.pendingCommit = false;
        this.pendingSpeaker = null;
        this.pendingBytes = 0;
    }

    private resetPendingAudio(): void {
        this.pendingCommit = false;
        this.pendingSpeaker = null;
        this.pendingBytes = 0;
    }

    // Used for greeting/bootstrap turns or explicit text messages during a
    // realtime session.
    private sendTextCreate(
        event: Extract<RealtimeVoiceClientCommand, { type: 'input_text.create' }>
    ): void {
        const annotation = buildSpeakerAnnotation(
            event.speakerLabel,
            event.speakerId
        );
        const content = annotation
            ? [
                  { type: 'input_text', text: annotation },
                  { type: 'input_text', text: event.text },
              ]
            : [{ type: 'input_text', text: event.text }];
        this.sendPayload({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content,
            },
        });
    }

    // Requests the model to respond with audio output for the current turn.
    private sendResponseCreate(): void {
        const response: Record<string, unknown> = {
            output_modalities: ['audio'],
        };

        if (this.instructions) {
            response.instructions = this.instructions;
        }
        if (typeof this.options?.temperature === 'number') {
            response.temperature = this.options.temperature;
        }
        if (typeof this.options?.maxResponseOutputTokens === 'number') {
            response.max_output_tokens = this.options.maxResponseOutputTokens;
        }

        this.sendPayload({
            type: 'response.create',
            response,
        });
    }

    public async send(event: RealtimeVoiceClientCommand): Promise<void> {
        switch (event.type) {
            case 'input_text.create':
                this.sendTextCreate(event);
                return;
            case 'input_audio.append': {
                if (
                    this.pendingSpeaker &&
                    this.pendingSpeaker.label !== event.speakerLabel
                ) {
                    await this.flushPendingAudio();
                }
                this.sendPayload({
                    type: 'input_audio_buffer.append',
                    audio: event.audioBase64,
                });
                this.pendingCommit = true;
                this.pendingSpeaker = {
                    label: event.speakerLabel,
                    id: event.speakerId,
                };
                this.pendingBytes += Buffer.from(
                    event.audioBase64,
                    'base64'
                ).length;
                return;
            }
            case 'input_audio.commit':
                await this.flushPendingAudio();
                return;
            case 'input_audio.clear':
                this.sendPayload({ type: 'input_audio_buffer.clear' });
                this.resetPendingAudio();
                return;
            case 'response.create':
                this.sendResponseCreate();
                return;
            case 'session.close':
                this.close('client_close');
                return;
            default:
                return;
        }
    }

    public close(reason?: string): void {
        if (this.ws.readyState === WebSocket.CLOSED) {
            return;
        }

        this.ws.close(1000, reason);
    }
}

// Apply base realtime settings plus VAD to the upstream provider session.
const sendSessionConfig = (
    session: OpenAiRealtimeVoiceSession,
    ws: WebSocket,
    instructions: string,
    model: NonNullable<InternalVoiceRealtimeOptions['model']>,
    voice: NonNullable<InternalVoiceRealtimeOptions['voice']>
): void => {
    const payload = {
        type: 'session.update',
        session: {
            type: 'realtime',
            model,
            instructions,
            output_modalities: ['audio'],
            audio: {
                input: {
                    format: {
                        type: 'audio/pcm',
                        rate: REALTIME_SAMPLE_RATE,
                    },
                    turn_detection: null,
                },
                output: {
                    format: {
                        type: 'audio/pcm',
                        rate: REALTIME_SAMPLE_RATE,
                    },
                    voice,
                },
            },
        },
    };

    ws.send(JSON.stringify(payload));
    ws.send(
        JSON.stringify({
            type: 'session.update',
            session: {
                type: 'realtime',
                audio: {
                    input: {
                        turn_detection: {
                            type: 'semantic_vad',
                        },
                    },
                },
            },
        })
    );
    session.emitEvent({ type: 'session.ready' });
};

const connectWebSocket = async (
    url: string,
    headers: Record<string, string>,
    createWebSocket: (url: string, headers: Record<string, string>) => WebSocket,
    signal: AbortSignal | undefined
): Promise<WebSocket> => {
    const ws = createWebSocket(url, headers);

    return new Promise((resolve, reject) => {
        const handleAbort = () => {
            ws.close(1000, 'client_abort');
            reject(new Error('Realtime connection aborted.'));
        };

        if (signal) {
            if (signal.aborted) {
                handleAbort();
                return;
            }
            signal.addEventListener('abort', handleAbort, { once: true });
        }

        ws.once('open', () => {
            if (signal) {
                signal.removeEventListener('abort', handleAbort);
            }
            resolve(ws);
        });
        ws.once('error', (error) => {
            if (signal) {
                signal.removeEventListener('abort', handleAbort);
            }
            reject(error);
        });
    });
};

export const createOpenAiRealtimeVoiceRuntime = ({
    apiKey,
    logger,
    defaultModel,
    defaultVoice,
    kind = 'openai-realtime',
    requestTimeoutMs,
    createWebSocket = (url, headers) => new WebSocket(url, { headers }),
}: CreateOpenAiRealtimeVoiceRuntimeOptions): RealtimeVoiceRuntime => {
    if (!apiKey) {
        throw new Error('OpenAI realtime runtime requires an apiKey.');
    }

    return {
        kind,
        async createSession(
            request: RealtimeVoiceSessionRequest
        ): Promise<RealtimeVoiceSession> {
            const abortContext = createRequestAbortContext(
                request.signal,
                requestTimeoutMs
            );

            try {
                const resolvedModel =
                    request.options?.model ?? defaultModel ?? DEFAULT_MODEL;
                const resolvedVoice =
                    request.options?.voice ?? defaultVoice ?? DEFAULT_VOICE;
                const url = `wss://api.openai.com/v1/realtime?model=${resolvedModel}`;
                const ws = await connectWebSocket(
                    url,
                    {
                        Authorization: `Bearer ${apiKey}`,
                    },
                    createWebSocket,
                    abortContext.signal
                );

                const session = new OpenAiRealtimeVoiceSession(
                    ws,
                    request.instructions,
                    request.options,
                    logger
                );

                sendSessionConfig(
                    session,
                    ws,
                    request.instructions,
                    resolvedModel,
                    resolvedVoice
                );

                return session;
            } catch (error) {
                if (
                    abortContext.didTimeout() &&
                    error instanceof Error &&
                    error.name === 'AbortError'
                ) {
                    throw new Error(
                        `Realtime connection timed out after ${requestTimeoutMs}ms`
                    );
                }
                logger?.error?.('Realtime session creation failed.', {
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            } finally {
                abortContext.cleanup();
            }
        },
    };
};
