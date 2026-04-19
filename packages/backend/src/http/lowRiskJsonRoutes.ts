/**
 * @description: Composes low-risk JSON read routes into scoped Express routers.
 * Keeps behavior parity with existing handlers while narrowing normal-route dispatch surface.
 * @footnote-scope: interface
 * @footnote-module: LowRiskJsonRoutes
 * @footnote-risk: low - Router grouping can misroute requests if path normalization changes.
 * @footnote-ethics: low - Read-only route wiring does not change trust or governance decisions.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';

type RequestHandler = (
    req: IncomingMessage,
    res: ServerResponse
) => Promise<void>;

type BlogPostHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    postId: string
) => Promise<void>;

type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

type RegisterLowRiskJsonRoutesDeps = {
    app: express.Express;
    normalizePathname: (pathname: string) => string;
    handleRuntimeConfigRequest: RequestHandler;
    handleChatProfilesRequest: RequestHandler;
    handleBlogIndexRequest: RequestHandler;
    handleBlogPostRequest: BlogPostHandler;
    logRequest: LogRequest;
};

const getRequestUrl = (req: IncomingMessage): string | undefined => {
    const requestWithOriginalUrl = req as IncomingMessage & {
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

const respondWithRouteError = (
    req: IncomingMessage,
    res: ServerResponse,
    logRequestWithContext: LogRequest,
    error: unknown
): void => {
    res.statusCode = 500;
    res.end('Internal Server Error');
    logRequestWithContext(
        req,
        res,
        error instanceof Error ? error.message : 'unknown error'
    );
};

const registerLowRiskJsonRoutes = ({
    app,
    normalizePathname,
    handleRuntimeConfigRequest,
    handleChatProfilesRequest,
    handleBlogIndexRequest,
    handleBlogPostRequest,
    logRequest,
}: RegisterLowRiskJsonRoutesDeps): void => {
    app.all('/config.json', async (req, res) => {
        try {
            await handleRuntimeConfigRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    const chatRouter = express.Router();
    chatRouter.use(async (req, res, next) => {
        const requestUrl = getRequestUrl(req);
        if (!requestUrl) {
            res.status(400).end('Bad Request');
            return;
        }

        try {
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);
            if (normalizedPathname !== '/api/chat/profiles') {
                next();
                return;
            }
            await handleChatProfilesRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });
    app.use('/api/chat', chatRouter);

    const blogRouter = express.Router();
    blogRouter.use(async (req, res, next) => {
        const requestUrl = getRequestUrl(req);
        if (!requestUrl) {
            res.status(400).end('Bad Request');
            return;
        }

        try {
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);
            if (normalizedPathname === '/api/blog-posts') {
                await handleBlogIndexRequest(req, res);
                return;
            }
            if (normalizedPathname.startsWith('/api/blog-posts/')) {
                const postId = normalizedPathname.split('/').pop() || '';
                await handleBlogPostRequest(req, res, postId);
                return;
            }
            next();
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });
    app.use('/api/blog-posts', blogRouter);
};

export { registerLowRiskJsonRoutes };
