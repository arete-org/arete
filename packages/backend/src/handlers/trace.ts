/**
 * @description: Handles trace storage and retrieval endpoints.
 * @footnote-scope: interface
 * @footnote-module: TraceHandlers
 * @footnote-risk: high - Trace loss undermines transparency guarantees.
 * @footnote-ethics: high - Provenance access impacts user trust and auditability.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import {
    PostTraceCardFromTraceRequestSchema,
    PostTraceCardRequestSchema,
    PostTracesRequestSchema,
} from '@footnote/contracts/web/schemas';
import type { SimpleRateLimiter } from '../services/rateLimiter.js';
import { renderTraceCardPng } from '../services/traceCard/traceCardRaster.js';
import { logger } from '../utils/logger.js';
import { type TraceStore } from '../storage/traces/traceStore.js';

// Shared log function signature used by handlers.
type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

// Dependencies injected by the server so handlers stay simple and testable.
type TraceHandlerDeps = {
    traceStore: TraceStore | null; // Trace storage backend; null means storage failed to initialize.
    logRequest: LogRequest; // Shared request logger for consistency.
    traceWriteLimiter: SimpleRateLimiter | null; // Optional per-client limiter for trace writes.
    traceToken: string | null; // Shared secret required to accept incoming trace writes.
    maxTraceBodyBytes: number; // Upper bound for trace JSON payload size.
    trustProxy: boolean; /* When true, read X-Forwarded-For to find the real client IP behind a proxy.
    We use the client IP for rate limiting and request logs.
    This matters because proxies hide the original IP unless we trust this header.
    When false, we fall back to the direct socket IP, which is safer when the proxy header cannot be trusted.
    The server sets this via WEB_TRUST_PROXY (true behind a reverse proxy, false for direct traffic). */
};

// Read results are modeled as simple statuses to avoid nested try/catch.
type TraceReadResult =
    | { status: 'found'; metadata: ResponseMetadata }
    | { status: 'not-found' }
    | { status: 'error'; errorMessage: string };

// Shared header name so auth checks stay consistent and easy to update.
const TRACE_TOKEN_HEADER = 'x-trace-token';

// Helper to send JSON consistently (status + headers + serialized payload).
const sendJson = (
    res: ServerResponse,
    statusCode: number,
    payload: unknown,
    extraHeaders?: Record<string, string>
): void => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (extraHeaders) {
        for (const [header, value] of Object.entries(extraHeaders)) {
            res.setHeader(header, value);
        }
    }
    res.end(JSON.stringify(payload));
};

// Sends SVG content with the correct media type so browsers/clients can render inline.
const sendSvg = (
    res: ServerResponse,
    statusCode: number,
    svg: string
): void => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.end(svg);
};

// Extract staleAfter if present and return a Date (or null if missing/invalid).
// Fail-open: if staleAfter is malformed, treat it as missing so we do not block reads.
const getStaleAfterDate = (metadata: ResponseMetadata): Date | null => {
    const staleAfter =
        typeof (metadata as { staleAfter?: unknown }).staleAfter === 'string'
            ? (metadata as { staleAfter?: string }).staleAfter
            : undefined;
    if (!staleAfter) {
        return null;
    }
    const staleAfterDate = new Date(staleAfter);
    return Number.isNaN(staleAfterDate.getTime()) ? null : staleAfterDate;
};

// Wrap storage access so callers can branch on a small status object.
const readTraceMetadata = async (
    store: TraceStore,
    responseId: string
): Promise<TraceReadResult> => {
    try {
        const metadata = await store.retrieve(responseId);
        if (!metadata) {
            return { status: 'not-found' };
        }
        return { status: 'found', metadata };
    } catch (error) {
        return {
            status: 'error',
            errorMessage:
                error instanceof Error ? error.message : String(error),
        };
    }
};

// --- Client IP parsing ---
const getClientIp = (req: IncomingMessage, trustProxy: boolean): string => {
    let clientIp = req.socket.remoteAddress || 'unknown';

    // Honor reverse proxy headers only when explicitly enabled.
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

    if (clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
    }

    return clientIp;
};

// Preview-generated cards get synthetic ids so they can still be fetched later.
const createPreviewTraceCardResponseId = (): string =>
    `trace-card-preview-${Date.now()}-${randomUUID().slice(0, 8)}`;

// --- Handler factory ---
// This factory builds trace request handlers used by the server router:
// - handleTraceRequest: reads a trace from storage and returns JSON
// - handleTraceUpsertRequest: accepts a trace payload, validates it, then stores it
// - handleTraceCardCreateRequest: builds/stores a trace-card and returns PNG payload
// - handleTraceCardAssetRequest: returns stored trace-card SVG
// The handlers are nested so they can share the injected dependencies without globals.
const createTraceHandlers = ({
    traceStore,
    logRequest,
    traceWriteLimiter,
    traceToken,
    maxTraceBodyBytes,
    trustProxy,
}: TraceHandlerDeps) => {
    // Guard: stop early when trace storage is unavailable.
    const requireTraceStore = (
        store: TraceStore | null,
        req: IncomingMessage,
        res: ServerResponse,
        logLabel: string
    ): store is TraceStore => {
        if (!store) {
            sendJson(res, 503, { error: 'Trace store unavailable' });
            logRequest(req, res, logLabel);
            return false;
        }
        return true;
    };

    // Guard: stop early when ingestion is not configured.
    const requireTraceToken = (
        token: string | null,
        req: IncomingMessage,
        res: ServerResponse,
        logLabel: string
    ): token is string => {
        if (!token) {
            sendJson(res, 503, { error: 'Trace ingestion not configured' });
            logRequest(req, res, logLabel);
            return false;
        }
        return true;
    };

    // Guard: stop early when the rate limiter is unavailable.
    const requireTraceWriteLimiter = (
        limiter: SimpleRateLimiter | null,
        req: IncomingMessage,
        res: ServerResponse,
        logLabel: string
    ): limiter is SimpleRateLimiter => {
        if (!limiter) {
            sendJson(res, 503, { error: 'Trace rate limiter unavailable' });
            logRequest(req, res, logLabel);
            return false;
        }
        return true;
    };

    /**
     * Shared guard path for trusted trace write endpoints.
     * Applies store/token/limiter checks and returns the client IP used for rate limiting.
     */
    const requireTraceWriteAccess = (
        req: IncomingMessage,
        res: ServerResponse,
        routeLabel: string
    ): { store: TraceStore } | null => {
        if (
            !requireTraceStore(
                traceStore,
                req,
                res,
                `${routeLabel} store-unavailable`
            )
        ) {
            return null;
        }

        if (
            !requireTraceToken(
                traceToken,
                req,
                res,
                `${routeLabel} token-not-configured`
            )
        ) {
            return null;
        }

        const providedToken = req.headers[TRACE_TOKEN_HEADER];
        const providedValue = Array.isArray(providedToken)
            ? providedToken[0]
            : providedToken;
        if (!providedValue) {
            sendJson(res, 401, { error: 'Missing trace token' });
            logRequest(req, res, `${routeLabel} missing-token`);
            return null;
        }

        if (String(providedValue) !== traceToken) {
            sendJson(res, 403, { error: 'Invalid trace token' });
            logRequest(req, res, `${routeLabel} invalid-token`);
            return null;
        }

        if (
            !requireTraceWriteLimiter(
                traceWriteLimiter,
                req,
                res,
                `${routeLabel} limiter-unavailable`
            )
        ) {
            return null;
        }

        const clientIp = getClientIp(req, trustProxy);
        const rateLimitResult = traceWriteLimiter.check(clientIp);
        if (!rateLimitResult.allowed) {
            sendJson(
                res,
                429,
                {
                    error: 'Too many trace writes',
                    retryAfter: rateLimitResult.retryAfter,
                },
                { 'Retry-After': rateLimitResult.retryAfter.toString() }
            );
            logRequest(req, res, `${routeLabel} rate-limited`);
            return null;
        }

        return { store: traceStore };
    };

    /**
     * Reads and parses JSON request bodies with the shared trace body-size limit.
     * Returns null when an error response has already been sent.
     */
    const parseTraceJsonBody = async (
        req: IncomingMessage,
        res: ServerResponse,
        routeLabel: string
    ): Promise<unknown | null> => {
        const contentLengthHeader = req.headers['content-length'];
        if (contentLengthHeader) {
            const contentLength = Number(contentLengthHeader);
            if (
                Number.isFinite(contentLength) &&
                contentLength > maxTraceBodyBytes
            ) {
                sendJson(res, 413, { error: 'Trace payload too large' });
                logRequest(
                    req,
                    res,
                    `${routeLabel} payload-too-large contentLength=${contentLength}`
                );
                return null;
            }
        }

        let body = '';
        let bodyTooLarge = false;
        let bodyBytes = 0;
        req.on('data', (chunk) => {
            bodyBytes += chunk.length;
            if (bodyBytes > maxTraceBodyBytes) {
                bodyTooLarge = true;
                sendJson(res, 413, { error: 'Trace payload too large' });
                logRequest(req, res, `${routeLabel} payload-too-large`);
                req.destroy();
                return;
            }

            body += chunk.toString();
        });

        await new Promise<void>((resolve, reject) => {
            req.on('end', () => resolve());
            req.on('error', reject);
        });

        if (bodyTooLarge) {
            return null;
        }

        if (!body) {
            sendJson(res, 400, { error: 'Missing request body' });
            logRequest(req, res, `${routeLabel} missing-body`);
            return null;
        }

        try {
            return JSON.parse(body) as unknown;
        } catch (error) {
            logger.warn(
                `${routeLabel} received invalid JSON body: ${error instanceof Error ? error.message : String(error)}`
            );
            sendJson(res, 400, { error: 'Invalid JSON body' });
            logRequest(req, res, `${routeLabel} invalid-json`);
            return null;
        }
    };

    /**
     * @api.operationId: getTrace
     * @api.path: GET /api/traces/{responseId}
     */
    // Read handler: parse responseId, load metadata, check staleness, respond.
    const handleTraceRequest = async (
        req: IncomingMessage,
        res: ServerResponse,
        parsedUrl: URL
    ): Promise<void> => {
        try {
            // Read flow: parse responseId -> check store -> load metadata -> enforce staleness -> respond.
            // Expect /api/traces/{responseId}
            const pathMatch = parsedUrl.pathname.match(
                /^\/api\/traces\/([^/]+)\/?$/
            );
            if (!pathMatch) {
                sendJson(res, 400, { error: 'Invalid trace request format' });
                logRequest(req, res, 'trace invalid-format');
                return;
            }

            const responseId = pathMatch[1];

            logger.debug(
                `Trace request received path=${parsedUrl.pathname} responseId=${responseId}`
            );

            // Fail open with a 503 if storage is not available.
            if (
                !requireTraceStore(
                    traceStore,
                    req,
                    res,
                    'trace store-unavailable'
                )
            ) {
                return;
            }

            const readResult = await readTraceMetadata(traceStore, responseId);
            if (readResult.status === 'not-found') {
                // Missing trace is not fatal but should return 404.
                sendJson(res, 404, { error: 'Trace not found' });
                logRequest(req, res, 'trace not-found');
                return;
            }

            if (readResult.status === 'error') {
                logger.error(
                    `Failed to retrieve trace for response "${responseId}": ${readResult.errorMessage}`
                );
                sendJson(res, 500, { error: 'Failed to read trace' });
                logRequest(req, res, `trace error ${readResult.errorMessage}`);
                return;
            }

            const metadata = readResult.metadata;

            // Respect staleAfter to avoid serving expired traces.
            const staleAfterDate = getStaleAfterDate(metadata);
            if (staleAfterDate && staleAfterDate < new Date()) {
                sendJson(res, 410, {
                    message: 'Trace is stale',
                    metadata,
                });
                logRequest(req, res, 'trace stale');
                return;
            }

            sendJson(res, 200, metadata);
            logRequest(req, res, 'trace success');
        } catch (error) {
            sendJson(
                res,
                500,
                { error: 'Internal server error' },
                { 'Cache-Control': 'no-store' }
            );
            logRequest(
                req,
                res,
                `trace error ${error instanceof Error ? error.message : 'unknown error'}`
            );
        }
    };

    // Write handler: validate, rate limit, then store the trace payload.
    /**
     * @api.operationId: postTraces
     * @api.path: POST /api/traces
     */
    const handleTraceUpsertRequest = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        try {
            // Write flow: require POST + token + limiter -> parse JSON -> validate -> store.
            // Only allow trace writes via POST.
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'trace upsert method-not-allowed');
                return;
            }

            const writeAccess = requireTraceWriteAccess(
                req,
                res,
                'trace upsert'
            );
            if (!writeAccess) {
                return;
            }

            const payload = await parseTraceJsonBody(req, res, 'trace upsert');
            if (!payload) {
                return;
            }

            const parsedPayload = PostTracesRequestSchema.safeParse(payload);
            if (!parsedPayload.success) {
                const missingResponseId = parsedPayload.error.issues.some(
                    (issue) =>
                        issue.path.length === 1 &&
                        issue.path[0] === 'responseId' &&
                        issue.code === 'invalid_type'
                );
                const firstIssue = parsedPayload.error.issues[0];
                const issuePath =
                    firstIssue && firstIssue.path.length > 0
                        ? firstIssue.path.join('.')
                        : 'body';
                const issueMessage =
                    firstIssue?.message ?? 'Invalid trace payload.';

                sendJson(res, 400, {
                    error: missingResponseId
                        ? 'Missing responseId'
                        : 'Invalid trace payload',
                    details: `${issuePath}: ${issueMessage}`,
                });
                logRequest(
                    req,
                    res,
                    missingResponseId
                        ? 'trace upsert missing-responseId'
                        : 'trace upsert invalid-payload'
                );
                return;
            }

            const normalizedMetadata = parsedPayload.data as ResponseMetadata;
            const responseId = normalizedMetadata.responseId;

            await writeAccess.store.upsert(normalizedMetadata);

            sendJson(res, 200, { ok: true, responseId });
            logRequest(req, res, `trace upsert success ${responseId}`);
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : 'unknown error';
            logger.error(`Trace upsert failed: ${errorMessage}`);
            sendJson(res, 500, { error: 'Failed to store trace' });
            logRequest(req, res, `trace upsert error ${errorMessage}`);
        }
    };

    /**
     * @api.operationId: postTraceCards
     * @api.path: POST /api/trace-cards
     */
    const handleTraceCardCreateRequest = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'trace card method-not-allowed');
                return;
            }

            const writeAccess = requireTraceWriteAccess(req, res, 'trace card');
            if (!writeAccess) {
                return;
            }
            const payload = await parseTraceJsonBody(req, res, 'trace card');
            if (!payload) return;

            const parsedPayload = PostTraceCardRequestSchema.safeParse(payload);
            if (!parsedPayload.success) {
                const firstIssue = parsedPayload.error.issues[0];
                const issuePath =
                    firstIssue && firstIssue.path.length > 0
                        ? firstIssue.path.join('.')
                        : 'body';
                const issueMessage =
                    firstIssue?.message ?? 'Invalid trace card payload.';

                sendJson(res, 400, {
                    error: 'Invalid trace card payload',
                    details: `${issuePath}: ${issueMessage}`,
                });
                logRequest(req, res, 'trace card invalid-payload');
                return;
            }

            const responseId =
                parsedPayload.data.responseId ??
                createPreviewTraceCardResponseId();
            const { svg, png } = renderTraceCardPng({
                temperament: parsedPayload.data.temperament,
                chips: parsedPayload.data.chips,
            });

            await writeAccess.store.upsertTraceCardSvg(responseId, svg);

            sendJson(res, 200, {
                responseId,
                pngBase64: png.toString('base64'),
            });
            logRequest(req, res, `trace card success ${responseId}`);
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : 'unknown error';
            logger.error(`Trace card create failed: ${errorMessage}`);
            sendJson(res, 500, { error: 'Failed to generate trace card' });
            logRequest(req, res, `trace card error ${errorMessage}`);
        }
    };

    /**
     * @api.operationId: postTraceCardsFromTrace
     * @api.path: POST /api/trace-cards/from-trace
     */
    const handleTraceCardFromTraceRequest = async (
        req: IncomingMessage,
        res: ServerResponse
    ): Promise<void> => {
        try {
            if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(
                    req,
                    res,
                    'trace card from-trace method-not-allowed'
                );
                return;
            }

            const writeAccess = requireTraceWriteAccess(
                req,
                res,
                'trace card from-trace'
            );
            if (!writeAccess) {
                return;
            }

            const payload = await parseTraceJsonBody(
                req,
                res,
                'trace card from-trace'
            );
            if (!payload) {
                return;
            }

            const parsedPayload =
                PostTraceCardFromTraceRequestSchema.safeParse(payload);
            if (!parsedPayload.success) {
                const firstIssue = parsedPayload.error.issues[0];
                const issuePath =
                    firstIssue && firstIssue.path.length > 0
                        ? firstIssue.path.join('.')
                        : 'body';
                const issueMessage =
                    firstIssue?.message ??
                    'Invalid trace card from-trace payload.';

                sendJson(res, 400, {
                    error: 'Invalid trace card payload',
                    details: `${issuePath}: ${issueMessage}`,
                });
                logRequest(req, res, 'trace card from-trace invalid-payload');
                return;
            }

            const responseId = parsedPayload.data.responseId;
            const metadata = await writeAccess.store.retrieve(responseId);
            if (!metadata) {
                sendJson(res, 404, { error: 'Trace not found' });
                logRequest(req, res, 'trace card from-trace trace-not-found');
                return;
            }

            const { svg, png } = renderTraceCardPng({
                temperament: metadata.temperament,
                chips: {
                    evidenceScore: metadata.evidenceScore,
                    freshnessScore: metadata.freshnessScore,
                },
            });

            await writeAccess.store.upsertTraceCardSvg(responseId, svg);

            sendJson(res, 200, {
                responseId,
                pngBase64: png.toString('base64'),
            });
            logRequest(req, res, `trace card from-trace success ${responseId}`);
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : 'unknown error';
            logger.error(`Trace card from-trace failed: ${errorMessage}`);
            sendJson(res, 500, { error: 'Failed to generate trace card' });
            logRequest(req, res, `trace card from-trace error ${errorMessage}`);
        }
    };

    /**
     * @api.operationId: getTraceCardSvg
     * @api.path: GET /api/traces/{responseId}/assets/trace-card.svg
     */
    const handleTraceCardAssetRequest = async (
        req: IncomingMessage,
        res: ServerResponse,
        parsedUrl: URL
    ): Promise<void> => {
        try {
            if (req.method !== 'GET') {
                sendJson(res, 405, { error: 'Method not allowed' });
                logRequest(req, res, 'trace card asset method-not-allowed');
                return;
            }

            const pathMatch = parsedUrl.pathname.match(
                /^\/api\/traces\/([^/]+)\/assets\/trace-card\.svg\/?$/
            );
            if (!pathMatch) {
                sendJson(res, 400, { error: 'Invalid trace request format' });
                logRequest(req, res, 'trace card asset invalid-format');
                return;
            }
            const responseId = pathMatch[1];

            if (
                !requireTraceStore(
                    traceStore,
                    req,
                    res,
                    'trace card asset store-unavailable'
                )
            ) {
                return;
            }

            const traceCardSvg = await traceStore.getTraceCardSvg(responseId);
            if (!traceCardSvg) {
                sendJson(res, 404, { error: 'Trace card not found' });
                logRequest(req, res, 'trace card asset not-found');
                return;
            }

            sendSvg(res, 200, traceCardSvg);
            logRequest(req, res, `trace card asset success ${responseId}`);
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : 'unknown error';
            logger.error(`Trace card asset read failed: ${errorMessage}`);
            sendJson(res, 500, { error: 'Failed to read trace card' });
            logRequest(req, res, `trace card asset error ${errorMessage}`);
        }
    };

    return {
        handleTraceRequest,
        handleTraceUpsertRequest,
        handleTraceCardCreateRequest,
        handleTraceCardFromTraceRequest,
        handleTraceCardAssetRequest,
    };
};

export { createTraceHandlers };
