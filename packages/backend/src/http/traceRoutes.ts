/**
 * @description: Composes trace write/card HTTP routes into an explicit Express router.
 * Keeps dual-use /api/traces/:id Accept negotiation in special dispatch while moving standard trace writes out of central ownership.
 * @footnote-scope: interface
 * @footnote-module: TraceRoutes
 * @footnote-risk: high - Route precedence mistakes can collide trace asset and trace detail paths.
 * @footnote-ethics: high - Trace transport affects provenance visibility and trusted write boundaries.
 */
import express from 'express';
import {
    createDispatchRouter,
    type LogRequest,
    type ParsedUrlHandler,
    type RequestHandler,
} from './dispatchRouter.js';

type RegisterTraceRoutesDeps = {
    app: express.Express;
    normalizePathname: (pathname: string) => string;
    handleTraceUpsertRequest: RequestHandler;
    handleTraceCardCreateRequest: RequestHandler;
    handleTraceCardFromTraceRequest: RequestHandler;
    handleTraceCardAssetRequest: ParsedUrlHandler;
    logRequest: LogRequest;
};

const TRACE_CARD_ASSET_PATH_PATTERN =
    /^\/api\/traces\/[^/]+\/assets\/trace-card\.svg$/;

/**
 * Registers trace write/card HTTP routes on the Express shell.
 *
 * Express-owned route contract (all under `app.use('/api', traceRouter)`):
 * - `POST /api/traces` -> `handleTraceUpsertRequest`
 * - `POST /api/trace-cards` -> `handleTraceCardCreateRequest`
 * - `POST /api/trace-cards/from-trace` -> `handleTraceCardFromTraceRequest`
 * - `GET /api/traces/:id/assets/trace-card.svg` (regex-matched) -> `handleTraceCardAssetRequest`
 *
 * Notes:
 * - `/api/traces/:id` (without `/assets/trace-card.svg`) intentionally falls
 *   through to central special transport dispatch so `Vary: Accept` JSON-vs-SPA
 *   negotiation remains authoritative there.
 * - Body parsing, auth, and provenance/authority decisions remain inside each
 *   handler; this module only owns path matching and route-level error logging.
 *
 * @param app Express app receiving the mounted trace router.
 * @param normalizePathname Shared path normalizer for trailing-slash parity.
 * @param handleTraceUpsertRequest Existing `/api/traces` write handler.
 * @param handleTraceCardCreateRequest Existing `/api/trace-cards` handler.
 * @param handleTraceCardFromTraceRequest Existing `/api/trace-cards/from-trace` handler.
 * @param handleTraceCardAssetRequest Existing trace-card SVG asset handler (receives parsedUrl).
 * @param logRequest Shared request logger used for route-level error context.
 * @returns void
 */
const registerTraceRoutes = ({
    app,
    normalizePathname,
    handleTraceUpsertRequest,
    handleTraceCardCreateRequest,
    handleTraceCardFromTraceRequest,
    handleTraceCardAssetRequest,
    logRequest,
}: RegisterTraceRoutesDeps): void => {
    const traceRouter = createDispatchRouter({
        normalizePathname,
        logRequest,
        matcher: async ({ req, res, next, parsedUrl, normalizedPathname }) => {
            if (normalizedPathname === '/api/traces') {
                await handleTraceUpsertRequest(req, res);
                return;
            }

            if (normalizedPathname === '/api/trace-cards') {
                await handleTraceCardCreateRequest(req, res);
                return;
            }

            if (normalizedPathname === '/api/trace-cards/from-trace') {
                await handleTraceCardFromTraceRequest(req, res);
                return;
            }

            if (TRACE_CARD_ASSET_PATH_PATTERN.test(normalizedPathname)) {
                await handleTraceCardAssetRequest(req, res, parsedUrl);
                return;
            }

            next();
        },
    });

    app.use('/api', traceRouter);
};

export { registerTraceRoutes };
