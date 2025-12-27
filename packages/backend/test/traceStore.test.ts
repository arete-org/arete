/**
 * @description: Validates SQLite trace storage round trips metadata correctly.
 * @arete-scope: test
 * @arete-module: TraceStoreTests
 * @arete-risk: low - Tests cover trace persistence without affecting production.
 * @arete-ethics: low - Uses synthetic metadata only.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteTraceStore } from '../src/shared/sqliteTraceStore';
import type { ResponseMetadata } from '../src/ethics-core';

test('TraceStore round trips metadata with citation URLs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-store-'));
  const dbPath = path.join(tempRoot, 'provenance.db');
  const store = new SqliteTraceStore({ dbPath });

  const metadata: ResponseMetadata = {
    responseId: 'response_123',
    provenance: 'Retrieved',
    confidence: 0.85,
    riskTier: 'Low',
    tradeoffCount: 2,
    chainHash: 'abc123',
    licenseContext: 'MIT',
    modelVersion: 'gpt-4.1-mini',
    staleAfter: new Date().toISOString(),
    citations: [
      {
        title: 'Example Source',
        url: new URL('https://example.com/article'),
        snippet: 'Example snippet'
      },
      {
        title: 'String URL source',
        // Cast through unknown so the runtime value stays a string and exercises normalization.
        url: 'https://example.com/string' as unknown as URL
      }
    ]
  };

  try {
    await store.upsert(metadata);

    const retrieved = await store.retrieve(metadata.responseId);
    assert.ok(retrieved, 'retrieve should return stored metadata');
    assert.equal(retrieved.responseId, metadata.responseId);
    assert.equal(retrieved.chainHash, metadata.chainHash);
    assert.ok(retrieved.citations[0].url instanceof URL, 'citation URL should revive to URL instance');
    assert.equal(retrieved.citations[0].url.href, metadata.citations[0].url.href, 'revived URL should match original');
    assert.ok(retrieved.citations[1].url instanceof URL, 'string citation URL should normalize and revive to URL');
    assert.equal(
      retrieved.citations[1].url.href,
      new URL('https://example.com/string').href,
      'string citation should normalize to canonical URL'
    );

    await store.delete(metadata.responseId);
    const deleted = await store.retrieve(metadata.responseId);
    assert.equal(deleted, null, 'deleted trace should not be retrievable');
  } finally {
    store.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
