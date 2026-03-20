/**
 * @description: Handles trusted internal realtime voice WebSocket sessions for backend-owned voice runtime.
 * @footnote-scope: interface
 * @footnote-module: InternalVoiceRealtimeHandler
 * @footnote-risk: high - Auth or websocket handling mistakes here can leak realtime sessions or drop audio.
 * @footnote-ethics: high - Realtime audio sessions are privacy-sensitive and must remain within trusted boundaries.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type {
    InternalVoiceRealtimeClientEvent,
    InternalVoiceRealtimeServerEvent,
    InternalVoiceSessionContext,
} from '@footnote/contracts/voice';
import {
    InternalVoiceRealtimeClientEventSchema,
    InternalVoiceRealtimeServerEventSchema,
} from '@footnote/contracts/voice';
import type {
    RealtimeVoiceRuntime,
    RealtimeVoiceSession,
} from '@footnote/agent-runtime';
import { logger } from '../utils/logger.js';
import { SimpleRateLimiter } from '../services/rateLimiter.js';
import { parseTrustedServiceAuth } from './trustedServiceRequest.js';

/**
 * @footnote-logger: internalVoiceRealtimeHandler
 * @logs: Websocket upgrades, session lifecycle, and schema validation outcomes for realtime voice.
 * @footnote-risk: high - Missing logs hide dropped sessions or auth failures.
 * @footnote-ethics: high - Realtime audio is privacy sensitive, so logs stay metadata-only.
 */
const realtimeLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'internalVoiceRealtimeHandler' })
        : logger;

type CreateInternalVoiceRealtimeHandlerOptions = {
    realtimeVoiceRuntime: RealtimeVoiceRuntime | null;
    traceApiToken: string | null;
    serviceToken: string | null;
    serviceRateLimiter: SimpleRateLimiter;
    buildInstructions: (context: InternalVoiceSessionContext) => string;
};

const STATUS_MESSAGES: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    405: 'Method Not Allowed',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
};

const rejectUpgrade = (
    socket: Duplex,
    statusCode: number,
    payload: { error: string; details?: string }
): void => {
    const statusMessage = STATUS_MESSAGES[statusCode] ?? 'Bad Request';
    const body = JSON.stringify(payload);
    const headers = [
        `HTTP/1.1 ${statusCode} ${statusMessage}`,
        'Connection: close',
        'Content-Type: application/json; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body,
    ].join('\r\n');
    socket.write(headers);
    socket.destroy();
};

const sendServerEvent = (
    ws: WebSocket,
    event: InternalVoiceRealtimeServerEvent
): void => {
    const parsed = InternalVoiceRealtimeServerEventSchema.safeParse(event);
    if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        throw new Error(
            `Invalid internal voice realtime event: ${
                firstIssue?.path.join('.') ?? 'body'
            } ${firstIssue?.message ?? 'Invalid event'}`
        );
    }

    ws.send(JSON.stringify(parsed.data));
};

/**
 * @api.operationId: openInternalVoiceRealtime
 * @api.path: GET /api/internal/voice/realtime
 */
export const createInternalVoiceRealtimeHandler = ({
    realtimeVoiceRuntime,
    traceApiToken,
    serviceToken,
    serviceRateLimiter,
    buildInstructions,
}: CreateInternalVoiceRealtimeHandlerOptions) => {
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws) => {
        if (!realtimeVoiceRuntime) {
            ws.close(1011, 'service_unavailable');
            return;
        }

        realtimeLogger.info('Internal voice realtime websocket connected.');

        let session: RealtimeVoiceSession | null = null;
        let sessionStarted = false;
        let closed = false;

        const closeSocket = (code = 1000, reason?: string) => {
            if (closed) {
                return;
            }
            closed = true;
            ws.close(code, reason);
        };

        const forwardRuntimeEvent = (event: InternalVoiceRealtimeServerEvent) => {
            try {
                sendServerEvent(ws, event);
            } catch (error) {
                realtimeLogger.warn(
                    `Failed to send internal voice realtime event: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }

            if (event.type === 'session.closed') {
                realtimeLogger.info('Internal voice realtime session closed.', {
                    reason: event.reason ?? 'session_closed',
                    code: event.code,
                });
                closeSocket(1000, event.reason ?? 'session_closed');
            }
        };

        ws.on('message', async (data) => {
            let payload: InternalVoiceRealtimeClientEvent;
            try {
                payload = JSON.parse(data.toString()) as InternalVoiceRealtimeClientEvent;
            } catch (_error) {
                realtimeLogger.warn('Internal voice realtime payload rejected: invalid JSON.');
                sendServerEvent(ws, {
                    type: 'error',
                    message: 'Realtime payload was not valid JSON.',
                });
                return;
            }

            const parsed = InternalVoiceRealtimeClientEventSchema.safeParse(
                payload
            );
            if (!parsed.success) {
                const firstIssue = parsed.error.issues[0];
                realtimeLogger.warn('Internal voice realtime payload rejected: invalid shape.', {
                    issuePath: firstIssue?.path.join('.') ?? 'body',
                    issueMessage: firstIssue?.message ?? 'Invalid event',
                });
                sendServerEvent(ws, {
                    type: 'error',
                    message: `Invalid realtime event: ${
                        firstIssue?.path.join('.') ?? 'body'
                    } ${firstIssue?.message ?? 'Invalid event'}`,
                });
                return;
            }

            const event = parsed.data;

            if (event.type === 'session.start') {
                if (sessionStarted) {
                    sendServerEvent(ws, {
                        type: 'error',
                        message: 'Realtime session already started.',
                    });
                    return;
                }

                sessionStarted = true;
                realtimeLogger.info('Internal voice realtime session starting.', {
                    model: event.options?.model,
                    voice: event.options?.voice,
                });
                try {
                    session = await realtimeVoiceRuntime.createSession({
                        instructions: buildInstructions(event.context),
                        options: event.options,
                    });
                    session.onEvent(forwardRuntimeEvent);
                    return;
                } catch (error) {
                    sessionStarted = false;
                    realtimeLogger.error('Internal voice realtime session start failed.', {
                        error:
                            error instanceof Error ? error.message : String(error),
                    });
                    sendServerEvent(ws, {
                        type: 'error',
                        message:
                            error instanceof Error
                                ? error.message
                                : 'Failed to start realtime session.',
                    });
                    return;
                }
            }

            if (!session) {
                sendServerEvent(ws, {
                    type: 'error',
                    message: 'Realtime session not initialized.',
                });
                return;
            }

            if (event.type === 'session.close') {
                realtimeLogger.info('Internal voice realtime session close requested by client.');
                session.close('client_close');
                closeSocket(1000, 'client_close');
                return;
            }

            try {
                await session.send(event);
            } catch (error) {
                realtimeLogger.error('Internal voice realtime event forwarding failed.', {
                    error:
                        error instanceof Error ? error.message : String(error),
                    eventType: event.type,
                });
                sendServerEvent(ws, {
                    type: 'error',
                    message:
                        error instanceof Error
                            ? error.message
                            : 'Failed to forward realtime event.',
                });
            }
        });

        ws.on('close', () => {
            closed = true;
            session?.close('client_close');
        });

        ws.on('error', (error) => {
            realtimeLogger.error('Internal voice realtime websocket error.', {
                error: error instanceof Error ? error.message : String(error),
            });
            session?.close('socket_error');
        });
    });

    const handleUpgrade = (
        req: IncomingMessage,
        // Node exposes HTTP upgrade sockets as Duplex streams. Treat that as
        // the boundary type here so server.ts can forward the upgrade socket
        // directly without unsafe casts.
        socket: Duplex,
        head: Buffer
    ): void => {
        if (req.method !== 'GET') {
            rejectUpgrade(socket, 405, { error: 'Method not allowed' });
            return;
        }

        const auth = parseTrustedServiceAuth(
            req,
            {
                traceApiToken,
                serviceToken,
            },
            {
                missing: 'internal voice realtime missing-trusted-auth',
                invalid: 'internal voice realtime invalid-trusted-auth',
            }
        );
        if (!auth.ok) {
            realtimeLogger.warn('Internal voice realtime rejected: auth failed.', {
                statusCode: auth.statusCode,
            });
            rejectUpgrade(socket, auth.statusCode, auth.payload);
            return;
        }

        const serviceRateLimitResult = serviceRateLimiter.check(
            `${auth.source}:${auth.rateLimitKey}`
        );
        if (!serviceRateLimitResult.allowed) {
            realtimeLogger.warn('Internal voice realtime rejected: rate limited.', {
                source: auth.source,
                retryAfter: serviceRateLimitResult.retryAfter,
            });
            rejectUpgrade(socket, 429, {
                error: 'Too many requests from this trusted service',
                details: `retryAfter=${serviceRateLimitResult.retryAfter}`,
            });
            return;
        }

        if (!realtimeVoiceRuntime) {
            realtimeLogger.warn(
                'Internal voice realtime rejected: service unavailable.'
            );
            rejectUpgrade(socket, 503, {
                error: 'Internal voice realtime service unavailable',
            });
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    };

    return {
        handleUpgrade,
    };
};
