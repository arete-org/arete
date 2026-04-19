/**
 * @description: Serves static assets, SPA fallback content, and HTML-specific CSP headers.
 * @footnote-scope: interface
 * @footnote-module: StaticTransport
 * @footnote-risk: high - Incorrect static transport can break frontend delivery or CSP enforcement.
 * @footnote-ethics: medium - CSP coverage protects users from script injection on trusted pages.
 */
import type http from 'node:http';
import path from 'node:path';

type ResolvedAsset = {
    content: Buffer;
    absolutePath: string;
};

type ResolveAsset = (requestPath: string) => Promise<ResolvedAsset | undefined>;

type LogRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    extra?: string
) => void;

type StaticTransportDeps = {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    parsedUrl: URL;
    resolveAsset: ResolveAsset;
    mimeMap: ReadonlyMap<string, string>;
    frameAncestors: readonly string[];
    logRequest: LogRequest;
};

const trimTrailingSlashes = (value: string): string => {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') {
        end -= 1;
    }
    return value.slice(0, end);
};

const maybeApplyHtmlCsp = ({
    req,
    res,
    parsedUrl,
    contentType,
    frameAncestors,
}: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    parsedUrl: URL;
    contentType: string;
    frameAncestors: readonly string[];
}): void => {
    // Keep CSP attached only to HTML responses. Non-HTML assets must remain cacheable and unmodified.
    const isHtml =
        contentType.includes('text/html') ||
        parsedUrl.pathname === '/' ||
        parsedUrl.pathname.endsWith('.html') ||
        parsedUrl.pathname.startsWith('/embed');

    if (!isHtml) {
        return;
    }

    const forwardedProto =
        typeof req.headers['x-forwarded-proto'] === 'string'
            ? req.headers['x-forwarded-proto']
            : undefined;
    const scheme = forwardedProto?.split(',')[0].trim() || 'http';
    const hostHeader =
        typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
    const requestOrigin = hostHeader ? `${scheme}://${hostHeader}` : '';

    // Keep self + current host explicit so embed behavior is stable across proxy/front-door setups.
    const mergedFrameAncestors = [
        "'self'",
        ...(requestOrigin ? [requestOrigin] : []),
        ...frameAncestors,
    ];
    const normalizedFrameAncestors = [
        ...new Set(mergedFrameAncestors.map(trimTrailingSlashes)),
    ];

    const csp = [
        `frame-ancestors ${normalizedFrameAncestors.join(' ')}`,
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://challenges.cloudflare.com",
        "style-src 'self' 'unsafe-inline' data:",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "frame-src 'self' https://challenges.cloudflare.com",
        "connect-src 'self' https://challenges.cloudflare.com https://api.openai.com",
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
};

const handleStaticTransportRequest = async ({
    req,
    res,
    parsedUrl,
    resolveAsset,
    mimeMap,
    frameAncestors,
    logRequest,
}: StaticTransportDeps): Promise<void> => {
    // resolveAsset also owns SPA fallback behavior; keep that fallback path centralized.
    const asset = await resolveAsset(req.url ?? parsedUrl.pathname);
    if (!asset) {
        res.statusCode = 404;
        res.end('Not Found');
        logRequest(req, res, '(missing asset, index.html unavailable)');
        return;
    }

    const extension = path.extname(asset.absolutePath).toLowerCase();
    const contentType = mimeMap.get(extension) || 'application/octet-stream';

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=600');

    maybeApplyHtmlCsp({
        req,
        res,
        parsedUrl,
        contentType,
        frameAncestors,
    });

    res.end(asset.content);
    logRequest(req, res);
};

export { handleStaticTransportRequest };
