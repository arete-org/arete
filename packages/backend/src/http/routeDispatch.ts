/**
 * @description: Centralizes ordered special transport-boundary dispatch paths.
 * Keeps explicit handling for raw-body webhook and dual-use trace Accept-negotiated behavior.
 * @footnote-scope: core
 * @footnote-module: RouteDispatch
 * @footnote-risk: high - Route order mistakes can silently change endpoint behavior.
 * @footnote-ethics: medium - Dispatch order controls which trust/auth checks run first.
 */
import type http from 'node:http';
import { wantsTraceJsonResponse } from './traceAccept.js';

// --- Route path helpers ---
const normalizePathname = (pathname: string): string =>
    pathname.length > 1 && pathname.endsWith('/')
        ? pathname.slice(0, -1)
        : pathname;

type RequestHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse
) => Promise<void>;
type ParsedUrlHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedUrl: URL
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
    handleTraceRequest: ParsedUrlHandler;
};

/**
 * Keeps central transport-boundary matching rules explicit and ordered.
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
        // --- Special routes (keep at top; raw-body/signature-sensitive) ---
        // Keep webhook dispatch ahead of any future generic body middleware. Signature checks require exact raw bytes.
        if (normalizedPathname === '/api/webhook/github') {
            await handlers.handleWebhookRequest(req, res);
            return 'handled';
        }

        // --- Special dual-use trace route ---
        // This path also doubles as a browser route for the trace page.
        // Keep JSON-vs-HTML behavior exactly as-is.
        if (normalizedPathname.startsWith('/api/traces/')) {
            // Tell caches to keep JSON and HTML variants separate.
            res.setHeader('Vary', 'Accept');
            if (wantsTraceJsonResponse(req)) {
                onTraceRouteMatched(normalizedPathname);
                await handlers.handleTraceRequest(req, res, parsedUrl);
                return 'handled';
            }
            // Fall through to static resolver for SPA HTML.
            return 'fallthrough';
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
