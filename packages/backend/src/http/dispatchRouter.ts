/**
 * @description: Provides a shared dispatch router factory for normalized-path matching route modules.
 * Centralizes URL parsing and route-level error handling so modules can focus on route-specific matching.
 * @footnote-scope: utility
 * @footnote-module: DispatchRouter
 * @footnote-risk: medium - Shared matching/dispatch helpers can affect multiple route modules if behavior changes.
 * @footnote-ethics: low - Transport helper reuse does not change policy or trust decisions.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { getRequestUrl } from './requestUrl.js';
import { respondWithRouteError, type LogRequest } from './routeError.js';

type RequestHandler = (
    req: IncomingMessage,
    res: ServerResponse
) => Promise<void>;

type ParsedUrlHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: URL
) => Promise<void>;

type CreateDispatchRouterArgs = {
    normalizePathname: (pathname: string) => string;
    logRequest: LogRequest;
    matcher: (args: {
        req: IncomingMessage;
        res: ServerResponse;
        next: express.NextFunction;
        parsedUrl: URL;
        normalizedPathname: string;
    }) => Promise<void>;
};

const createDispatchRouter = ({
    normalizePathname,
    logRequest,
    matcher,
}: CreateDispatchRouterArgs): express.Router => {
    const router = express.Router();
    router.use(async (req, res, next) => {
        try {
            const requestUrl = getRequestUrl(req);
            if (!requestUrl) {
                res.status(400).end('Bad Request');
                return;
            }
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);
            await matcher({
                req,
                res,
                next,
                parsedUrl,
                normalizedPathname,
            });
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });
    return router;
};

export {
    createDispatchRouter,
    type LogRequest,
    type ParsedUrlHandler,
    type RequestHandler,
};
