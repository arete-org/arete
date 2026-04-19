/**
 * @description: Centralizes ordered HTTP route dispatch for the backend node:http server.
 * @footnote-scope: core
 * @footnote-module: RouteDispatch
 * @footnote-risk: high - Route order mistakes can silently change endpoint behavior.
 * @footnote-ethics: medium - Dispatch order controls which trust/auth checks run first.
 */
import type http from 'node:http';

// --- Route path helpers ---
const INCIDENT_STATUS_PATH_PATTERN = /^\/api\/incidents\/[^/]+\/status$/;
const INCIDENT_NOTES_PATH_PATTERN = /^\/api\/incidents\/[^/]+\/notes$/;
const INCIDENT_REMEDIATION_PATH_PATTERN =
    /^\/api\/incidents\/[^/]+\/remediation$/;
const INCIDENT_DETAIL_PATH_PATTERN = /^\/api\/incidents\/[^/]+$/;
const TRACE_CARD_ASSET_PATH_PATTERN =
    /^\/api\/traces\/[^/]+\/assets\/trace-card\.svg$/;

const normalizePathname = (pathname: string): string =>
    pathname.length > 1 && pathname.endsWith('/')
        ? pathname.slice(0, -1)
        : pathname;

// Decide whether /api/traces/:responseId should return JSON or the SPA HTML shell.
// We default to JSON unless the Accept header clearly asks for HTML.
// This keeps API clients working even when they send a generic "*/*" Accept header.
const wantsJsonResponse = (req: http.IncomingMessage): boolean => {
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

    return true;
};

type RequestHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse
) => Promise<void>;
type ParsedUrlHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
) => Promise<void>;
type BlogPostHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    postId: string
) => Promise<void>;
type TraceRouteMatchedLogger = (pathname: string) => void;
type UpgradeHandler = (
    req: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer
) => void;

type DispatchOutcome = 'handled' | 'fallthrough';

type RouteDispatchHandlers = {
    handleWebhookRequest: RequestHandler;
    handleRuntimeConfigRequest: RequestHandler;
    handleIncidentListRequest: ParsedUrlHandler;
    handleIncidentReportRequest: RequestHandler;
    handleInternalTextRequest: RequestHandler;
    handleInternalImageRequest: RequestHandler;
    handleInternalVoiceTtsRequest: RequestHandler;
    handleIncidentStatusRequest: ParsedUrlHandler;
    handleIncidentNotesRequest: ParsedUrlHandler;
    handleIncidentRemediationRequest: ParsedUrlHandler;
    handleIncidentDetailRequest: ParsedUrlHandler;
    handleBlogIndexRequest: RequestHandler;
    handleBlogPostRequest: BlogPostHandler;
    handleTraceUpsertRequest: RequestHandler;
    handleTraceCardCreateRequest: RequestHandler;
    handleTraceCardFromTraceRequest: RequestHandler;
    handleTraceCardAssetRequest: ParsedUrlHandler;
    handleTraceRequest: ParsedUrlHandler;
    handleChatRequest: RequestHandler;
    handleChatProfilesRequest: RequestHandler;
};

/**
 * Keeps route matching rules explicit and ordered.
 * Order is behavior: first match wins and later checks never run.
 */
const createRouteDispatcher = ({
    handlers,
    onTraceRouteMatched,
}: {
    handlers: RouteDispatchHandlers;
    onTraceRouteMatched: TraceRouteMatchedLogger;
}) => {
    const dispatchHttpRoute = async ({
        req,
        res,
        parsedUrl,
        normalizedPathname,
    }: {
        req: http.IncomingMessage;
        res: http.ServerResponse;
        parsedUrl: URL;
        normalizedPathname: string;
    }): Promise<DispatchOutcome> => {
        // --- Special routes (keep at top; auth/signature-sensitive) ---
        if (normalizedPathname === '/api/webhook/github') {
            await handlers.handleWebhookRequest(req, res);
            return 'handled';
        }

        // --- Runtime config route ---
        if (normalizedPathname === '/config.json') {
            await handlers.handleRuntimeConfigRequest(req, res);
            return 'handled';
        }

        // --- Incident routes ---
        if (normalizedPathname === '/api/incidents') {
            await handlers.handleIncidentListRequest(req, res, parsedUrl);
            return 'handled';
        }

        // Keep explicit report route before generic /api/incidents/:incidentId.
        if (normalizedPathname === '/api/incidents/report') {
            await handlers.handleIncidentReportRequest(req, res);
            return 'handled';
        }

        // --- Trusted internal routes ---
        if (normalizedPathname === '/api/internal/text') {
            await handlers.handleInternalTextRequest(req, res);
            return 'handled';
        }

        if (normalizedPathname === '/api/internal/image') {
            await handlers.handleInternalImageRequest(req, res);
            return 'handled';
        }

        if (normalizedPathname === '/api/internal/voice/tts') {
            await handlers.handleInternalVoiceTtsRequest(req, res);
            return 'handled';
        }

        // --- Incident detail sub-routes ---
        if (INCIDENT_STATUS_PATH_PATTERN.test(normalizedPathname)) {
            await handlers.handleIncidentStatusRequest(req, res, parsedUrl);
            return 'handled';
        }

        if (INCIDENT_NOTES_PATH_PATTERN.test(normalizedPathname)) {
            await handlers.handleIncidentNotesRequest(req, res, parsedUrl);
            return 'handled';
        }

        if (INCIDENT_REMEDIATION_PATH_PATTERN.test(normalizedPathname)) {
            await handlers.handleIncidentRemediationRequest(
                req,
                res,
                parsedUrl
            );
            return 'handled';
        }

        if (INCIDENT_DETAIL_PATH_PATTERN.test(normalizedPathname)) {
            await handlers.handleIncidentDetailRequest(req, res, parsedUrl);
            return 'handled';
        }

        // --- Blog routes ---
        if (normalizedPathname === '/api/blog-posts') {
            await handlers.handleBlogIndexRequest(req, res);
            return 'handled';
        }

        if (normalizedPathname.startsWith('/api/blog-posts/')) {
            const postId = normalizedPathname.split('/').pop() || '';
            await handlers.handleBlogPostRequest(req, res, postId);
            return 'handled';
        }

        // --- Trace write/asset routes ---
        if (normalizedPathname === '/api/traces') {
            await handlers.handleTraceUpsertRequest(req, res);
            return 'handled';
        }

        if (normalizedPathname === '/api/trace-cards') {
            await handlers.handleTraceCardCreateRequest(req, res);
            return 'handled';
        }

        if (normalizedPathname === '/api/trace-cards/from-trace') {
            await handlers.handleTraceCardFromTraceRequest(req, res);
            return 'handled';
        }

        if (TRACE_CARD_ASSET_PATH_PATTERN.test(normalizedPathname)) {
            await handlers.handleTraceCardAssetRequest(req, res, parsedUrl);
            return 'handled';
        }

        // --- Special dual-use trace route ---
        // This path also doubles as a browser route for the trace page.
        // Keep JSON-vs-HTML behavior exactly as-is.
        if (normalizedPathname.startsWith('/api/traces/')) {
            // Tell caches to keep JSON and HTML variants separate.
            res.setHeader('Vary', 'Accept');
            if (wantsJsonResponse(req)) {
                onTraceRouteMatched(normalizedPathname);
                await handlers.handleTraceRequest(req, res, parsedUrl);
                return 'handled';
            }
            // Fall through to static resolver for SPA HTML.
            return 'fallthrough';
        }

        // --- Chat routes ---
        if (normalizedPathname === '/api/chat') {
            await handlers.handleChatRequest(req, res);
            return 'handled';
        }

        if (normalizedPathname === '/api/chat/profiles') {
            await handlers.handleChatProfilesRequest(req, res);
            return 'handled';
        }

        return 'fallthrough';
    };

    const dispatchUpgradeRoute = ({
        req,
        socket,
        head,
        normalizedPathname,
        handleInternalVoiceRealtimeUpgrade,
    }: {
        req: http.IncomingMessage;
        socket: import('node:stream').Duplex;
        head: Buffer;
        normalizedPathname: string;
        handleInternalVoiceRealtimeUpgrade: UpgradeHandler;
    }): boolean => {
        // Special websocket route for realtime voice.
        if (normalizedPathname === '/api/internal/voice/realtime') {
            handleInternalVoiceRealtimeUpgrade(req, socket, head);
            return true;
        }

        return false;
    };

    return { dispatchHttpRoute, dispatchUpgradeRoute };
};

export { createRouteDispatcher, normalizePathname };
