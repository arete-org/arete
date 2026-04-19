/**
 * @description: Verifies incident routes are owned by the Express shell with explicit precedence.
 * Confirms report/sub-route/detail matching bypasses legacy /api dispatch when routes are recognized.
 * @footnote-scope: test
 * @footnote-module: IncidentRoutesTests
 * @footnote-risk: medium - Missing route-order tests can silently reroute incident traffic to wrong handlers.
 * @footnote-ethics: high - Incident route mismatches can affect sensitive report and review workflows.
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

test('incident routes are handled in Express with explicit precedence and no legacy dispatch handoff', async (t) => {
    const dispatchCalls: string[] = [];
    const incidentCalls: string[] = [];

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
        handleIncidentListRequest: async (_req, res) => {
            incidentCalls.push('/api/incidents');
            res.statusCode = 200;
            res.end('list');
        },
        handleIncidentReportRequest: async (_req, res) => {
            incidentCalls.push('/api/incidents/report');
            res.statusCode = 200;
            res.end('report');
        },
        handleIncidentStatusRequest: async (_req, res, parsedUrl) => {
            incidentCalls.push(parsedUrl.pathname);
            res.statusCode = 200;
            res.end('status');
        },
        handleIncidentNotesRequest: async (_req, res, parsedUrl) => {
            incidentCalls.push(parsedUrl.pathname);
            res.statusCode = 200;
            res.end('notes');
        },
        handleIncidentRemediationRequest: async (_req, res, parsedUrl) => {
            incidentCalls.push(parsedUrl.pathname);
            res.statusCode = 200;
            res.end('remediation');
        },
        handleIncidentDetailRequest: async (_req, res, parsedUrl) => {
            incidentCalls.push(parsedUrl.pathname);
            res.statusCode = 200;
            res.end('detail');
        },
        handleRuntimeConfigRequest: createUnhandledRouteHandler,
        handleChatProfilesRequest: createUnhandledRouteHandler,
        handleBlogIndexRequest: createUnhandledRouteHandler,
        handleBlogPostRequest: createUnhandledBlogPostHandler,
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

    const listResponse = await fetch(`${server.baseUrl}/api/incidents`);
    assert.equal(listResponse.status, 200);
    assert.equal(await listResponse.text(), 'list');

    const reportResponse = await fetch(
        `${server.baseUrl}/api/incidents/report`
    );
    assert.equal(reportResponse.status, 200);
    assert.equal(await reportResponse.text(), 'report');

    const detailResponse = await fetch(
        `${server.baseUrl}/api/incidents/incident-123`
    );
    assert.equal(detailResponse.status, 200);
    assert.equal(await detailResponse.text(), 'detail');

    const statusResponse = await fetch(
        `${server.baseUrl}/api/incidents/incident-123/status`
    );
    assert.equal(statusResponse.status, 200);
    assert.equal(await statusResponse.text(), 'status');

    const notesResponse = await fetch(
        `${server.baseUrl}/api/incidents/incident-123/notes`
    );
    assert.equal(notesResponse.status, 200);
    assert.equal(await notesResponse.text(), 'notes');

    const remediationResponse = await fetch(
        `${server.baseUrl}/api/incidents/incident-123/remediation`
    );
    assert.equal(remediationResponse.status, 200);
    assert.equal(await remediationResponse.text(), 'remediation');

    const fallthroughResponse = await fetch(
        `${server.baseUrl}/api/incidents/incident-123/unknown`
    );
    assert.equal(fallthroughResponse.status, 404);
    assert.equal(await fallthroughResponse.text(), 'static');

    assert.deepEqual(incidentCalls, [
        '/api/incidents',
        '/api/incidents/report',
        '/api/incidents/incident-123',
        '/api/incidents/incident-123/status',
        '/api/incidents/incident-123/notes',
        '/api/incidents/incident-123/remediation',
    ]);
    assert.deepEqual(dispatchCalls, ['/api/incidents/incident-123/unknown']);
});
