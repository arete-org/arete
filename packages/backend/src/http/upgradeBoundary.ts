/**
 * @description: Handles websocket upgrade boundary routing for transport-sensitive paths.
 * @footnote-scope: interface
 * @footnote-module: UpgradeBoundary
 * @footnote-risk: high - Upgrade routing mistakes can break realtime sessions or leave sockets hanging.
 * @footnote-ethics: high - Realtime voice transport carries sensitive data and must keep strict boundaries.
 */
import type http from 'node:http';
import type { Duplex } from 'node:stream';

type DispatchUpgradeRoute = (args: {
    req: http.IncomingMessage;
    socket: Duplex;
    head: Buffer;
    normalizedPathname: string;
    handleInternalVoiceRealtimeUpgrade: (
        req: http.IncomingMessage,
        socket: Duplex,
        head: Buffer
    ) => void;
}) => boolean;

type UpgradeDeps = {
    req: http.IncomingMessage;
    socket: Duplex;
    head: Buffer;
    normalizePathname: (pathname: string) => string;
    dispatchUpgradeRoute: DispatchUpgradeRoute;
    handleInternalVoiceRealtimeUpgrade: (
        req: http.IncomingMessage,
        socket: Duplex,
        head: Buffer
    ) => void;
    logUpgradeError: (error: unknown) => void;
};

const handleUpgradeBoundary = ({
    req,
    socket,
    head,
    normalizePathname,
    dispatchUpgradeRoute,
    handleInternalVoiceRealtimeUpgrade,
    logUpgradeError,
}: UpgradeDeps): void => {
    if (!req.url) {
        socket.destroy();
        return;
    }

    try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const normalizedPathname = normalizePathname(parsedUrl.pathname);
        const isUpgradeHandled = dispatchUpgradeRoute({
            req,
            socket,
            head,
            normalizedPathname,
            handleInternalVoiceRealtimeUpgrade,
        });
        if (isUpgradeHandled) {
            return;
        }
    } catch (error) {
        logUpgradeError(error);
    }

    // Unknown upgrade paths are always destroyed to avoid implicit websocket behavior.
    socket.destroy();
};

export { handleUpgradeBoundary };
