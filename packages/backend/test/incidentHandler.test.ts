/**
 * @description: Validates trusted incident API auth and the end-to-end report/review lifecycle against SQLite-backed storage.
 * @footnote-scope: test
 * @footnote-module: IncidentHandlerTests
 * @footnote-risk: medium - Missing tests could let report persistence or admin updates regress silently.
 * @footnote-ethics: high - Confirms privacy guarantees and review-state correctness for incident workflows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';

import { createIncidentHandlers } from '../src/handlers/incidents.js';
import { createIncidentService } from '../src/services/incidents.js';
import { SqliteIncidentStore } from '../src/storage/incidents/sqliteIncidentStore.js';

type TestServer = {
    url: string;
    close: () => Promise<void>;
};

const SECRET = 'incident-handler-secret';

const createIncidentServer = async (
    store: SqliteIncidentStore,
    tokens: { traceApiToken: string | null; serviceToken: string | null }
): Promise<TestServer> => {
    const incidentService = createIncidentService({ incidentStore: store });
    const handlers = createIncidentHandlers({
        incidentService,
        logRequest: () => undefined,
        maxIncidentBodyBytes: 50_000,
        traceApiToken: tokens.traceApiToken,
        serviceToken: tokens.serviceToken,
    });

    const server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url ?? '/', 'http://localhost');

        if (parsedUrl.pathname === '/api/incidents/report') {
            void handlers.handleIncidentReportRequest(req, res);
            return;
        }
        if (parsedUrl.pathname === '/api/incidents') {
            void handlers.handleIncidentListRequest(req, res, parsedUrl);
            return;
        }
        if (/^\/api\/incidents\/[^/]+\/status\/?$/.test(parsedUrl.pathname)) {
            void handlers.handleIncidentStatusRequest(req, res, parsedUrl);
            return;
        }
        if (/^\/api\/incidents\/[^/]+\/notes\/?$/.test(parsedUrl.pathname)) {
            void handlers.handleIncidentNotesRequest(req, res, parsedUrl);
            return;
        }
        if (/^\/api\/incidents\/[^/]+\/remediation\/?$/.test(parsedUrl.pathname)) {
            void handlers.handleIncidentRemediationRequest(req, res, parsedUrl);
            return;
        }
        if (/^\/api\/incidents\/[^/]+\/?$/.test(parsedUrl.pathname)) {
            void handlers.handleIncidentDetailRequest(req, res, parsedUrl);
            return;
        }

        res.statusCode = 404;
        res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');

    return {
        url: `http://127.0.0.1:${address.port}`,
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
    };
};

test('incident report/list/detail flow stores pseudonymized pointers and omits jump URLs', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-api-'));
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({
        dbPath,
        pseudonymizationSecret: SECRET,
    });
    const server = await createIncidentServer(store, {
        traceApiToken: 'trace-secret',
        serviceToken: null,
    });

    try {
        const reportResponse = await fetch(`${server.url}/api/incidents/report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Trace-Token': 'trace-secret',
            },
            body: JSON.stringify({
                reporterUserId: '123456789012345678',
                guildId: '234567890123456789',
                channelId: '345678901234567890',
                messageId: '456789012345678901',
                jumpUrl: 'https://discord.com/channels/234/345/456',
                responseId: 'response_123',
                chainHash: 'hash_abc',
                modelVersion: 'gpt-5-mini',
                tags: ['safety'],
                description: 'Please review this reply',
                contact: 'contact@example.com',
                consentedAt: new Date().toISOString(),
            }),
        });

        assert.equal(reportResponse.status, 200);
        const reportPayload = (await reportResponse.json()) as {
            incident: { incidentId: string; remediation: { state: string } };
            remediation: { state: string };
        };
        assert.equal(reportPayload.remediation.state, 'pending');
        assert.equal(reportPayload.incident.remediation.state, 'pending');

        const incidentId = reportPayload.incident.incidentId;
        const listResponse = await fetch(
            `${server.url}/api/incidents?status=new&tag=safety`,
            {
                headers: {
                    'X-Trace-Token': 'trace-secret',
                },
            }
        );
        assert.equal(listResponse.status, 200);
        const listPayload = (await listResponse.json()) as {
            incidents: Array<{ incidentId: string }>;
        };
        assert.equal(listPayload.incidents[0]?.incidentId, incidentId);

        const detailResponse = await fetch(
            `${server.url}/api/incidents/${incidentId}`,
            {
                headers: {
                    'X-Trace-Token': 'trace-secret',
                },
            }
        );
        assert.equal(detailResponse.status, 200);
        const detailPayload = (await detailResponse.json()) as {
            incident: {
                pointers: Record<string, string>;
                auditEvents: Array<{ action: string }>;
            };
        };
        assert.equal(detailPayload.incident.auditEvents[0]?.action, 'incident.created');
        assert.equal(detailPayload.incident.pointers.responseId, 'response_123');
        assert.equal(detailPayload.incident.pointers.guildId.length, 64);

        const db = new Database(dbPath);
        try {
            const storedIncident = db
                .prepare(
                    'SELECT reporter_hash, pointers_json, description, contact FROM incidents LIMIT 1'
                )
                .get() as
                | {
                      reporter_hash: string | null;
                      pointers_json: string;
                      description: string | null;
                      contact: string | null;
                  }
                | undefined;
            assert.ok(storedIncident);
            assert.equal(storedIncident?.description, 'Please review this reply');
            assert.equal(storedIncident?.contact, 'contact@example.com');
            assert.equal(storedIncident?.reporter_hash?.length, 64);
            const storedPointers = JSON.parse(storedIncident.pointers_json) as {
                responseId?: string;
                guildId?: string;
                channelId?: string;
                messageId?: string;
                jumpUrl?: string;
            };
            assert.deepEqual(Object.keys(storedPointers).sort(), [
                'chainHash',
                'channelId',
                'guildId',
                'messageId',
                'modelVersion',
                'responseId',
            ]);
            assert.notEqual(storedPointers.guildId, '234567890123456789');
            assert.notEqual(storedPointers.channelId, '345678901234567890');
            assert.notEqual(storedPointers.messageId, '456789012345678901');
            assert.equal('jumpUrl' in storedPointers, false);
        } finally {
            db.close();
        }
    } finally {
        await server.close();
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

test('incident status, note, and remediation endpoints update durable state and audits', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-api-'));
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({
        dbPath,
        pseudonymizationSecret: SECRET,
    });
    const server = await createIncidentServer(store, {
        traceApiToken: null,
        serviceToken: 'service-secret',
    });

    try {
        const reportResponse = await fetch(`${server.url}/api/incidents/report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
            },
            body: JSON.stringify({
                reporterUserId: '123456789012345678',
                responseId: 'response_123',
                consentedAt: new Date().toISOString(),
            }),
        });
        const reportPayload = (await reportResponse.json()) as {
            incident: { incidentId: string };
        };
        const incidentId = reportPayload.incident.incidentId;

        const statusResponse = await fetch(
            `${server.url}/api/incidents/${incidentId}/status`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Service-Token': 'service-secret',
                },
                body: JSON.stringify({
                    status: 'under_review',
                    actorUserId: '999999999999999999',
                    notes: 'reviewing now',
                }),
            }
        );
        assert.equal(statusResponse.status, 200);

        const noteResponse = await fetch(
            `${server.url}/api/incidents/${incidentId}/notes`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Service-Token': 'service-secret',
                },
                body: JSON.stringify({
                    actorUserId: '999999999999999999',
                    notes: 'internal note',
                }),
            }
        );
        assert.equal(noteResponse.status, 200);

        const remediationResponse = await fetch(
            `${server.url}/api/incidents/${incidentId}/remediation`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Service-Token': 'service-secret',
                },
                body: JSON.stringify({
                    actorUserId: '999999999999999999',
                    state: 'applied',
                    notes: 'warning banner applied',
                }),
            }
        );
        assert.equal(remediationResponse.status, 200);
        const remediationPayload = (await remediationResponse.json()) as {
            incident: {
                status: string;
                remediation: { state: string; applied: boolean };
                auditEvents: Array<{ action: string }>;
            };
        };
        assert.equal(remediationPayload.incident.status, 'under_review');
        assert.equal(remediationPayload.incident.remediation.state, 'applied');
        assert.equal(remediationPayload.incident.remediation.applied, true);
        assert.deepEqual(
            remediationPayload.incident.auditEvents.map((event) => event.action),
            [
                'incident.created',
                'incident.status_changed',
                'incident.note_added',
                'incident.remediated',
            ]
        );
    } finally {
        await server.close();
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

test('incident handlers reject missing auth and return 404 for unknown incidents', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-api-'));
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({
        dbPath,
        pseudonymizationSecret: SECRET,
    });
    const server = await createIncidentServer(store, {
        traceApiToken: 'trace-secret',
        serviceToken: 'service-secret',
    });

    try {
        const missingAuthResponse = await fetch(`${server.url}/api/incidents`);
        assert.equal(missingAuthResponse.status, 401);

        const invalidAuthResponse = await fetch(`${server.url}/api/incidents`, {
            headers: {
                'X-Trace-Token': 'wrong-token',
            },
        });
        assert.equal(invalidAuthResponse.status, 403);

        const missingIncidentResponse = await fetch(
            `${server.url}/api/incidents/notfound01`,
            {
                headers: {
                    'X-Service-Token': 'service-secret',
                },
            }
        );
        assert.equal(missingIncidentResponse.status, 404);
    } finally {
        await server.close();
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

test('incident list rejects an invalid status filter with 400', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-api-'));
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({
        dbPath,
        pseudonymizationSecret: SECRET,
    });
    const server = await createIncidentServer(store, {
        traceApiToken: 'trace-secret',
        serviceToken: null,
    });

    try {
        const response = await fetch(
            `${server.url}/api/incidents?status=definitely_not_valid`,
            {
                headers: {
                    'X-Trace-Token': 'trace-secret',
                },
            }
        );

        assert.equal(response.status, 400);
        const payload = (await response.json()) as { details?: string };
        assert.match(String(payload.details), /valid incident status/i);
    } finally {
        await server.close();
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});

test('incident notes endpoint rejects whitespace-only notes with 400', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-api-'));
    const dbPath = path.join(tempRoot, 'incidents.db');
    const store = new SqliteIncidentStore({
        dbPath,
        pseudonymizationSecret: SECRET,
    });
    const server = await createIncidentServer(store, {
        traceApiToken: null,
        serviceToken: 'service-secret',
    });

    try {
        const reportResponse = await fetch(`${server.url}/api/incidents/report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Service-Token': 'service-secret',
            },
            body: JSON.stringify({
                reporterUserId: '123456789012345678',
                consentedAt: new Date().toISOString(),
            }),
        });
        assert.equal(reportResponse.status, 200);
        const reportPayload = (await reportResponse.json()) as {
            incident: { incidentId: string };
        };

        const noteResponse = await fetch(
            `${server.url}/api/incidents/${reportPayload.incident.incidentId}/notes`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Service-Token': 'service-secret',
                },
                body: JSON.stringify({
                    actorUserId: '999999999999999999',
                    notes: '   ',
                }),
            }
        );

        assert.equal(noteResponse.status, 400);
        const payload = (await noteResponse.json()) as { details?: string };
        assert.match(String(payload.details), /notes/i);
    } finally {
        await server.close();
        store.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
});
