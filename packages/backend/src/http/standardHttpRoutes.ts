/**
 * @description: Composes standard HTTP JSON read routes into scoped Express routers.
 * Keeps behavior parity with existing handlers while narrowing central transport dispatch surface.
 * @footnote-scope: interface
 * @footnote-module: StandardHttpRoutes
 * @footnote-risk: low - Router grouping can misroute requests if path normalization changes.
 * @footnote-ethics: low - Read-only route wiring does not change trust or governance decisions.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { getRequestUrl } from './requestUrl.js';

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

type RegisterStandardHttpRoutesDeps = {
    app: express.Express;
    normalizePathname: (pathname: string) => string;
    blogReadRateLimitConfig: {
        limit: number;
        windowMs: number;
    };
    handleRuntimeConfigRequest: RequestHandler;
    handleChatProfilesRequest: RequestHandler;
    handleBlogIndexRequest: RequestHandler;
    handleBlogPostRequest: BlogPostHandler;
    logRequest: LogRequest;
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

/**
 * Registers standard HTTP JSON route boundaries in the Express shell.
 *
 * Public route contract:
 * - `/config.json`
 * - `/api/chat/profiles`
 * - `/api/blog-posts` and `/api/blog-posts/:postId`
 *
 * Notes:
 * - Blog reads are protected by route-scoped rate limiting.
 * - Unmatched `/api/chat/*` and `/api/blog-posts/*` requests intentionally
 *   fall through to downstream dispatch (fail-open behavior).
 *
 * @param app Express app receiving mounted standard routes.
 * @param normalizePathname Shared path normalizer for trailing-slash parity.
 * @param blogReadRateLimitConfig Per-IP limiter window/limit for blog routes.
 * @param handleRuntimeConfigRequest Existing `/config.json` handler.
 * @param handleChatProfilesRequest Existing `/api/chat/profiles` handler.
 * @param handleBlogIndexRequest Existing blog index handler.
 * @param handleBlogPostRequest Existing blog post-by-id handler.
 * @param logRequest Shared request logger used for route-level error context.
 * @returns void
 */
const registerStandardHttpRoutes = ({
    app,
    normalizePathname,
    blogReadRateLimitConfig,
    handleRuntimeConfigRequest,
    handleChatProfilesRequest,
    handleBlogIndexRequest,
    handleBlogPostRequest,
    logRequest,
}: RegisterStandardHttpRoutesDeps): void => {
    app.all('/config.json', async (req, res) => {
        try {
            await handleRuntimeConfigRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    const chatRouter = express.Router();
    chatRouter.all('/profiles', async (req, res) => {
        try {
            await handleChatProfilesRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });
    app.use('/api/chat', chatRouter);

    const blogRouter = express.Router();
    const blogRateLimiter = rateLimit({
        windowMs: blogReadRateLimitConfig.windowMs,
        limit: blogReadRateLimitConfig.limit,
        standardHeaders: true,
        legacyHeaders: false,
        statusCode: 429,
        message: {
            error: 'Too many requests',
        },
    });
    blogRouter.use(blogRateLimiter);
    blogRouter.all('/', async (req, res) => {
        try {
            await handleBlogIndexRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });
    blogRouter.all('/:postId', async (req, res, next) => {
        try {
            const requestUrl = getRequestUrl(req);
            if (!requestUrl) {
                res.status(400).end('Bad Request');
                return;
            }
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);
            const postId = String(req.params.postId ?? '');
            if (!postId || normalizedPathname === '/api/blog-posts') {
                next();
                return;
            }
            await handleBlogPostRequest(req, res, postId);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });
    app.use('/api/blog-posts', blogRouter);
};

export { registerStandardHttpRoutes };
