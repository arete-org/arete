/**
 * @description: Verifies the Express shell keeps route dispatch and static fallthrough boundaries explicit.
 * Confirms normal HTTP handling behavior remains composition-only with no implicit parsing side effects.
 * @footnote-scope: test
 * @footnote-module: ExpressAppTests
 * @footnote-risk: medium - Missing shell tests can hide regressions in route dispatch order and fallthrough.
 * @footnote-ethics: low - Tests validate transport composition and do not process sensitive user data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createExpressApp } from '../src/http/expressApp.js';

const TEST_HOST = '127.0.0.1';

const createUnhandledRouteHandler = async (
    _req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> => {
    res.statusCode = 501;
    res.end('not-implemented');
};

const createUnhandledBlogPostHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _postId: string
): Promise<void> => createUnhandledRouteHandler(req, res);

const createTestServer = (
    app: ReturnType<typeof createExpressApp>
): Promise<{
    baseUrl: string;
    stop: () => Promise<void>;
}> =>
    new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.on('error', reject);
        server.listen(0, TEST_HOST, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to resolve test server address.'));
                return;
            }
            resolve({
                baseUrl: `http://${TEST_HOST}:${address.port}`,
                stop: async () => {
                    await new Promise<void>((resolveClose, rejectClose) => {
                        server.close((error) => {
                            if (error) {
                                rejectClose(error);
                                return;
                            }
                            resolveClose();
                        });
                    });
                },
            });
        });
    });

test('express shell returns handled API dispatch without entering static fallback', async (t) => {
    let staticCalls = 0;
    const app = createExpressApp({
        dispatchHttpRoute: async ({ normalizedPathname, res }) => {
            if (normalizedPathname === '/api/health') {
                res.statusCode = 200;
                res.end('ok');
                return 'handled';
            }
            return 'fallthrough';
        },
        normalizePathname: (pathname) => pathname,
        trustProxy: false,
        blogReadRateLimitConfig: { limit: 100, windowMs: 60_000 },
        handleIncidentListRequest: async () => undefined,
        handleIncidentReportRequest: async () => undefined,
        handleIncidentStatusRequest: async () => undefined,
        handleIncidentNotesRequest: async () => undefined,
        handleIncidentRemediationRequest: async () => undefined,
        handleIncidentDetailRequest: async () => undefined,
        handleRuntimeConfigRequest: createUnhandledRouteHandler,
        handleChatProfilesRequest: createUnhandledRouteHandler,
        handleBlogIndexRequest: createUnhandledRouteHandler,
        handleBlogPostRequest: createUnhandledBlogPostHandler,
        handleStaticTransportRequest: async ({ res }) => {
            staticCalls += 1;
            res.statusCode = 200;
            res.end('static');
        },
        resolveAsset: async () => undefined,
        mimeMap: new Map<string, string>(),
        frameAncestors: [],
        logRequest: () => undefined,
    });

    const server = await createTestServer(app);
    t.after(async () => {
        await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(staticCalls, 0);
});

test('express shell falls through API dispatch and serves static transport', async (t) => {
    let staticCalls = 0;
    const app = createExpressApp({
        dispatchHttpRoute: async () => 'fallthrough',
        normalizePathname: (pathname) => pathname,
        trustProxy: false,
        blogReadRateLimitConfig: { limit: 100, windowMs: 60_000 },
        handleIncidentListRequest: async () => undefined,
        handleIncidentReportRequest: async () => undefined,
        handleIncidentStatusRequest: async () => undefined,
        handleIncidentNotesRequest: async () => undefined,
        handleIncidentRemediationRequest: async () => undefined,
        handleIncidentDetailRequest: async () => undefined,
        handleRuntimeConfigRequest: createUnhandledRouteHandler,
        handleChatProfilesRequest: createUnhandledRouteHandler,
        handleBlogIndexRequest: createUnhandledRouteHandler,
        handleBlogPostRequest: createUnhandledBlogPostHandler,
        handleStaticTransportRequest: async ({ res }) => {
            staticCalls += 1;
            res.statusCode = 200;
            res.end('static-fallback');
        },
        resolveAsset: async () => undefined,
        mimeMap: new Map<string, string>(),
        frameAncestors: [],
        logRequest: () => undefined,
    });

    const server = await createTestServer(app);
    t.after(async () => {
        await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/api/traces/example`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'static-fallback');
    assert.equal(staticCalls, 1);
});
