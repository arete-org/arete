/**
 * @description: Composes trusted internal HTTP routes into an explicit Express router.
 * Keeps auth/parsing/streaming-sensitive behavior in existing handlers while reducing central dispatch ownership.
 * @footnote-scope: interface
 * @footnote-module: InternalRoutes
 * @footnote-risk: high - Route-order or matching mistakes can expose trusted boundaries or break NDJSON streaming paths.
 * @footnote-ethics: high - Internal trusted routes process sensitive bot/runtime workflows and must remain explicit.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { respondWithRouteError, type LogRequest } from './routeError.js';

type RequestHandler = (
    req: IncomingMessage,
    res: ServerResponse
) => Promise<void>;

type RegisterInternalRoutesDeps = {
    app: express.Express;
    handleInternalTextRequest: RequestHandler;
    handleInternalImageRequest: RequestHandler;
    handleInternalVoiceTtsRequest: RequestHandler;
    logRequest: LogRequest;
};

/**
 * Registers trusted internal HTTP routes in the Express shell.
 *
 * Internal route contract:
 * - `app.use('/api/internal', internalRouter)` mount point
 * - `internalRouter.all('/text')` -> `/api/internal/text`
 * - `internalRouter.all('/image')` -> `/api/internal/image`
 * - `internalRouter.all('/voice/tts')` -> `/api/internal/voice/tts`
 *
 * Notes:
 * - Internal auth, body parsing, and authority decisions stay inside each
 *   existing handler to preserve trusted-boundary behavior.
 * - `/api/internal/image` keeps NDJSON and no-buffering transport ownership in
 *   its handler path.
 * - Unmatched `/api/internal/*` requests intentionally fall through to
 *   downstream dispatch (fail-open behavior).
 *
 * @param app Express app receiving mounted trusted internal routes.
 * @param handleInternalTextRequest Existing `/api/internal/text` handler.
 * @param handleInternalImageRequest Existing `/api/internal/image` handler.
 * @param handleInternalVoiceTtsRequest Existing `/api/internal/voice/tts` handler.
 * @param logRequest Shared request logger used for route-level error context.
 * @returns void
 */
const registerInternalRoutes = ({
    app,
    handleInternalTextRequest,
    handleInternalImageRequest,
    handleInternalVoiceTtsRequest,
    logRequest,
}: RegisterInternalRoutesDeps): void => {
    const internalRouter = express.Router();
    internalRouter.all('/text', async (req, res) => {
        try {
            await handleInternalTextRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    internalRouter.all('/image', async (req, res) => {
        try {
            // Keep this route boundary explicit because the handler owns NDJSON
            // streaming semantics and no-buffering headers.
            await handleInternalImageRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    internalRouter.all('/voice/tts', async (req, res) => {
        try {
            await handleInternalVoiceTtsRequest(req, res);
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    app.use('/api/internal', internalRouter);
};

export { registerInternalRoutes };
