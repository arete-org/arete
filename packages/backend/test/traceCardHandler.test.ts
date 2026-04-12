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
    const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'trace-card-api-')
    );
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

    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
    );
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
                    tightness: 5,
                    rationale: 3,
                    attribution: 4,
                    caution: 3,
                    extent: 4,
                },
                chips: {
                    evidenceScore: 4,
                    freshnessScore: 5,
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
                    tightness: 5,
                    rationale: 3,
                    attribution: 4,
                    caution: 3,
                    extent: 4,
                },
            }),
        });

        assert.equal(response.status, 401);
    } finally {
        await server.close();
        await server.cleanup();
    }
});

test('POST /api/trace-cards accepts minimal payload and returns PNG', async () => {
    const server = await createTestServer();

    try {
        const response = await fetch(`${server.url}/api/trace-cards`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': TRACE_TOKEN,
            },
            body: JSON.stringify({
                responseId: 'trace_card_minimal_123',
            }),
        });

        assert.equal(response.status, 200);
        const payload = (await response.json()) as {
            responseId: string;
            pngBase64: string;
        };
        assert.equal(payload.responseId, 'trace_card_minimal_123');
        assert.ok(payload.pngBase64.length > 32);
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
                    tightness: 5,
                    rationale: 3,
                    attribution: 4,
                    caution: 3,
                    extent: 4,
                },
                chips: {
                    evidenceScore: 6,
                    freshnessScore: 4,
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

test('POST /api/trace-cards/from-trace uses stored metadata trace_final and chip scores', async () => {
    const server = await createTestServer();
    const responseId = 'from_trace_response_123';

    try {
        await server.store.upsert({
            responseId,
            provenance: 'Retrieved',
            safetyTier: 'High',
            tradeoffCount: 3,
            chainHash: 'chain_hash',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
            trace_target: {
                tightness: 4,
                rationale: 3,
                attribution: 5,
                caution: 2,
                extent: 4,
            },
            trace_final: {
                tightness: 4,
                rationale: 3,
                attribution: 5,
                caution: 2,
                extent: 4,
            },
            evidenceScore: 4,
            freshnessScore: 3,
        });

        const response = await fetch(
            `${server.url}/api/trace-cards/from-trace`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': TRACE_TOKEN,
                },
                body: JSON.stringify({
                    responseId,
                }),
            }
        );

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

test('POST /api/trace-cards/from-trace renders successfully when stored chip scores are missing', async () => {
    const server = await createTestServer();
    const responseId = 'from_trace_missing_scores';

    try {
        await server.store.upsert({
            responseId,
            provenance: 'Retrieved',
            safetyTier: 'Medium',
            tradeoffCount: 2,
            chainHash: 'chain_hash',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
            trace_target: {
                tightness: 4,
                rationale: 3,
                attribution: 5,
                caution: 2,
                extent: 4,
            },
            trace_final: {
                tightness: 4,
                rationale: 3,
                attribution: 5,
                caution: 2,
                extent: 4,
            },
        });

        const response = await fetch(
            `${server.url}/api/trace-cards/from-trace`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': TRACE_TOKEN,
                },
                body: JSON.stringify({ responseId }),
            }
        );

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

test('POST /api/trace-cards/from-trace renders successfully when stored trace_final is empty', async () => {
    const server = await createTestServer();
    const responseId = 'from_trace_missing_trace_final';

    try {
        await server.store.upsert({
            responseId,
            provenance: 'Retrieved',
            safetyTier: 'Low',
            tradeoffCount: 0,
            chainHash: 'chain_hash',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
            trace_target: {},
            trace_final: {},
        });

        const response = await fetch(
            `${server.url}/api/trace-cards/from-trace`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Trace-Token': TRACE_TOKEN,
                },
                body: JSON.stringify({
                    responseId,
                }),
            }
        );

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
