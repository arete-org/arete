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
