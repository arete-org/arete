/**
 * @description: Builds the Express transport composition root.
 * Composes standard routes, central transport-boundary dispatch, and static/SPA/CSP fallback without global body parsing.
 * @footnote-scope: interface
 * @footnote-module: ExpressAppShell
 * @footnote-risk: medium - Middleware ordering mistakes can change route fallthrough behavior.
 * @footnote-ethics: low - Transport composition changes do not alter policy decisions or user data handling.
 */
import type http from 'node:http';
import express from 'express';
import { registerPublicRoutes } from './publicRoutes.js';
import { registerIncidentRoutes } from './incidentRoutes.js';
import { registerChatRoutes } from './chatRoutes.js';
import { registerInternalRoutes } from './internalRoutes.js';
import { registerTraceRoutes } from './traceRoutes.js';
import { getRequestUrl } from './requestUrl.js';

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
    trustProxy: boolean;
    blogReadRateLimitConfig: {
        limit: number;
        windowMs: number;
    };
    handleIncidentListRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        parsedUrl: URL
    ) => Promise<void>;
    handleIncidentReportRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleIncidentStatusRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        parsedUrl: URL
    ) => Promise<void>;
    handleIncidentNotesRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        parsedUrl: URL
    ) => Promise<void>;
    handleIncidentRemediationRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        parsedUrl: URL
    ) => Promise<void>;
    handleIncidentDetailRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        parsedUrl: URL
    ) => Promise<void>;
    handleChatRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleInternalTextRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleInternalImageRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleInternalVoiceTtsRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleTraceUpsertRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleTraceCardCreateRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleTraceCardFromTraceRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) => Promise<void>;
    handleTraceCardAssetRequest: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        parsedUrl: URL
    ) => Promise<void>;
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
    handleStaticTransportRequest: HandleStaticTransportRequest;
    resolveAsset: ResolveAsset;
    mimeMap: ReadonlyMap<string, string>;
    frameAncestors: readonly string[];
    logRequest: LogRequest;
};

const createExpressApp = ({
    dispatchHttpRoute,
    normalizePathname,
    trustProxy,
    blogReadRateLimitConfig,
    handleIncidentListRequest,
    handleIncidentReportRequest,
    handleIncidentStatusRequest,
    handleIncidentNotesRequest,
    handleIncidentRemediationRequest,
    handleIncidentDetailRequest,
    handleChatRequest,
    handleInternalTextRequest,
    handleInternalImageRequest,
    handleInternalVoiceTtsRequest,
    handleTraceUpsertRequest,
    handleTraceCardCreateRequest,
    handleTraceCardFromTraceRequest,
    handleTraceCardAssetRequest,
    handleRuntimeConfigRequest,
    handleChatProfilesRequest,
    handleBlogIndexRequest,
    handleBlogPostRequest,
    handleStaticTransportRequest,
    resolveAsset,
    mimeMap,
    frameAncestors,
    logRequest,
}: CreateExpressAppDeps): express.Express => {
    const app = express();
    app.set('trust proxy', trustProxy);

    // Stage 1: public and other Express-owned standard HTTP routes.
    registerPublicRoutes({
        app,
        normalizePathname,
        blogReadRateLimitConfig,
        handleRuntimeConfigRequest,
        handleChatProfilesRequest,
        handleBlogIndexRequest,
        handleBlogPostRequest,
        logRequest,
    });
    registerIncidentRoutes({
        app,
        normalizePathname,
        handleIncidentListRequest,
        handleIncidentReportRequest,
        handleIncidentStatusRequest,
        handleIncidentNotesRequest,
        handleIncidentRemediationRequest,
        handleIncidentDetailRequest,
        logRequest,
    });
    registerChatRoutes({
        app,
        handleChatRequest,
        logRequest,
    });
    registerInternalRoutes({
        app,
        normalizePathname,
        handleInternalTextRequest,
        handleInternalImageRequest,
        handleInternalVoiceTtsRequest,
        logRequest,
    });
    registerTraceRoutes({
        app,
        normalizePathname,
        handleTraceUpsertRequest,
        handleTraceCardCreateRequest,
        handleTraceCardFromTraceRequest,
        handleTraceCardAssetRequest,
        logRequest,
    });

    // Stage 2: central explicit special-boundary dispatch.
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

    // Stage 3: static/SPA/CSP fallback terminal stage.
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
