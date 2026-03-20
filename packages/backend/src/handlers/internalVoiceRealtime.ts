/**
 * @description: Handles trusted internal realtime voice WebSocket sessions for backend-owned voice runtime.
 * @footnote-scope: interface
 * @footnote-module: InternalVoiceRealtimeHandler
 * @footnote-risk: high - Auth or websocket handling mistakes here can leak realtime sessions or drop audio.
 * @footnote-ethics: high - Realtime audio sessions are privacy-sensitive and must remain within trusted boundaries.
 */
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type {
    InternalVoiceRealtimeClientEvent,
    InternalVoiceRealtimeServerEvent,
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
import { buildRealtimeInstructions } from '../services/prompts/realtimePromptComposer.js';
import { parseTrustedServiceAuth } from './trustedServiceRequest.js';

type CreateInternalVoiceRealtimeHandlerOptions = {
    realtimeVoiceRuntime: RealtimeVoiceRuntime | null;
    traceApiToken: string | null;
    serviceToken: string | null;
    serviceRateLimiter: SimpleRateLimiter;
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
    socket: Socket,
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

export const createInternalVoiceRealtimeHandler = ({
    realtimeVoiceRuntime,
    traceApiToken,
    serviceToken,
    serviceRateLimiter,
}: CreateInternalVoiceRealtimeHandlerOptions) => {
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws) => {
        if (!realtimeVoiceRuntime) {
            ws.close(1011, 'service_unavailable');
            return;
        }

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
                logger.warn(
                    `Failed to send internal voice realtime event: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }

            if (event.type === 'session.closed') {
                closeSocket(1000, event.reason ?? 'session_closed');
            }
        };

        ws.on('message', async (data) => {
            let payload: InternalVoiceRealtimeClientEvent;
            try {
                payload = JSON.parse(data.toString()) as InternalVoiceRealtimeClientEvent;
            } catch (_error) {
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
                try {
                    session = await realtimeVoiceRuntime.createSession({
                        instructions: buildRealtimeInstructions(event.context),
                        options: event.options,
                    });
                    session.onEvent(forwardRuntimeEvent);
                    return;
                } catch (error) {
                    sessionStarted = false;
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
                session.close('client_close');
                closeSocket(1000, 'client_close');
                return;
            }

            try {
                await session.send(event);
            } catch (error) {
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
            logger.error('Internal voice realtime websocket error', {
                error: error instanceof Error ? error.message : String(error),
            });
            session?.close('socket_error');
        });
    });

    const handleUpgrade = (
        req: IncomingMessage,
        socket: Socket,
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
            rejectUpgrade(socket, auth.statusCode, auth.payload);
            return;
        }

        const serviceRateLimitResult = serviceRateLimiter.check(
            `${auth.source}:${auth.rateLimitKey}`
        );
        if (!serviceRateLimitResult.allowed) {
            rejectUpgrade(socket, 429, {
                error: 'Too many requests from this trusted service',
                details: `retryAfter=${serviceRateLimitResult.retryAfter}`,
            });
            return;
        }

        if (!realtimeVoiceRuntime) {
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
