/**
 * @description: Shared helpers for trusted internal backend endpoints that use service auth and bounded JSON bodies.
 * @footnote-scope: utility
 * @footnote-module: TrustedServiceRequestHelpers
 * @footnote-risk: high - Drift here can affect auth, payload validation, and fail-open behavior across multiple trusted endpoints.
 * @footnote-ethics: medium - Consistent trusted-endpoint handling reduces accidental policy drift between internal workflows.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './chatResponses.js';

export type TrustedRouteLogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

type TrustedServiceTokens = {
    traceApiToken: string | null;
    serviceToken: string | null;
};

type TrustedServiceAuthLabels = {
    missing: string;
    invalid: string;
};

export type TrustedServiceAuthResult =
    | {
          ok: true;
          source: 'x-service-token' | 'x-trace-token';
          rateLimitKey: string;
      }
    | {
          ok: false;
          statusCode: number;
          payload: { error: string; details?: string };
          logLabel: string;
      };

/**
 * Normalizes a header into one trimmed string so auth checks do not need to
 * care whether Node exposed the header as one value or an array.
 */
export const readTrustedHeaderValue = (
    headerValue: string | string[] | undefined
): string | null => {
    if (!headerValue) {
        return null;
    }

    const rawValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const trimmedValue = rawValue.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
};

/**
 * Trusted internal endpoints all accept the dedicated service token when it is
 * configured, while still allowing the trace token for existing internal
 * callers during migration.
 */
export const parseTrustedServiceAuth = (
    req: IncomingMessage,
    tokens: TrustedServiceTokens,
    labels: TrustedServiceAuthLabels
): TrustedServiceAuthResult => {
    const serviceHeaderValue = readTrustedHeaderValue(
        req.headers['x-service-token']
    );
    if (tokens.serviceToken && serviceHeaderValue === tokens.serviceToken) {
        return {
            ok: true,
            source: 'x-service-token',
            rateLimitKey: serviceHeaderValue,
        };
    }

    const traceHeaderValue = readTrustedHeaderValue(
        req.headers['x-trace-token']
    );
    if (tokens.traceApiToken && traceHeaderValue === tokens.traceApiToken) {
        return {
            ok: true,
            source: 'x-trace-token',
            rateLimitKey: traceHeaderValue,
        };
    }

    if (!serviceHeaderValue && !traceHeaderValue) {
        return {
            ok: false,
            statusCode: 401,
            payload: {
                error: 'Missing trusted service credentials',
            },
            logLabel: labels.missing,
        };
    }

    return {
        ok: false,
        statusCode: 403,
        payload: {
            error: 'Invalid trusted service credentials',
        },
        logLabel: labels.invalid,
    };
};

/**
 * Reads one JSON body with an explicit size limit so oversized requests fail
 * quickly instead of holding the process open.
 */
export const parseTrustedJsonBody = async (
    req: IncomingMessage,
    res: ServerResponse,
    logRequest: TrustedRouteLogRequest,
    routeLabel: string,
    maxBodyBytes: number
): Promise<unknown | null> => {
    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
            sendJson(res, 413, { error: 'Request payload too large' });
            logRequest(req, res, `${routeLabel} payload-too-large`);
            req.resume();
            return null;
        }
    }

    const chunks: Buffer[] = [];
    let bodyTooLarge = false;
    let bodyBytes = 0;
    req.on('data', (chunk) => {
        if (bodyTooLarge) {
            return;
        }

        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += chunkBuffer.length;
        if (bodyBytes > maxBodyBytes) {
            bodyTooLarge = true;
            sendJson(res, 413, { error: 'Request payload too large' });
            logRequest(req, res, `${routeLabel} payload-too-large`);
            req.resume();
            return;
        }

        chunks.push(chunkBuffer);
    });

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('close', onClose);
            req.off('aborted', onAborted);
        };
        const onEnd = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            if (bodyTooLarge) {
                resolve();
                return;
            }
            reject(error);
        };
        const onClose = () => {
            cleanup();
            if (bodyTooLarge) {
                resolve();
                return;
            }
            reject(
                new Error(`${routeLabel} request closed before body completed`)
            );
        };
        const onAborted = () => {
            cleanup();
            if (bodyTooLarge) {
                resolve();
                return;
            }
            reject(
                new Error(`${routeLabel} request aborted before body completed`)
            );
        };
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('close', onClose);
        req.on('aborted', onAborted);
    });

    if (bodyTooLarge) {
        return null;
    }

    const body = Buffer.concat(chunks, bodyBytes).toString('utf8');
    if (!body) {
        sendJson(res, 400, { error: 'Missing request body' });
        logRequest(req, res, `${routeLabel} missing-body`);
        return null;
    }

    try {
        return JSON.parse(body) as unknown;
    } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        logRequest(req, res, `${routeLabel} invalid-json`);
        return null;
    }
};

/**
 * Shared schema-validation wrapper for trusted JSON endpoints. This keeps the
 * request-body path consistent across internal handlers.
 */
export const parseTrustedBodyWithSchema = async <T>(
    req: IncomingMessage,
    res: ServerResponse,
    {
        logRequest,
        routeLabel,
        maxBodyBytes,
        safeParse,
    }: {
        logRequest: TrustedRouteLogRequest;
        routeLabel: string;
        maxBodyBytes: number;
        safeParse: (value: unknown) =>
            | { success: true; data: T }
            | {
                  success: false;
                  error: {
                      issues: Array<{ path: PropertyKey[]; message: string }>;
                  };
              };
    }
): Promise<T | null> => {
    const payload = await parseTrustedJsonBody(
        req,
        res,
        logRequest,
        routeLabel,
        maxBodyBytes
    );
    if (payload === null) {
        return null;
    }

    const parsed = safeParse(payload);
    if (parsed.success) {
        return parsed.data;
    }

    const firstIssue = parsed.error.issues[0];
    const issuePath =
        firstIssue && firstIssue.path.length > 0
            ? firstIssue.path.join('.')
            : 'body';
    sendJson(res, 400, {
        error: 'Invalid request payload',
        details: `${issuePath}: ${firstIssue?.message ?? 'Invalid request payload'}`,
    });
    logRequest(req, res, `${routeLabel} invalid-payload`);
    return null;
};
