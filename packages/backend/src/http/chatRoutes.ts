/**
 * @description: Composes the chat HTTP boundary into an explicit Express router.
 * Preserves existing /api/chat handler behavior while narrowing special central dispatch ownership.
 * @footnote-scope: interface
 * @footnote-module: ChatRoutes
 * @footnote-risk: medium - Route matching drift can break CORS preflight or chat request handling.
 * @footnote-ethics: medium - Chat transport boundaries enforce abuse controls and trusted service access.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { getRequestUrl } from './requestUrl.js';

type RequestHandler = (
    req: IncomingMessage,
    res: ServerResponse
) => Promise<void>;

type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

type RegisterChatRoutesDeps = {
    app: express.Express;
    normalizePathname: (pathname: string) => string;
    handleChatRequest: RequestHandler;
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

const registerChatRoutes = ({
    app,
    normalizePathname,
    handleChatRequest,
    logRequest,
}: RegisterChatRoutesDeps): void => {
    const chatRouter = express.Router();
    chatRouter.use(async (req, res, next) => {
        try {
            const requestUrl = getRequestUrl(req);
            if (!requestUrl) {
                res.status(400).end('Bad Request');
                return;
            }
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);

            if (normalizedPathname === '/api/chat') {
                await handleChatRequest(req, res);
                return;
            }

            next();
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    app.use('/api/chat', chatRouter);
};

export { registerChatRoutes };
