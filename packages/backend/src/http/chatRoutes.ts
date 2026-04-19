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
import { respondWithRouteError, type LogRequest } from './routeError.js';

type RequestHandler = (
    req: IncomingMessage,
    res: ServerResponse
) => Promise<void>;

type RegisterChatRoutesDeps = {
    app: express.Express;
    handleChatRequest: RequestHandler;
    logRequest: LogRequest;
};

/**
 * Registers the bare chat endpoint in the Express shell.
 *
 * Chat route contract:
 * - `app.use('/api/chat', chatRouter)` mount point
 * - `chatRouter.all('/')` owns only `/api/chat`
 *
 * Notes:
 * - `/api/chat/profiles` is owned by `publicRoutes.ts`.
 * - Unmatched `/api/chat/*` requests intentionally fall through to downstream
 *   dispatch (fail-open behavior).
 *
 * @param app Express app receiving mounted chat routes.
 * @param handleChatRequest Existing `/api/chat` handler.
 * @param logRequest Shared request logger used for route-level error context.
 * @returns void
 */
const registerChatRoutes = ({
    app,
    handleChatRequest,
    logRequest,
}: RegisterChatRoutesDeps): void => {
    const chatRouter = express.Router();
    chatRouter.all('/', async (req, res, next) => {
        try {
            if (req.path === '/' || req.path === '') {
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
