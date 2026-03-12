/**
 * @description: Validates SQLite trace storage round trips metadata correctly.
 * @footnote-scope: test
 * @footnote-module: TraceStoreTests
 * @footnote-risk: low - Tests cover trace persistence without affecting production.
 * @footnote-ethics: low - Uses synthetic metadata only.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import { SqliteTraceStore } from '../src/storage/traces/sqliteTraceStore.js';

test('TraceStore round trips metadata with citation URLs', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-store-'));
    const dbPath = path.join(tempRoot, 'provenance.db');
    const store = new SqliteTraceStore({ dbPath });

    const metadata: ResponseMetadata = {
        responseId: 'response_123',
        provenance: 'Retrieved',
        riskTier: 'Low',
        tradeoffCount: 2,
        chainHash: 'abc123',
        licenseContext: 'MIT',
        modelVersion: 'gpt-4.1-mini',
        staleAfter: new Date().toISOString(),
        citations: [
            {
                title: 'Example Source',
                url: 'https://example.com/article',
                snippet: 'Example snippet',
            },
            {
                title: 'String URL source',
                url: 'https://example.com/string',
            },
        ],
    };

    try {
        await store.upsert(metadata);

        const retrieved = await store.retrieve(metadata.responseId);
        assert.ok(retrieved, 'retrieve should return stored metadata');
        assert.equal(retrieved.responseId, metadata.responseId);
        assert.equal(retrieved.chainHash, metadata.chainHash);
        assert.equal(
            retrieved.citations[0].url,
            metadata.citations[0].url,
            'citation URL should round-trip as a string'
        );
        assert.equal(
            retrieved.citations[1].url,
            'https://example.com/string',
            'string citation should normalize to canonical URL string'
        );

        await store.delete(metadata.responseId);
        const deleted = await store.retrieve(metadata.responseId);
        assert.equal(deleted, null, 'deleted trace should not be retrievable');
    } finally {
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

test('TraceStore round trips trace-card SVG assets', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-card-'));
    const dbPath = path.join(tempRoot, 'provenance.db');
    const store = new SqliteTraceStore({ dbPath });
    const responseId = 'response_trace_card_123';
    const initialSvg = '<svg><title>initial</title></svg>';
    const updatedSvg = '<svg><title>updated</title></svg>';

    try {
        const beforeInsert = await store.getTraceCardSvg(responseId);
        assert.equal(
            beforeInsert,
            null,
            'missing trace-card should return null'
        );

        // A trace-card row references provenance_traces(response_id), so seed the
        // parent trace first before inserting the card asset.
        await store.upsert({
            responseId,
            provenance: 'Retrieved',
            riskTier: 'Low',
            tradeoffCount: 1,
            chainHash: 'trace_card_chain_hash',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
        });

        await store.upsertTraceCardSvg(responseId, initialSvg);
        const storedInitial = await store.getTraceCardSvg(responseId);
        assert.equal(storedInitial, initialSvg);

        await store.upsertTraceCardSvg(responseId, updatedSvg);
        const storedUpdated = await store.getTraceCardSvg(responseId);
        assert.equal(
            storedUpdated,
            updatedSvg,
            'upsert should replace existing SVG'
        );
    } finally {
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

test('TraceStore delete removes both trace metadata and trace-card SVG', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-delete-'));
    const dbPath = path.join(tempRoot, 'provenance.db');
    const store = new SqliteTraceStore({ dbPath });
    const responseId = 'delete_trace_card_123';

    try {
        await store.upsert({
            responseId,
            provenance: 'Retrieved',
            riskTier: 'Low',
            tradeoffCount: 1,
            chainHash: 'chain_hash',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
        });
        await store.upsertTraceCardSvg(responseId, '<svg>trace-card</svg>');

        await store.delete(responseId);

        const trace = await store.retrieve(responseId);
        const traceCardSvg = await store.getTraceCardSvg(responseId);
        assert.equal(trace, null, 'trace metadata should be deleted');
        assert.equal(traceCardSvg, null, 'trace-card SVG should be deleted');
    } finally {
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});
