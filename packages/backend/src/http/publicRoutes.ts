/**
 * @description: Composes public routes into scoped Express routers.
 * Keeps behavior parity with existing handlers while preserving explicit special transport dispatch boundaries.
 * @footnote-scope: interface
 * @footnote-module: PublicRoutes
 * @footnote-risk: low - Router grouping can misroute requests if path normalization changes.
 * @footnote-ethics: low - Read-only route wiring does not change trust or governance decisions.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { respondWithRouteError, type LogRequest } from './routeError.js';

type RequestHandler = (
    req: IncomingMessage,
    res: ServerResponse
) => Promise<void>;

type RegisterPublicRoutesDeps = {
    app: express.Express;
    handleRuntimeConfigRequest: RequestHandler;
    handleChatProfilesRequest: RequestHandler;
    logRequest: LogRequest;
};

/**
 * Registers public routes in the Express shell.
 *
 * Public route contract:
 * - `/config.json`
 * - `/api/chat/profiles`
 * - Unmatched `/api/chat/*` requests intentionally fall through to downstream
 *   dispatch (fail-open behavior).
 *
 * @param app Express app receiving mounted public routes.
 * @param handleRuntimeConfigRequest Existing `/config.json` handler.
 * @param handleChatProfilesRequest Existing `/api/chat/profiles` handler.
 * @param logRequest Shared request logger used for route-level error context.
 * @returns void
 */
const registerPublicRoutes = ({
    app,
    handleRuntimeConfigRequest,
    handleChatProfilesRequest,
    logRequest,
}: RegisterPublicRoutesDeps): void => {
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
};

export { registerPublicRoutes };
