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

type RegisterInternalRoutesDeps = {
    app: express.Express;
    normalizePathname: (pathname: string) => string;
    handleInternalTextRequest: RequestHandler;
    handleInternalImageRequest: RequestHandler;
    handleInternalVoiceTtsRequest: RequestHandler;
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

const registerInternalRoutes = ({
    app,
    normalizePathname,
    handleInternalTextRequest,
    handleInternalImageRequest,
    handleInternalVoiceTtsRequest,
    logRequest,
}: RegisterInternalRoutesDeps): void => {
    const internalRouter = express.Router();
    internalRouter.use(async (req, res, next) => {
        try {
            const requestUrl = getRequestUrl(req);
            if (!requestUrl) {
                res.status(400).end('Bad Request');
                return;
            }
            const parsedUrl = new URL(requestUrl, 'http://localhost');
            const normalizedPathname = normalizePathname(parsedUrl.pathname);

            if (normalizedPathname === '/api/internal/text') {
                await handleInternalTextRequest(req, res);
                return;
            }

            // Keep this route boundary explicit because the handler owns NDJSON
            // streaming semantics and no-buffering headers.
            if (normalizedPathname === '/api/internal/image') {
                await handleInternalImageRequest(req, res);
                return;
            }

            if (normalizedPathname === '/api/internal/voice/tts') {
                await handleInternalVoiceTtsRequest(req, res);
                return;
            }

            next();
        } catch (error) {
            respondWithRouteError(req, res, logRequest, error);
        }
    });

    app.use('/api/internal', internalRouter);
};

export { registerInternalRoutes };
