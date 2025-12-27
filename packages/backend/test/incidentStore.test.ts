/**
 * @arete-module: IncidentStoreTests
 * @arete-risk: low
 * @arete-ethics: high
 * @arete-scope: test
 *
 * @description: Integration tests to ensure incidents and audit events are persisted with
 * pseudonymized Discord identifiers (namespaced HMAC) and no raw IDs leak into
 * storage.
 *
 * @impact
 * Risk: Missing coverage could allow raw IDs to be stored in production.
 * Ethics: Confirms privacy guarantees for incident audit trails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteIncidentStore } from '../src/shared/sqliteIncidentStore';
import { hmacId } from '../src/shared/pseudonymization';

const SECRET = 'integration-secret';

test('SqliteIncidentStore pseudonymizes pointers and audit actors', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-store-'));
  const dbPath = path.join(tempRoot, 'incidents.db');
  const store = new SqliteIncidentStore({ dbPath, pseudonymizationSecret: SECRET });

  const rawPointers = {
    guildId: '123456789012345678',
    channelId: '234567890123456789',
    messageId: '345678901234567890',
    traceId: 'trace-123'
  };

  try {
    const incident = await store.createIncident({ pointers: rawPointers, tags: ['a', 'b'] });
    assert.ok(incident.pointers.guildId && incident.pointers.guildId.length === 64);
    assert.equal(incident.pointers.guildId, hmacId(SECRET, rawPointers.guildId, 'guild'));
    assert.equal(incident.pointers.channelId, hmacId(SECRET, rawPointers.channelId, 'channel'));
    assert.equal(incident.pointers.messageId, hmacId(SECRET, rawPointers.messageId, 'message'));
    assert.equal(incident.pointers.traceId, rawPointers.traceId);

    const db = new Database(dbPath);
    try {
      const stored = db.prepare('SELECT pointers_json FROM incidents WHERE id = ?').get(incident.id) as {
        pointers_json: string;
      } | undefined;
      assert.ok(stored?.pointers_json, 'Stored incident record should include pointers JSON');
      const parsed = JSON.parse(stored.pointers_json) as Record<string, unknown>;
      const storedJson = JSON.stringify(parsed);

      assert.equal(parsed.guildId, incident.pointers.guildId);
      assert.equal(parsed.channelId, incident.pointers.channelId);
      assert.equal(parsed.messageId, incident.pointers.messageId);
      assert.ok(!storedJson.includes(rawPointers.guildId), 'Raw guild ID should not be stored');
      assert.ok(!storedJson.includes(rawPointers.channelId), 'Raw channel ID should not be stored');
      assert.ok(!storedJson.includes(rawPointers.messageId), 'Raw message ID should not be stored');
    } finally {
      db.close();
    }

    const audit = await store.appendAuditEvent(incident.id, {
      actorHash: '999999999999999999',
      action: 'test-action',
      notes: 'actor id should be hashed'
    });

    assert.equal(audit.actorHash, hmacId(SECRET, '999999999999999999', 'user'));

    const db2 = new Database(dbPath);
    try {
      const storedAudit = db2.prepare('SELECT actor_hash FROM incident_audit_events WHERE id = ?').get(audit.id) as {
        actor_hash: string | null;
      } | undefined;
      assert.ok(storedAudit, 'Stored audit event should exist');
      assert.equal(storedAudit.actor_hash, audit.actorHash);
      assert.ok(!String(storedAudit.actor_hash).includes('999999999999999999'), 'Raw actor ID should not persist');
    } finally {
      db2.close();
    }
  } finally {
    store.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
