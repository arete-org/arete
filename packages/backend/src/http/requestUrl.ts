/**
 * @description: Resolves the effective request URL from node:http and Express request objects.
 * Prefers originalUrl when available so mounted routers preserve full-path matching context.
 * @footnote-scope: utility
 * @footnote-module: RequestUrlHelper
 * @footnote-risk: low - Incorrect URL extraction can misroute requests but is limited to transport parsing.
 * @footnote-ethics: low - URL extraction does not change trust, policy, or data governance decisions.
 */
import type http from 'node:http';

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

export { getRequestUrl };
