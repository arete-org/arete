/**
 * @description: Verifies Express-owned route boundaries for standard, internal, and trace write/card HTTP surfaces.
 * Confirms special transport dispatch remains explicit for Accept-negotiated trace reads.
 * @footnote-scope: test
 * @footnote-module: ExpressRouteOwnershipTests
 * @footnote-risk: medium - Missing ownership tests can hide route-composition regressions at transport boundaries.
 * @footnote-ethics: low - Route ownership checks do not alter policy or user data semantics.
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

test('chat route is Express-owned and bypasses central dispatch', async (t) => {
    const dispatchCalls: string[] = [];
    let chatCalls = 0;

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
            res.statusCode = 200;
            res.end('incident-list');
        },
        handleIncidentReportRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-report');
        },
        handleIncidentStatusRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-status');
        },
        handleIncidentNotesRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-notes');
        },
        handleIncidentRemediationRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-remediation');
        },
        handleIncidentDetailRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-detail');
        },
        handleChatRequest: async (_req, res) => {
            chatCalls += 1;
            res.statusCode = 200;
            res.end('chat');
        },
        handleInternalTextRequest: createUnhandledRouteHandler,
        handleInternalImageRequest: createUnhandledRouteHandler,
        handleInternalVoiceTtsRequest: createUnhandledRouteHandler,
        handleTraceUpsertRequest: createUnhandledRouteHandler,
        handleTraceCardCreateRequest: createUnhandledRouteHandler,
        handleTraceCardFromTraceRequest: createUnhandledRouteHandler,
        handleTraceCardAssetRequest: async (req, res) =>
            createUnhandledRouteHandler(req, res),
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

    const chatResponse = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
    });
    assert.equal(chatResponse.status, 200);
    assert.equal(await chatResponse.text(), 'chat');
    assert.equal(chatCalls, 1);
    assert.equal(dispatchCalls.includes('/api/chat'), false);

    const unrelatedApiResponse = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(unrelatedApiResponse.status, 404);
    assert.equal(dispatchCalls.includes('/api/health'), true);
});

test('internal HTTP routes are Express-owned and bypass central dispatch', async (t) => {
    const dispatchCalls: string[] = [];
    const internalCalls: string[] = [];

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
            res.statusCode = 200;
            res.end('incident-list');
        },
        handleIncidentReportRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-report');
        },
        handleIncidentStatusRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-status');
        },
        handleIncidentNotesRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-notes');
        },
        handleIncidentRemediationRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-remediation');
        },
        handleIncidentDetailRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-detail');
        },
        handleChatRequest: createUnhandledRouteHandler,
        handleInternalTextRequest: async (_req, res) => {
            internalCalls.push('/api/internal/text');
            res.statusCode = 200;
            res.end('internal-text');
        },
        handleInternalImageRequest: async (_req, res) => {
            internalCalls.push('/api/internal/image');
            res.statusCode = 200;
            res.end('internal-image');
        },
        handleInternalVoiceTtsRequest: async (_req, res) => {
            internalCalls.push('/api/internal/voice/tts');
            res.statusCode = 200;
            res.end('internal-voice-tts');
        },
        handleTraceUpsertRequest: createUnhandledRouteHandler,
        handleTraceCardCreateRequest: createUnhandledRouteHandler,
        handleTraceCardFromTraceRequest: createUnhandledRouteHandler,
        handleTraceCardAssetRequest: async (req, res) =>
            createUnhandledRouteHandler(req, res),
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

    const textResponse = await fetch(`${server.baseUrl}/api/internal/text`, {
        method: 'POST',
    });
    assert.equal(textResponse.status, 200);
    assert.equal(await textResponse.text(), 'internal-text');

    const imageResponse = await fetch(`${server.baseUrl}/api/internal/image`, {
        method: 'POST',
    });
    assert.equal(imageResponse.status, 200);
    assert.equal(await imageResponse.text(), 'internal-image');

    const ttsResponse = await fetch(
        `${server.baseUrl}/api/internal/voice/tts`,
        {
            method: 'POST',
        }
    );
    assert.equal(ttsResponse.status, 200);
    assert.equal(await ttsResponse.text(), 'internal-voice-tts');

    assert.deepEqual(internalCalls, [
        '/api/internal/text',
        '/api/internal/image',
        '/api/internal/voice/tts',
    ]);
    assert.equal(dispatchCalls.includes('/api/internal/text'), false);
    assert.equal(dispatchCalls.includes('/api/internal/image'), false);
    assert.equal(dispatchCalls.includes('/api/internal/voice/tts'), false);

    const unrelatedApiResponse = await fetch(
        `${server.baseUrl}/api/internal/voice/realtime`
    );
    assert.equal(unrelatedApiResponse.status, 404);
    assert.equal(dispatchCalls.includes('/api/internal/voice/realtime'), true);
});

test('trace write/card route is Express-owned while Accept-negotiated trace read stays in special transport dispatch', async (t) => {
    const dispatchCalls: string[] = [];
    const traceCalls: string[] = [];

    const app = createExpressApp({
        dispatchHttpRoute: async ({ normalizedPathname, res }) => {
            dispatchCalls.push(normalizedPathname);
            if (normalizedPathname.startsWith('/api/traces/')) {
                res.statusCode = 208;
                res.end('trace-special-dispatch');
                return 'handled';
            }
            return 'fallthrough';
        },
        normalizePathname: (pathname) =>
            pathname.length > 1 && pathname.endsWith('/')
                ? pathname.slice(0, -1)
                : pathname,
        trustProxy: false,
        blogReadRateLimitConfig: { limit: 100, windowMs: 60_000 },
        handleIncidentListRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-list');
        },
        handleIncidentReportRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-report');
        },
        handleIncidentStatusRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-status');
        },
        handleIncidentNotesRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-notes');
        },
        handleIncidentRemediationRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-remediation');
        },
        handleIncidentDetailRequest: async (_req, res) => {
            res.statusCode = 200;
            res.end('incident-detail');
        },
        handleChatRequest: createUnhandledRouteHandler,
        handleInternalTextRequest: createUnhandledRouteHandler,
        handleInternalImageRequest: createUnhandledRouteHandler,
        handleInternalVoiceTtsRequest: createUnhandledRouteHandler,
        handleTraceUpsertRequest: async (_req, res) => {
            traceCalls.push('/api/traces');
            res.statusCode = 200;
            res.end('trace-upsert');
        },
        handleTraceCardCreateRequest: async (_req, res) => {
            traceCalls.push('/api/trace-cards');
            res.statusCode = 200;
            res.end('trace-card-create');
        },
        handleTraceCardFromTraceRequest: async (_req, res) => {
            traceCalls.push('/api/trace-cards/from-trace');
            res.statusCode = 200;
            res.end('trace-card-from-trace');
        },
        handleTraceCardAssetRequest: async (_req, res) => {
            traceCalls.push('/api/traces/:id/assets/trace-card.svg');
            res.statusCode = 200;
            res.end('trace-card-asset');
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

    const tracesResponse = await fetch(`${server.baseUrl}/api/traces`, {
        method: 'POST',
    });
    assert.equal(tracesResponse.status, 200);
    assert.equal(await tracesResponse.text(), 'trace-upsert');

    const traceCardResponse = await fetch(`${server.baseUrl}/api/trace-cards`, {
        method: 'POST',
    });
    assert.equal(traceCardResponse.status, 200);
    assert.equal(await traceCardResponse.text(), 'trace-card-create');

    const fromTraceResponse = await fetch(
        `${server.baseUrl}/api/trace-cards/from-trace`,
        {
            method: 'POST',
        }
    );
    assert.equal(fromTraceResponse.status, 200);
    assert.equal(await fromTraceResponse.text(), 'trace-card-from-trace');

    const traceAssetResponse = await fetch(
        `${server.baseUrl}/api/traces/trace_123/assets/trace-card.svg`
    );
    assert.equal(traceAssetResponse.status, 200);
    assert.equal(await traceAssetResponse.text(), 'trace-card-asset');

    const traceDetailResponse = await fetch(
        `${server.baseUrl}/api/traces/trace_123`,
        {
            headers: {
                Accept: 'application/json',
            },
        }
    );
    assert.equal(traceDetailResponse.status, 208);
    assert.equal(await traceDetailResponse.text(), 'trace-special-dispatch');

    assert.deepEqual(traceCalls, [
        '/api/traces',
        '/api/trace-cards',
        '/api/trace-cards/from-trace',
        '/api/traces/:id/assets/trace-card.svg',
    ]);
    assert.equal(dispatchCalls.includes('/api/traces'), false);
    assert.equal(dispatchCalls.includes('/api/trace-cards'), false);
    assert.equal(dispatchCalls.includes('/api/trace-cards/from-trace'), false);
    assert.equal(
        dispatchCalls.includes('/api/traces/trace_123/assets/trace-card.svg'),
        false
    );
    assert.equal(dispatchCalls.includes('/api/traces/trace_123'), true);
});
