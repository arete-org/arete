/**
 * @description: Request parsing and client identity helpers for the chat HTTP handler.
 * @footnote-scope: utility
 * @footnote-module: ChatRequest
 * @footnote-risk: medium - Parsing mistakes can reject valid requests or mis-handle client identity.
 * @footnote-ethics: medium - Accurate validation and identity handling support fair abuse controls.
 */
import type { IncomingMessage } from 'node:http';
import type { PostChatRequest } from '@footnote/contracts/web';
import { PostChatRequestSchema } from '@footnote/contracts/web/schemas';
import type { ChatFailureResponse } from './chatResponses.js';

/**
 * Parsed chat request after JSON/body validation.
 */
export type ParsedChatRequest = PostChatRequest;

/**
 * Client identity used for abuse controls.
 * IP and session stay separate because public traffic uses both limiters.
 */
export type RequestIdentity = {
    clientIp: string;
    sessionId: string;
};

// These helpers return "success/error" objects instead of writing to the response directly.
// That keeps HTTP concerns in the route while still letting the parsing logic stay reusable.

/**
 * Parses the POST body, enforces the size cap, and validates the request schema.
 * The helper returns handler-ready failure payloads so the route can stay small.
 */
export const parseChatRequest = async (
    req: IncomingMessage,
    maxChatBodyBytes: number
): Promise<
    | { success: true; data: ParsedChatRequest }
    | { success: false; error: ChatFailureResponse }
> => {
    let parsedBody: unknown = {};

    try {
        // We build the body manually because this server uses the low-level Node HTTP API,
        // not an Express-style middleware stack.
        let body = '';
        let bodyBytes = 0;
        let bodyTooLarge = false;

        const contentLengthHeader = req.headers['content-length'];
        if (contentLengthHeader) {
            const contentLength = Number(contentLengthHeader);
            if (
                Number.isFinite(contentLength) &&
                contentLength > maxChatBodyBytes
            ) {
                // Reject obviously oversized requests before buffering them in memory.
                req.resume();
                return {
                    success: false,
                    error: {
                        statusCode: 413,
                        payload: {
                            error: 'Request payload too large',
                        },
                        logLabel: `chat payload-too-large contentLength=${contentLength}`,
                    },
                };
            }
        }

        // Track streamed body size as chunks arrive so we can stop oversized requests early.
        req.on('data', (chunk: Buffer | string) => {
            if (bodyTooLarge) {
                return;
            }

            bodyBytes += Buffer.isBuffer(chunk)
                ? chunk.length
                : Buffer.byteLength(chunk);
            if (bodyBytes > maxChatBodyBytes) {
                bodyTooLarge = true;
                req.destroy();
                return;
            }

            body += chunk.toString();
        });

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const resolveOnce = () => {
                if (settled) {
                    return;
                }

                settled = true;
                resolve();
            };
            const rejectOnce = (error: Error) => {
                if (settled) {
                    return;
                }

                settled = true;
                reject(error);
            };

            // Treat the forced destroy from our own size guard as a handled outcome, not a server error.
            req.on('end', () => resolveOnce());
            req.on('close', () => {
                if (bodyTooLarge) {
                    resolveOnce();
                }
            });
            req.on('error', (error) => {
                if (bodyTooLarge) {
                    resolveOnce();
                    return;
                }

                rejectOnce(error);
            });
        });

        if (bodyTooLarge) {
            return {
                success: false,
                error: {
                    statusCode: 413,
                    payload: {
                        error: 'Request payload too large',
                    },
                    logLabel: 'chat payload-too-large',
                },
            };
        }

        if (body) {
            parsedBody = JSON.parse(body) as unknown;
        }
    } catch {
        return {
            success: false,
            error: {
                statusCode: 400,
                payload: {
                    error: 'Invalid JSON body',
                },
                logLabel: 'chat invalid-json',
            },
        };
    }

    // Schema validation catches malformed request shapes before they reach the planner.
    const parsedRequest = PostChatRequestSchema.safeParse(parsedBody);
    if (!parsedRequest.success) {
        const isLatestUserInputTooLong = parsedRequest.error.issues.some(
            (issue) =>
                issue.code === 'too_big' &&
                issue.path.length === 1 &&
                issue.path[0] === 'latestUserInput'
        );

        const firstIssue = parsedRequest.error.issues[0];
        const issuePath =
            firstIssue && firstIssue.path.length > 0
                ? firstIssue.path.join('.')
                : 'body';
        const issueMessage = firstIssue?.message ?? 'Invalid request payload.';

        // Keep response messages aligned with the existing API contract.
        return {
            success: false,
            error: {
                statusCode: isLatestUserInputTooLong ? 413 : 400,
                payload: {
                    error: isLatestUserInputTooLong
                        ? 'latestUserInput parameter too long'
                        : 'Invalid chat request payload',
                    details: `${issuePath}: ${issueMessage}`,
                },
                logLabel: isLatestUserInputTooLong
                    ? 'chat latest-user-input-too-long'
                    : 'chat invalid-request',
            },
        };
    }

    const latestUserInput = parsedRequest.data.latestUserInput.trim();
    if (latestUserInput.length === 0) {
        return {
            success: false,
            error: {
                statusCode: 400,
                payload: {
                    error: 'latestUserInput parameter is required',
                },
                logLabel: 'chat missing-latest-user-input',
            },
        };
    }

    const normalizedConversation = parsedRequest.data.conversation.map(
        (message) => ({
            ...message,
            content: message.content.trim(),
        })
    );
    if (
        normalizedConversation.some((message) => message.content.length === 0)
    ) {
        return {
            success: false,
            error: {
                statusCode: 400,
                payload: {
                    error: 'Invalid chat request payload',
                    details:
                        'conversation.content: Message content must not be blank',
                },
                logLabel: 'chat blank-conversation-message',
            },
        };
    }

    return {
        success: true,
        data: {
            ...parsedRequest.data,
            latestUserInput,
            conversation: normalizedConversation,
        },
    };
};

/**
 * Derives the caller IP and normalized session id for rate limiting.
 * This intentionally mirrors the old inline logic to avoid behavior drift.
 */
export const getRequestIdentity = (
    req: IncomingMessage,
    trustProxy: boolean
): RequestIdentity => {
    let clientIp = req.socket.remoteAddress || 'unknown';

    // Only trust X-Forwarded-For when the deployment explicitly says a proxy is in front.
    if (trustProxy) {
        const forwardedFor = req.headers['x-forwarded-for'];
        if (forwardedFor) {
            if (typeof forwardedFor === 'string') {
                clientIp = forwardedFor.split(',')[0].trim();
            } else if (Array.isArray(forwardedFor)) {
                clientIp = forwardedFor[0].trim();
            }
        }
    }

    // Collapse IPv4-mapped IPv6 addresses so rate-limit keys stay stable.
    if (clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
    }

    let sessionId: string | null = null;
    const rawSessionId = req.headers['x-session-id'];
    if (rawSessionId) {
        let sessionIdStr = Array.isArray(rawSessionId)
            ? rawSessionId[0]
            : String(rawSessionId);
        // Keep session identifiers small and simple because they become rate-limit keys.
        sessionIdStr = sessionIdStr.trim().substring(0, 128);
        sessionIdStr = sessionIdStr.replace(/[^a-zA-Z0-9\-_]/g, '');
        if (sessionIdStr.length > 0) {
            sessionId = sessionIdStr;
        }
    }

    // Fall back to IP when the caller does not provide a session header.
    if (!sessionId) {
        sessionId = `ip-${clientIp}`;
    }

    return {
        clientIp,
        sessionId,
    };
};
