/**
 * @description: Integration tests to ensure incidents and audit events are persisted with pseudonymized Discord identifiers (namespaced HMAC) and no raw IDs leak into storage.
 * @footnote-scope: test
 * @footnote-module: IncidentStoreTests
 * @footnote-risk: low - Missing coverage could allow raw IDs to be stored in production.
 * @footnote-ethics: high - Confirms privacy guarantees for incident audit trails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteIncidentStore } from '../src/storage/incidents/sqliteIncidentStore.js';
import { hmacId } from '../src/utils/pseudonymization.js';

const SECRET = 'integration-secret';

test('SqliteIncidentStore pseudonymizes pointers and audit actors', async () => {
    const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'incident-store-')
    );
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({
        dbPath,
        pseudonymizationSecret: SECRET,
    });

    const rawPointers = {
        guildId: '123456789012345678',
        channelId: '234567890123456789',
        messageId: '345678901234567890',
    };

    try {
        const incident = await store.createIncident({
            pointers: rawPointers,
            tags: ['a', 'b'],
            consentedAt: new Date().toISOString(),
        });
        assert.ok(
            incident.pointers.guildId && incident.pointers.guildId.length === 64
        );
        assert.equal(
            incident.pointers.guildId,
            hmacId(SECRET, rawPointers.guildId, 'guild')
        );
        assert.equal(
            incident.pointers.channelId,
            hmacId(SECRET, rawPointers.channelId, 'channel')
        );
        assert.equal(
            incident.pointers.messageId,
            hmacId(SECRET, rawPointers.messageId, 'message')
        );
        const db = new Database(dbPath);
        try {
            const stored = db
                .prepare('SELECT pointers_json FROM incidents WHERE id = ?')
                .get(incident.id) as
                | {
                      pointers_json: string;
                  }
                | undefined;
            assert.ok(
                stored?.pointers_json,
                'Stored incident record should include pointers JSON'
            );
            const parsed = JSON.parse(stored.pointers_json) as Record<
                string,
                unknown
            >;
            const storedJson = JSON.stringify(parsed);

            assert.equal(parsed.guildId, incident.pointers.guildId);
            assert.equal(parsed.channelId, incident.pointers.channelId);
            assert.equal(parsed.messageId, incident.pointers.messageId);
            assert.ok(
                !storedJson.includes(rawPointers.guildId),
                'Raw guild ID should not be stored'
            );
            assert.ok(
                !storedJson.includes(rawPointers.channelId),
                'Raw channel ID should not be stored'
            );
            assert.ok(
                !storedJson.includes(rawPointers.messageId),
                'Raw message ID should not be stored'
            );
        } finally {
            db.close();
        }

        const audit = await store.appendAuditEvent(incident.id, {
            actorHash: '999999999999999999',
            action: 'incident.note_added',
            notes: 'actor id should be hashed',
        });

        assert.equal(
            audit.actorHash,
            hmacId(SECRET, '999999999999999999', 'user')
        );

        const db2 = new Database(dbPath);
        try {
            const storedAudit = db2
                .prepare(
                    'SELECT actor_hash FROM incident_audit_events WHERE id = ?'
                )
                .get(audit.id) as
                | {
                      actor_hash: string | null;
                  }
                | undefined;
            assert.ok(storedAudit, 'Stored audit event should exist');
            assert.equal(storedAudit.actor_hash, audit.actorHash);
            assert.ok(
                !String(storedAudit.actor_hash).includes('999999999999999999'),
                'Raw actor ID should not persist'
            );
        } finally {
            db2.close();
        }
    } finally {
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

test('SqliteIncidentStore rolls back status changes when the audit append fails', async () => {
    const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'incident-store-')
    );
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({
        dbPath,
        pseudonymizationSecret: SECRET,
    });

    try {
        const incident = await store.createIncident({
            consentedAt: new Date().toISOString(),
        });
        const mutableStore = store as unknown as {
            insertAuditEvent: { run: (values: unknown) => unknown };
        };
        const originalInsertAuditEvent = mutableStore.insertAuditEvent;
        mutableStore.insertAuditEvent = {
            run: () => {
                throw new Error('forced audit write failure');
            },
        };

        try {
            await assert.rejects(
                () =>
                    store.updateStatusWithAudit({
                        incidentId: incident.id,
                        status: 'under_review',
                        auditEvent: {
                            actorHash: '999999999999999999',
                            action: 'incident.status_changed',
                            notes: 'reviewing now',
                        },
                    }),
                /forced audit write failure/
            );
        } finally {
            mutableStore.insertAuditEvent = originalInsertAuditEvent;
        }

        const rolledBackIncident = await store.getIncident(incident.id);
        assert.equal(rolledBackIncident?.status, 'new');
        const auditEvents = await store.listAuditEvents(incident.id);
        assert.equal(auditEvents.length, 0);
    } finally {
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

