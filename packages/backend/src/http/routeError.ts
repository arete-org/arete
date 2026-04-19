/**
 * @description: Shares consistent route-level transport error handling helpers.
 * Ensures route modules return the same 500 response shape and logging behavior.
 * @footnote-scope: utility
 * @footnote-module: RouteError
 * @footnote-risk: low - Helper centralization only affects transport error fallback consistency.
 * @footnote-ethics: low - Error-shape consistency does not change policy or trust decisions.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

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

export { respondWithRouteError, type LogRequest };
