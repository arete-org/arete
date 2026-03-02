/**
 * @description: Request parsing and client identity helpers for the reflect HTTP handler.
 * @footnote-scope: utility
 * @footnote-module: ReflectRequest
 * @footnote-risk: medium - Parsing mistakes can reject valid requests or mis-handle client identity.
 * @footnote-ethics: medium - Accurate validation and identity handling support fair abuse controls.
 */
import type { IncomingMessage } from 'node:http';
import { PostReflectRequestSchema } from '@footnote/contracts/web/schemas';
import type { ReflectFailureResponse } from './reflectResponses.js';

/**
 * Parsed reflect request after JSON/body validation.
 */
export type ParsedReflectRequest = {
    question: string;
};

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
export const parseReflectRequest = async (
    req: IncomingMessage,
    maxReflectBodyBytes: number
): Promise<
    | { success: true; data: ParsedReflectRequest }
    | { success: false; error: ReflectFailureResponse }
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
                contentLength > maxReflectBodyBytes
            ) {
                // Reject obviously oversized requests before buffering them in memory.
                return {
                    success: false,
                    error: {
                        statusCode: 413,
                        payload: {
                            error: 'Request payload too large',
                        },
                        logLabel: `reflect payload-too-large contentLength=${contentLength}`,
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
            if (bodyBytes > maxReflectBodyBytes) {
                bodyTooLarge = true;
                req.destroy();
                return;
            }

            body += chunk.toString();
        });

        await new Promise<void>((resolve, reject) => {
            // Treat the forced destroy from our own size guard as a handled outcome, not a server error.
            req.on('end', () => resolve());
            req.on('error', (error) => {
                if (bodyTooLarge) {
                    resolve();
                    return;
                }
                reject(error);
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
                    logLabel: 'reflect payload-too-large',
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
                logLabel: 'reflect invalid-json',
            },
        };
    }

    // Schema validation catches both missing questions and malformed JSON shapes.
    const parsedRequest = PostReflectRequestSchema.safeParse(parsedBody);
    if (!parsedRequest.success) {
        const isQuestionTooLong = parsedRequest.error.issues.some(
            (issue) =>
                issue.code === 'too_big' &&
                issue.path.length === 1 &&
                issue.path[0] === 'question'
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
                statusCode: isQuestionTooLong ? 413 : 400,
                payload: {
                    error: isQuestionTooLong
                        ? 'Question parameter too long'
                        : 'Question parameter is required',
                    details: `${issuePath}: ${issueMessage}`,
                },
                logLabel: isQuestionTooLong
                    ? 'reflect question-too-long'
                    : 'reflect missing-question',
            },
        };
    }

    const question = parsedRequest.data.question.trim();
    if (question.length === 0) {
        return {
            success: false,
            error: {
                statusCode: 400,
                payload: {
                    error: 'Question parameter is required',
                },
                logLabel: 'reflect missing-question',
            },
        };
    }

    return {
        success: true,
        data: {
            question,
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
