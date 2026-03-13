/**
 * @description: Covers the Discord bot incident API client wrapper.
 * @footnote-scope: test
 * @footnote-module: DiscordIncidentApiTests
 * @footnote-risk: low - These tests validate transport wiring and error propagation only.
 * @footnote-ethics: medium - Stable incident transport keeps reporting and review flows predictable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
    GetIncidentResponse,
    GetIncidentsResponse,
    PostIncidentNotesResponse,
    PostIncidentRemediationResponse,
    PostIncidentReportRequest,
    PostIncidentReportResponse,
    PostIncidentStatusResponse,
} from '@footnote/contracts/web';
import type {
    ApiJsonResult,
    ApiRequestOptions,
    ApiRequester,
} from '../src/api/client.js';
import { createIncidentApi } from '../src/api/incidents.js';

const baseIncident = {
    incidentId: '1a2b3c4d',
    status: 'new',
    tags: ['safety'],
    description: 'reported',
    contact: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    consentedAt: new Date().toISOString(),
    pointers: {
        responseId: 'response_123',
        guildId: 'a'.repeat(64),
    },
    remediation: {
        state: 'pending',
        applied: false,
        notes: null,
        updatedAt: null,
    },
} as const;

const buildReportRequest = (): PostIncidentReportRequest => ({
    reporterUserId: '123456789012345678',
    guildId: '234567890123456789',
    channelId: '345678901234567890',
    messageId: '456789012345678901',
    jumpUrl: 'https://discord.com/channels/1/2/3',
    responseId: 'response_123',
    chainHash: 'hash_abc',
    modelVersion: 'gpt-5-mini',
    tags: ['safety'],
    description: 'Please review',
    consentedAt: new Date().toISOString(),
});

test('incident API methods send trusted headers and parse response payloads', async () => {
    const reportRequest = buildReportRequest();
    const calls: Array<{
        endpoint: string;
        method?: string;
        headers?: Record<string, string>;
        body?: unknown;
    }> = [];

    const requestJson: ApiRequester = async <T>(
        endpoint: string,
        options: ApiRequestOptions<T> = {}
    ): Promise<ApiJsonResult<T>> => {
        calls.push({
            endpoint,
            method: options.method,
            headers: options.headers as Record<string, string> | undefined,
            body: options.body,
        });

        const sharedIncident = {
            ...baseIncident,
            auditEvents: [
                {
                    action: 'incident.created',
                    actorHash: 'b'.repeat(64),
                    notes: 'created',
                    createdAt: new Date().toISOString(),
                },
            ],
        };

        if (endpoint === '/api/incidents/report') {
            return {
                status: 200,
                data: {
                    incident: sharedIncident,
                    remediation: { state: 'pending' },
                } as T,
            };
        }

        if (endpoint.startsWith('/api/incidents?')) {
            return {
                status: 200,
                data: {
                    incidents: [baseIncident],
                } as T,
            };
        }

        if (endpoint.endsWith('/status')) {
            return {
                status: 200,
                data: { incident: sharedIncident } as T,
            };
        }

        if (endpoint.endsWith('/notes')) {
            return {
                status: 200,
                data: { incident: sharedIncident } as T,
            };
        }

        if (endpoint.endsWith('/remediation')) {
            return {
                status: 200,
                data: { incident: sharedIncident } as T,
            };
        }

        return {
            status: 200,
            data: { incident: sharedIncident } as T,
        };
    };

    const api = createIncidentApi(requestJson, {
        traceApiToken: 'trace-secret',
    });

    const reportResponse: PostIncidentReportResponse = await api.reportIncident(
        reportRequest
    );
    const listResponse: GetIncidentsResponse = await api.listIncidents({
        status: 'new',
        tag: 'safety',
    });
    const detailResponse: GetIncidentResponse = await api.getIncident(
        '1a2b3c4d'
    );
    const statusResponse: PostIncidentStatusResponse =
        await api.updateIncidentStatus('1a2b3c4d', {
            status: 'under_review',
            actorUserId: '123456789012345678',
        });
    const noteResponse: PostIncidentNotesResponse = await api.addIncidentNote(
        '1a2b3c4d',
        {
            actorUserId: '123456789012345678',
            notes: 'internal note',
        }
    );
    const remediationResponse: PostIncidentRemediationResponse =
        await api.recordIncidentRemediation('1a2b3c4d', {
            actorUserId: '123456789012345678',
            state: 'applied',
            notes: 'banner applied',
        });

    assert.equal(calls[0]?.endpoint, '/api/incidents/report');
    assert.equal(calls[0]?.headers?.['X-Trace-Token'], 'trace-secret');
    assert.deepEqual(calls[0]?.body, reportRequest);
    assert.equal(reportResponse.incident.incidentId, '1a2b3c4d');

    assert.equal(
        calls[1]?.endpoint,
        '/api/incidents?status=new&tag=safety'
    );
    assert.equal(listResponse.incidents[0]?.incidentId, '1a2b3c4d');

    assert.equal(calls[2]?.endpoint, '/api/incidents/1a2b3c4d');
    assert.equal(detailResponse.incident.incidentId, '1a2b3c4d');

    assert.equal(calls[3]?.endpoint, '/api/incidents/1a2b3c4d/status');
    assert.equal(statusResponse.incident.incidentId, '1a2b3c4d');

    assert.equal(calls[4]?.endpoint, '/api/incidents/1a2b3c4d/notes');
    assert.equal(noteResponse.incident.incidentId, '1a2b3c4d');

    assert.equal(calls[5]?.endpoint, '/api/incidents/1a2b3c4d/remediation');
    assert.equal(remediationResponse.incident.incidentId, '1a2b3c4d');
});

test('incident API methods propagate backend errors', async () => {
    const requestJson: ApiRequester = async () => {
        throw new Error('incident backend exploded');
    };
    const api = createIncidentApi(requestJson);

    await assert.rejects(() => api.getIncident('1a2b3c4d'), /incident backend exploded/);
});
