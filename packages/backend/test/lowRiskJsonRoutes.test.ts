/**
 * @description: Verifies low-risk JSON routes are handled by Express routers with legacy behavior parity.
 * Protects config, chat profile listing, and blog route matching from dispatch-order regressions.
 * @footnote-scope: test
 * @footnote-module: LowRiskJsonRoutesTests
 * @footnote-risk: medium - Missing tests can let route grouping drift and silently change endpoint behavior.
 * @footnote-ethics: low - Route-composition assertions do not involve policy or human-impact decisions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createExpressApp } from '../src/http/expressApp.js';

const TEST_HOST = '127.0.0.1';

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

test('low-risk JSON routes bypass legacy /api dispatch while preserving low-risk route ownership', async (t) => {
    const handledPaths: string[] = [];
    const dispatchCalls: string[] = [];

    const app = createExpressApp({
        dispatchHttpRoute: async ({ normalizedPathname }) => {
            dispatchCalls.push(normalizedPathname);
            return 'fallthrough';
        },
        normalizePathname: (pathname) =>
            pathname.length > 1 && pathname.endsWith('/')
                ? pathname.slice(0, -1)
                : pathname,
        trustProxy: false,
        blogReadRateLimitConfig: { limit: 100, windowMs: 60_000 },
        handleIncidentListRequest: async () => undefined,
        handleIncidentReportRequest: async () => undefined,
        handleIncidentStatusRequest: async () => undefined,
        handleIncidentNotesRequest: async () => undefined,
        handleIncidentRemediationRequest: async () => undefined,
        handleIncidentDetailRequest: async () => undefined,
        handleRuntimeConfigRequest: async (_req, res) => {
            handledPaths.push('/config.json');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
        },
        handleChatProfilesRequest: async (_req, res) => {
            handledPaths.push('/api/chat/profiles');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ profiles: [] }));
        },
        handleBlogIndexRequest: async (_req, res) => {
            handledPaths.push('/api/blog-posts');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify([]));
        },
        handleBlogPostRequest: async (_req, res, postId) => {
            handledPaths.push(`/api/blog-posts/${postId}`);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ id: postId }));
        },
        handleStaticTransportRequest: async ({ res }) => {
            res.statusCode = 404;
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

    const configResponse = await fetch(`${server.baseUrl}/config.json`);
    assert.equal(configResponse.status, 200);

    const chatProfilesResponse = await fetch(
        `${server.baseUrl}/api/chat/profiles`
    );
    assert.equal(chatProfilesResponse.status, 200);

    const blogIndexResponse = await fetch(`${server.baseUrl}/api/blog-posts/`);
    assert.equal(blogIndexResponse.status, 200);

    const blogPostResponse = await fetch(
        `${server.baseUrl}/api/blog-posts/100/extra`
    );
    assert.equal(blogPostResponse.status, 404);

    const healthResponse = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(healthResponse.status, 404);

    assert.deepEqual(handledPaths, [
        '/config.json',
        '/api/chat/profiles',
        '/api/blog-posts',
    ]);
    assert.deepEqual(dispatchCalls, [
        '/api/blog-posts/100/extra',
        '/api/health',
    ]);
});
