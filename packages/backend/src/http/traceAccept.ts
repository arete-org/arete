/**
 * @description: Encapsulates Accept negotiation for dual-use trace transport paths.
 * @footnote-scope: utility
 * @footnote-module: TraceAccept
 * @footnote-risk: medium - Negotiation drift can break API clients or SPA trace-page routing.
 * @footnote-ethics: medium - Incorrect negotiation can hide provenance data from users.
 */
import type http from 'node:http';

/**
 * /api/traces/:responseId is dual-use:
 * - API clients need JSON metadata.
 * - Browsers can request the SPA shell for the trace page.
 *
 * Keep this logic isolated so generic middleware changes do not alter transport semantics.
 */
const wantsTraceJsonResponse = (req: http.IncomingMessage): boolean => {
    const headerValue = req.headers.accept;
    const acceptHeader = Array.isArray(headerValue)
        ? headerValue.join(',')
        : headerValue || '';
    const normalized = acceptHeader.toLowerCase();
    const wantsHtml =
        normalized.includes('text/html') ||
        normalized.includes('application/xhtml+xml');
    const wantsJson =
        normalized.includes('application/json') || normalized.includes('+json');

    if (wantsHtml && !wantsJson) {
        return false;
    }

    // Fail-open toward JSON for clients that send generic or missing Accept headers.
    return true;
};

export { wantsTraceJsonResponse };
