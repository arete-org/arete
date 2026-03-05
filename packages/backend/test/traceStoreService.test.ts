/**
 * @description: Verifies trace service persistence behavior, including optional trace-card writes.
 * @footnote-scope: test
 * @footnote-module: TraceStoreServiceTests
 * @footnote-risk: medium - Missing coverage could regress fail-open behavior for optional trace-card storage.
 * @footnote-ethics: medium - Ensures provenance persistence remains resilient even when rendering/storage fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseMetadata } from '@footnote/contracts/ethics-core';
import type { TraceStore } from '../src/storage/traces/traceStore.js';
import { storeTrace } from '../src/services/traceStore.js';

const createMetadata = (
    overrides: Partial<ResponseMetadata> = {}
): ResponseMetadata => ({
    responseId: 'trace_service_response_123',
    provenance: 'Retrieved',
    confidence: 0.8,
    riskTier: 'Low',
    tradeoffCount: 1,
    chainHash: 'chain_hash',
    licenseContext: 'MIT + HL3',
    modelVersion: 'gpt-5-mini',
    staleAfter: new Date(Date.now() + 60000).toISOString(),
    citations: [],
    ...overrides,
});

test('storeTrace writes metadata and skips trace-card SVG auto-generation', async () => {
    let upsertCalled = false;
    let traceCardCalled = false;

    const traceStore = {
        upsert: async () => {
            upsertCalled = true;
        },
        upsertTraceCardSvg: async () => {
            traceCardCalled = true;
        },
    } as unknown as TraceStore;

    await storeTrace(
        traceStore,
        createMetadata({
            temperament: {
                tightness: 9,
                rationale: 6,
                attribution: 8,
                caution: 6,
                extent: 7,
            },
        })
    );

    assert.equal(upsertCalled, true);
    assert.equal(traceCardCalled, false);
});

test('storeTrace skips trace-card write when temperament is missing', async () => {
    let traceCardCalled = false;

    const traceStore = {
        upsert: async () => undefined,
        upsertTraceCardSvg: async () => {
            traceCardCalled = true;
        },
    } as unknown as TraceStore;

    await storeTrace(traceStore, createMetadata());

    assert.equal(traceCardCalled, false);
});

test('storeTrace stays fail-open when trace upsert throws', async () => {
    let upsertCalled = false;

    const traceStore = {
        upsert: async () => {
            upsertCalled = true;
            throw new Error('trace upsert failed');
        },
        upsertTraceCardSvg: async () => {
            throw new Error('trace-card write failed');
        },
    } as unknown as TraceStore;

    await assert.doesNotReject(
        storeTrace(
            traceStore,
            createMetadata({
                temperament: {
                    tightness: 9,
                    rationale: 6,
                    attribution: 8,
                    caution: 6,
                    extent: 7,
                },
            })
        )
    );
    assert.equal(upsertCalled, true);
});
