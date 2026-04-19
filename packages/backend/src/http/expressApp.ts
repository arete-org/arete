/**
 * @description: Builds the Express composition shell for standard HTTP route dispatch.
 * Keeps special transport behavior explicit by delegating to existing route/static handlers without global body parsing.
 * @footnote-scope: interface
 * @footnote-module: ExpressAppShell
 * @footnote-risk: medium - Middleware ordering mistakes can change route fallthrough behavior.
 * @footnote-ethics: low - Transport composition changes do not alter policy decisions or user data handling.
 */
import type http from 'node:http';
import express from 'express';
import type { SimpleRateLimiter } from '../services/rateLimiter.js';
import { registerLowRiskJsonRoutes } from './lowRiskJsonRoutes.js';

type DispatchOutcome = 'handled' | 'fallthrough';

type DispatchHttpRoute = (args: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    parsedUrl: URL;
    normalizedPathname: string;
}) => Promise<DispatchOutcome>;

type ResolveAsset = (
    requestPath: string
) => Promise<{ content: Buffer; absolutePath: string } | undefined>;

type LogRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    extra?: string
) => void;

type HandleStaticTransportRequest = (args: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    parsedUrl: URL;
    resolveAsset: ResolveAsset;
    mimeMap: ReadonlyMap<string, string>;
    frameAncestors: readonly string[];
    logRequest: LogRequest;
}) => Promise<void>;

type CreateExpressAppDeps = {
    dispatchHttpRoute: DispatchHttpRoute;
    normalizePathname: (pathname: string) => string;
    handleRuntimeConfigRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleChatProfilesRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleBlogIndexRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleBlogPostRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        postId: string
    ) => Promise<void>;
    blogReadRateLimiter: SimpleRateLimiter;
    handleStaticTransportRequest: HandleStaticTransportRequest;
    resolveAsset: ResolveAsset;
    mimeMap: ReadonlyMap<string, string>;
    frameAncestors: readonly string[];
    logRequest: LogRequest;
};

const getRequestUrl = (req: http.IncomingMessage): string | undefined => {
    const requestWithOriginalUrl = req as http.IncomingMessage & {
        originalUrl?: unknown;
    };
    if (
        typeof requestWithOriginalUrl.originalUrl === 'string' &&
        requestWithOriginalUrl.originalUrl.length > 0
    ) {
        return requestWithOriginalUrl.originalUrl;
    }
    return (typeof req.url === 'string' && req.url) || undefined;
};

const createExpressApp = ({
    dispatchHttpRoute,
    normalizePathname,
    handleRuntimeConfigRequest,
    handleChatProfilesRequest,
    handleBlogIndexRequest,
    handleBlogPostRequest,
    blogReadRateLimiter,
    handleStaticTransportRequest,
    resolveAsset,
    mimeMap,
    frameAncestors,
    logRequest,
}: CreateExpressAppDeps): express.Express => {
    const app = express();

    registerLowRiskJsonRoutes({
        app,
        normalizePathname,
        handleRuntimeConfigRequest,
        handleChatProfilesRequest,
        handleBlogIndexRequest,
        handleBlogPostRequest,
        blogReadRateLimiter,
        logRequest,
    });

    // Normal HTTP API routes should be composed here with route-scoped middleware.
    // Keep request body parsing opt-in per route so signature/raw-body paths stay safe.
    app.use('/api', async (req, res, next) => {
        const requestUrl = getRequestUrl(req);
        if (!requestUrl) {
            res.status(400).end('Bad Request');
            return;
        }

        try {
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);
            const routeOutcome = await dispatchHttpRoute({
                req,
                res,
                parsedUrl,
                normalizedPathname,
            });
            if (routeOutcome === 'handled') {
                return;
            }
            next();
        } catch (error) {
            res.status(500).end('Internal Server Error');
            logRequest(
                req,
                res,
                error instanceof Error ? error.message : 'unknown error'
            );
        }
    });

    // Static assets and SPA fallback remain the terminal normal-HTTP transport stage.
    app.use(async (req, res) => {
        const requestUrl = getRequestUrl(req);
        if (!requestUrl) {
            res.status(400).end('Bad Request');
            return;
        }

        try {
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            await handleStaticTransportRequest({
                req,
                res,
                parsedUrl,
                resolveAsset,
                mimeMap,
                frameAncestors,
                logRequest,
            });
        } catch (error) {
            res.status(500).end('Internal Server Error');
            logRequest(
                req,
                res,
                error instanceof Error ? error.message : 'unknown error'
            );
        }
    });

    return app;
};

export { createExpressApp };
