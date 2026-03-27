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
    InternalVoiceRealtimeTurnDetectionConfig,
    InternalVoiceRealtimeUsage,
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

// Keep the defaults centralized so backend config and runtime code stay aligned.
const DEFAULT_MODEL = 'gpt-realtime-mini';
const DEFAULT_VOICE = 'echo';
// OpenAI realtime audio is 24kHz PCM16 mono.
const REALTIME_SAMPLE_RATE = 24000;
type TurnDetectionConfig = {
    type: 'server_vad' | 'semantic_vad';
    create_response?: boolean;
    interrupt_response?: boolean;
    eagerness?: 'low' | 'medium' | 'high' | 'auto';
    threshold?: number;
    silence_duration_ms?: number;
    prefix_padding_ms?: number;
};

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

// Speaker annotations preserve Discord display context inside the provider
// transcript without sending raw Discord IDs upstream.
const escapeSpeakerLabel = (label: string): string => {
    return label
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
};

const buildSpeakerAnnotation = (speakerLabel?: string): string | null => {
    if (!speakerLabel) {
        return null;
    }

    const escapedLabel = escapeSpeakerLabel(speakerLabel);
    return `<discord_speaker>${escapedLabel}</discord_speaker>`;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
};

const toOptionalNumber = (value: unknown): number | undefined => {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
};

const toOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
};

const extractRealtimeUsage = (
    rawEvent: Record<string, unknown>
): InternalVoiceRealtimeUsage | undefined => {
    const responsePayload = asRecord(rawEvent.response);
    const usagePayload =
        asRecord(responsePayload?.usage) ??
        asRecord(rawEvent.usage) ??
        asRecord(rawEvent.usage_stats);
    const metricsPayload = asRecord(responsePayload?.metrics);

    const usage: InternalVoiceRealtimeUsage = {
        tokensPrompt: toOptionalNumber(
            usagePayload?.input_tokens ??
                usagePayload?.prompt_tokens ??
                usagePayload?.tokens_prompt ??
                usagePayload?.inputTokens ??
                usagePayload?.promptTokens
        ),
        tokensCompletion: toOptionalNumber(
            usagePayload?.output_tokens ??
                usagePayload?.completion_tokens ??
                usagePayload?.tokens_completion ??
                usagePayload?.outputTokens ??
                usagePayload?.completionTokens
        ),
        model: toOptionalString(
            usagePayload?.model ?? responsePayload?.model ?? rawEvent.model
        ),
        requestMs: toOptionalNumber(
            usagePayload?.request_ms ??
                responsePayload?.duration_ms ??
                metricsPayload?.total_ms ??
                rawEvent.request_ms ??
                rawEvent.duration_ms
        ),
        costUsd: toOptionalNumber(
            usagePayload?.cost_usd ??
                usagePayload?.total_cost_usd ??
                usagePayload?.total_cost ??
                responsePayload?.cost_usd ??
                rawEvent.cost_usd
        ),
    };

    const hasUsage = Object.values(usage).some((value) => value !== undefined);
    return hasUsage ? usage : undefined;
};

// Convert provider-native events into Footnote-owned session events.
const mapServerEvent = (
    rawEvent: Record<string, unknown>
): InternalVoiceRealtimeServerEvent | null => {
    const type = rawEvent.type;
    if (type === 'response.output_audio.delta') {
        return {
            type: 'output_audio.delta',
            audioBase64:
                typeof rawEvent.delta === 'string' ? rawEvent.delta : '',
        };
    }

    if (type === 'response.output_text.delta') {
        return {
            type: 'output_text.delta',
            text: typeof rawEvent.delta === 'string' ? rawEvent.delta : '',
        };
    }

    if (type === 'response.done') {
        const usage = extractRealtimeUsage(rawEvent);
        const responsePayload = asRecord(rawEvent.response);
        return {
            type: 'response.done',
            responseId:
                typeof rawEvent.response_id === 'string'
                    ? rawEvent.response_id
                    : typeof responsePayload?.id === 'string'
                      ? responsePayload.id
                      : undefined,
            usage,
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
    // `session.ready` is emitted after the upstream session ack, before backend
    // callers can attach listeners. Keep the first ready event so late
    // listeners still learn that the session is usable without changing the
    // public contract.
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
                const rawType =
                    typeof parsed.type === 'string' ? parsed.type : 'unknown';
                if (
                    rawType === 'input_audio_buffer.speech_started' ||
                    rawType === 'input_audio_buffer.speech_stopped' ||
                    rawType === 'input_audio_buffer.committed' ||
                    rawType === 'input_audio_buffer.cleared'
                ) {
                    this.logger?.debug?.(`OpenAI realtime event: ${rawType}`, {
                        type: rawType,
                        eventId:
                            typeof parsed.event_id === 'string'
                                ? parsed.event_id
                                : undefined,
                        itemId:
                            typeof parsed.item_id === 'string'
                                ? parsed.item_id
                                : undefined,
                        audioStartMs:
                            typeof parsed.audio_start_ms === 'number'
                                ? parsed.audio_start_ms
                                : undefined,
                        audioEndMs:
                            typeof parsed.audio_end_ms === 'number'
                                ? parsed.audio_end_ms
                                : undefined,
                    });
                } else if (rawType.endsWith('.delta')) {
                    // Delta events are extremely chatty; skip logging to keep
                    // voice sessions readable while streaming.
                } else {
                    this.logger?.debug?.(`OpenAI realtime event: ${rawType}`, {
                        type: rawType,
                    });
                }
                const mapped = mapServerEvent(parsed);
                if (mapped) {
                    this.emitEvent(mapped);
                } else if (
                    rawType !== 'unknown' &&
                    !rawType.endsWith('.delta')
                ) {
                    this.logger?.debug?.(
                        'OpenAI realtime event ignored (unmapped).',
                        { type: rawType }
                    );
                }
            } catch (error) {
                this.logger?.warn?.('Realtime message parse failed.', {
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
        });

        this.ws.on('close', (code, reason) => {
            this.logger?.warn?.('OpenAI realtime websocket closed.', {
                code,
                reason: reason?.toString() || undefined,
            });
            this.emitEvent({
                type: 'session.closed',
                reason: reason?.toString() || undefined,
            });
        });

        this.ws.on('error', (error) => {
            this.logger?.error?.('OpenAI realtime websocket error.', {
                error: error instanceof Error ? error.message : String(error),
            });
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

    // Used for greeting/bootstrap turns or explicit text messages during a
    // realtime session.
    private sendTextCreate(
        event: Extract<
            RealtimeVoiceClientCommand,
            { type: 'input_text.create' }
        >
    ): void {
        const annotation = buildSpeakerAnnotation(event.speakerLabel);
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
                this.sendPayload({
                    type: 'input_audio_buffer.append',
                    audio: event.audioBase64,
                });
                return;
            }
            case 'input_audio.commit':
                this.sendPayload({ type: 'input_audio_buffer.commit' });
                return;
            case 'input_audio.clear':
                this.sendPayload({ type: 'input_audio_buffer.clear' });
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

// Send one complete session.update so the provider sees the final config in a
// single atomic handshake instead of two separate updates.
const sendSessionConfig = (
    ws: WebSocket,
    instructions: string,
    model: NonNullable<InternalVoiceRealtimeOptions['model']>,
    voice: NonNullable<InternalVoiceRealtimeOptions['voice']>,
    turnDetection: TurnDetectionConfig
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
                    turn_detection: turnDetection,
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
};

const buildTurnDetectionConfig = (
    mode: InternalVoiceRealtimeOptions['turnDetection'] | undefined,
    config: InternalVoiceRealtimeTurnDetectionConfig | undefined
): TurnDetectionConfig => {
    const createResponse = config?.createResponse ?? true;
    const interruptResponse =
        typeof config?.interruptResponse === 'boolean'
            ? config.interruptResponse
            : undefined;

    if (mode === 'semantic_vad') {
        return {
            type: 'semantic_vad',
            eagerness: config?.semanticVad?.eagerness ?? 'auto',
            create_response: createResponse,
            interrupt_response: interruptResponse,
        };
    }

    return {
        type: 'server_vad',
        create_response: createResponse,
        interrupt_response: interruptResponse,
        threshold: config?.serverVad?.threshold,
        silence_duration_ms: config?.serverVad?.silenceDurationMs,
        prefix_padding_ms: config?.serverVad?.prefixPaddingMs,
    };
};

const connectWebSocket = async (
    url: string,
    headers: Record<string, string>,
    createWebSocket: (
        url: string,
        headers: Record<string, string>
    ) => WebSocket,
    signal: AbortSignal | undefined
): Promise<WebSocket> => {
    const ws = createWebSocket(url, headers);

    return new Promise((resolve, reject) => {
        const handleAbort = () => {
            ws.close(1000, 'client_abort');
            const abortError = new Error('Realtime connection aborted.');
            abortError.name = 'AbortError';
            reject(abortError);
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

const waitForProviderSessionReady = (
    ws: WebSocket,
    signal?: AbortSignal
): Promise<void> => {
    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            ws.off('message', handleMessage);
            ws.off('error', handleError);
            ws.off('close', handleClose);
            if (signal && handleAbort) {
                signal.removeEventListener('abort', handleAbort);
            }
        };

        const settle = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            fn();
        };

        const handleMessage = (data: WebSocket.RawData) => {
            try {
                const parsed = JSON.parse(data.toString()) as Record<
                    string,
                    unknown
                >;
                const type = parsed.type;
                if (type === 'session.created' || type === 'session.updated') {
                    settle(resolve);
                    return;
                }
                if (type === 'error') {
                    const errorPayload =
                        parsed.error && typeof parsed.error === 'object'
                            ? (parsed.error as Record<string, unknown>)
                            : {};
                    const message =
                        typeof errorPayload.message === 'string'
                            ? errorPayload.message
                            : 'Realtime session setup failed.';
                    settle(() => reject(new Error(message)));
                }
            } catch {
                // Ignore parse failures and keep listening for readiness.
            }
        };

        const handleError = (error: Error) => {
            settle(() => reject(error));
        };

        const handleClose = (code: number, reason: Buffer) => {
            const suffix = reason?.length ? `: ${reason.toString()}` : '';
            settle(() =>
                reject(
                    new Error(
                        `Realtime websocket closed before ready (${code})${suffix}`
                    )
                )
            );
        };

        let handleAbort: (() => void) | undefined;
        if (signal) {
            handleAbort = () => {
                const abortError = new Error('Realtime session setup aborted.');
                abortError.name = 'AbortError';
                settle(() => reject(abortError));
            };

            if (signal.aborted) {
                handleAbort();
                return;
            }
            signal.addEventListener('abort', handleAbort, { once: true });
        }

        ws.on('message', handleMessage);
        ws.on('error', handleError);
        ws.on('close', handleClose);
    });
};

/**
 * @description: Builds the realtime voice runtime adapter that connects to the OpenAI websocket API.
 * @footnote-scope: core
 * @footnote-module: OpenAiRealtimeVoiceRuntimeFactory
 * @footnote-risk: high - Incorrect session setup can drop audio or leave realtime sockets open.
 * @footnote-ethics: high - Realtime voice traffic carries sensitive user speech and must be handled carefully.
 */
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
            let session: OpenAiRealtimeVoiceSession | null = null;

            try {
                const resolvedModel =
                    request.options?.model ?? defaultModel ?? DEFAULT_MODEL;
                const resolvedVoice =
                    request.options?.voice ?? defaultVoice ?? DEFAULT_VOICE;
                const url = `wss://api.openai.com/v1/realtime?model=${resolvedModel}`;
                logger?.debug?.('Opening OpenAI realtime websocket.', {
                    model: resolvedModel,
                    voice: resolvedVoice,
                    url,
                });
                const ws = await connectWebSocket(
                    url,
                    {
                        Authorization: `Bearer ${apiKey}`,
                    },
                    createWebSocket,
                    abortContext.signal
                );

                session = new OpenAiRealtimeVoiceSession(
                    ws,
                    request.instructions,
                    request.options,
                    logger
                );

                const readyPromise = waitForProviderSessionReady(
                    ws,
                    abortContext.signal
                );
                const turnDetectionConfig = buildTurnDetectionConfig(
                    request.options?.turnDetection,
                    request.options?.turnDetectionConfig
                );
                logger?.debug?.('Sending OpenAI realtime session.update.', {
                    model: resolvedModel,
                    voice: resolvedVoice,
                    inputSampleRate: REALTIME_SAMPLE_RATE,
                    outputSampleRate: REALTIME_SAMPLE_RATE,
                    turnDetection: turnDetectionConfig.type,
                });
                sendSessionConfig(
                    ws,
                    request.instructions,
                    resolvedModel,
                    resolvedVoice,
                    turnDetectionConfig
                );
                await readyPromise;
                logger?.debug?.('OpenAI realtime session ready.', {
                    model: resolvedModel,
                    voice: resolvedVoice,
                });
                session.emitEvent({ type: 'session.ready' });

                return session;
            } catch (error) {
                session?.close('session_setup_failed');
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
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            } finally {
                abortContext.cleanup();
            }
        },
    };
};
