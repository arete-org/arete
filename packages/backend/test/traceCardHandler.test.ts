/**
 * @description: Covers trace-card API create/read behavior including auth, validation, and asset retrieval.
 * @footnote-scope: test
 * @footnote-module: TraceCardHandlerTests
 * @footnote-risk: medium - Missing coverage could regress trusted-write/public-read behavior for trace-card assets.
 * @footnote-ethics: medium - Trace-card routes directly affect provenance visibility and trust signals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createTraceHandlers } from '../src/handlers/trace.js';
import { SimpleRateLimiter } from '../src/services/rateLimiter.js';
import { SqliteTraceStore } from '../src/storage/traces/sqliteTraceStore.js';

type TestServer = {
    close: () => Promise<void>;
    url: string;
    store: SqliteTraceStore;
    cleanup: () => Promise<void>;
};

const TRACE_TOKEN = 'trace-card-test-token';

const createTestServer = async (): Promise<TestServer> => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-card-api-'));
    const store = new SqliteTraceStore({
        dbPath: path.join(tempRoot, 'provenance.db'),
    });
    const handlers = createTraceHandlers({
        traceStore: store,
        logRequest: () => undefined,
        traceWriteLimiter: new SimpleRateLimiter({ limit: 20, window: 60000 }),
        traceToken: TRACE_TOKEN,
        maxTraceBodyBytes: 20000,
        trustProxy: false,
    });

    const server = http.createServer((req, res) => {
        if (!req.url) {
            res.statusCode = 400;
            res.end();
            return;
        }

        const parsedUrl = new URL(req.url, 'http://localhost');

        if (parsedUrl.pathname === '/api/trace-cards') {
            void handlers.handleTraceCardCreateRequest(req, res);
            return;
        }

        if (parsedUrl.pathname === '/api/trace-cards/from-trace') {
            void handlers.handleTraceCardFromTraceRequest(req, res);
            return;
        }

        if (parsedUrl.pathname.endsWith('/assets/trace-card.svg')) {
            void handlers.handleTraceCardAssetRequest(req, res, parsedUrl);
            return;
        }

        res.statusCode = 404;
        res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    return {
        url: `http://127.0.0.1:${address.port}`,
        store,
        close: () =>
            new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            }),
        cleanup: async () => {
            store.close();
            await fs.rm(tempRoot, { recursive: true, force: true });
        },
    };
};

test('POST /api/trace-cards returns PNG payload and stores SVG asset', async () => {
    const server = await createTestServer();

    try {
        const createResponse = await fetch(`${server.url}/api/trace-cards`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': TRACE_TOKEN,
            },
            body: JSON.stringify({
                responseId: 'trace_card_response_123',
                temperament: {
                    tightness: 9,
                    rationale: 6,
                    attribution: 8,
                    caution: 6,
                    extent: 7,
                },
                chips: {
                    confidencePercent: 82,
                    riskTier: 'Medium',
                    tradeoffCount: 1,
                },
            }),
        });

        assert.equal(createResponse.status, 200);
        const createPayload = (await createResponse.json()) as {
            responseId: string;
            pngBase64: string;
        };

        assert.equal(createPayload.responseId, 'trace_card_response_123');
        assert.ok(createPayload.pngBase64.length > 32);

        const pngBytes = Buffer.from(createPayload.pngBase64, 'base64');
        assert.equal(pngBytes[0], 0x89);
        assert.equal(pngBytes[1], 0x50);
        assert.equal(pngBytes[2], 0x4e);
        assert.equal(pngBytes[3], 0x47);

        const assetResponse = await fetch(
            `${server.url}/api/traces/${encodeURIComponent(createPayload.responseId)}/assets/trace-card.svg`
        );
        assert.equal(assetResponse.status, 200);
        assert.equal(
            assetResponse.headers.get('content-type'),
            'image/svg+xml; charset=utf-8'
        );
        const svg = await assetResponse.text();
        assert.match(svg, /<svg[^>]*>/);
        assert.match(svg, /TRACE card/);
    } finally {
        await server.close();
        await server.cleanup();
    }
});

test('POST /api/trace-cards rejects missing trace token', async () => {
    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/trace-cards`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                temperament: {
                    tightness: 9,
                    rationale: 6,
                    attribution: 8,
                    caution: 6,
                    extent: 7,
                },
            }),
        });

        assert.equal(response.status, 401);
    } finally {
        await server.close();
        await server.cleanup();
    }
});

test('POST /api/trace-cards rejects invalid payloads', async () => {
    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/trace-cards`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': TRACE_TOKEN,
            },
            body: JSON.stringify({
                temperament: {
                    tightness: 11,
                    rationale: 6,
                    attribution: 8,
                    caution: 6,
                    extent: 7,
                },
            }),
        });

        assert.equal(response.status, 400);
    } finally {
        await server.close();
        await server.cleanup();
    }
});

test('GET trace-card SVG returns 404 when asset is missing', async () => {
    const server = await createTestServer();

    try {
        const response = await fetch(
            `${server.url}/api/traces/missing_response/assets/trace-card.svg`
        );
        assert.equal(response.status, 404);
    } finally {
        await server.close();
        await server.cleanup();
    }
});

test('POST /api/trace-cards/from-trace derives chips from stored metadata', async () => {
    const server = await createTestServer();
    const responseId = 'from_trace_response_123';

    try {
        await server.store.upsert({
            responseId,
            provenance: 'Retrieved',
            confidence: 0.91,
            riskTier: 'High',
            tradeoffCount: 3,
            chainHash: 'chain_hash',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
            temperament: {
                tightness: 8,
                rationale: 7,
                attribution: 9,
                caution: 6,
                extent: 8,
            },
        });

        const response = await fetch(`${server.url}/api/trace-cards/from-trace`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': TRACE_TOKEN,
            },
            body: JSON.stringify({ responseId }),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            responseId: string;
            pngBase64: string;
        };
        assert.equal(payload.responseId, responseId);
        assert.ok(payload.pngBase64.length > 32);
    } finally {
        await server.close();
        await server.cleanup();
    }
});

test('POST /api/trace-cards/from-trace returns 409 when temperament is missing', async () => {
    const server = await createTestServer();
    const responseId = 'from_trace_missing_temperament';

    try {
        await server.store.upsert({
            responseId,
            provenance: 'Retrieved',
            confidence: 0.55,
            riskTier: 'Low',
            tradeoffCount: 0,
            chainHash: 'chain_hash',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
        });

        const response = await fetch(`${server.url}/api/trace-cards/from-trace`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': TRACE_TOKEN,
            },
            body: JSON.stringify({ responseId }),
        });

        assert.equal(response.status, 409);
    } finally {
        await server.close();
        await server.cleanup();
    }
});
