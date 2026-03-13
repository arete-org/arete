/**
 * @description: Verifies the private /incident command authorization and backend wiring.
 * @footnote-scope: test
 * @footnote-module: IncidentCommandTests
 * @footnote-risk: low - Test-only coverage for slash-command behavior.
 * @footnote-ethics: high - Confirms incident review stays limited to configured superusers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { botApi } from '../src/api/botApi.js';
import { runtimeConfig } from '../src/config.js';
import incidentCommand, {
    handleIncidentViewSelect,
    INCIDENT_VIEW_SELECT_PREFIX,
} from '../src/commands/incident.js';

test('incident command denies non-superusers before calling backend', async () => {
    const superuserIds = runtimeConfig.incidentReview.superuserIds as string[];
    const originalIds = [...superuserIds];
    const originalListIncidents = botApi.listIncidents;
    const replyPayloads: unknown[] = [];
    let calledBackend = false;

    superuserIds.splice(0, superuserIds.length, 'superuser-1');
    botApi.listIncidents = (async () => {
        calledBackend = true;
        return { incidents: [] };
    }) as typeof botApi.listIncidents;

    try {
        await incidentCommand.execute({
            user: { id: 'not-allowed' },
            options: {
                getSubcommand: () => 'list',
            },
            reply: async (payload: unknown) => {
                replyPayloads.push(payload);
            },
        } as never);

        assert.equal(calledBackend, false);
        assert.match(
            String((replyPayloads[0] as { content?: string }).content),
            /do not have permission/i
        );
    } finally {
        superuserIds.splice(0, superuserIds.length, ...originalIds);
        botApi.listIncidents = originalListIncidents;
    }
});

test('incident command view fetches a short-ID incident and replies with operator-safe detail', async () => {
    const superuserIds = runtimeConfig.incidentReview.superuserIds as string[];
    const originalIds = [...superuserIds];
    const originalGetIncident = botApi.getIncident;
    const replyPayloads: unknown[] = [];
    let capturedIncidentId = '';

    superuserIds.splice(0, superuserIds.length, 'superuser-1');
    botApi.getIncident = (async (incidentId) => {
        capturedIncidentId = incidentId;
        return {
            incident: {
                incidentId,
                status: 'under_review',
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
                    state: 'applied',
                    applied: true,
                    notes: 'warning banner applied',
                    updatedAt: new Date().toISOString(),
                },
                auditEvents: [
                    {
                        action: 'incident.created',
                        actorHash: 'b'.repeat(64),
                        notes: 'created',
                        createdAt: new Date().toISOString(),
                    },
                ],
            },
        };
    }) as typeof botApi.getIncident;

    try {
        await incidentCommand.execute({
            user: { id: 'superuser-1' },
            options: {
                getSubcommand: () => 'view',
                getString: (name: string) =>
                    name === 'incident_id' ? '1a2b3c4d' : null,
            },
            reply: async (payload: unknown) => {
                replyPayloads.push(payload);
            },
        } as never);

        assert.equal(capturedIncidentId, '1a2b3c4d');
        assert.match(
            String((replyPayloads[0] as { content?: string }).content),
            /Incident 1a2b3c4d/i
        );
        assert.doesNotMatch(
            String((replyPayloads[0] as { content?: string }).content),
            /123456789012345678/
        );
    } finally {
        superuserIds.splice(0, superuserIds.length, ...originalIds);
        botApi.getIncident = originalGetIncident;
    }
});

test('incident command view truncates overlong replies instead of exceeding Discord limits', async () => {
    const superuserIds = runtimeConfig.incidentReview.superuserIds as string[];
    const originalIds = [...superuserIds];
    const originalGetIncident = botApi.getIncident;
    const replyPayloads: unknown[] = [];

    superuserIds.splice(0, superuserIds.length, 'superuser-1');
    botApi.getIncident = (async (incidentId) => {
        return {
            incident: {
                incidentId,
                status: 'under_review',
                tags: ['safety'],
                description: 'x'.repeat(2500),
                contact: 'reviewer@example.com',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                consentedAt: new Date().toISOString(),
                pointers: {
                    responseId: 'response_123',
                },
                remediation: {
                    state: 'applied',
                    applied: true,
                    notes: 'y'.repeat(1200),
                    updatedAt: new Date().toISOString(),
                },
                auditEvents: [
                    {
                        action: 'incident.created',
                        actorHash: 'b'.repeat(64),
                        notes: 'z'.repeat(1200),
                        createdAt: new Date().toISOString(),
                    },
                ],
            },
        };
    }) as typeof botApi.getIncident;

    try {
        await incidentCommand.execute({
            user: { id: 'superuser-1' },
            options: {
                getSubcommand: () => 'view',
                getString: (name: string) =>
                    name === 'incident_id' ? '1a2b3c4d' : null,
            },
            reply: async (payload: unknown) => {
                replyPayloads.push(payload);
            },
        } as never);

        const content = String((replyPayloads[0] as { content?: string }).content);
        assert.ok(content.length <= 2000);
        assert.match(content, /\.\.\. \(truncated\)$/);
    } finally {
        superuserIds.splice(0, superuserIds.length, ...originalIds);
        botApi.getIncident = originalGetIncident;
    }
});

test('incident command view without an ID shows a picker for unprocessed incidents', async () => {
    const superuserIds = runtimeConfig.incidentReview.superuserIds as string[];
    const originalIds = [...superuserIds];
    const originalListIncidents = botApi.listIncidents;
    const replyPayloads: unknown[] = [];

    superuserIds.splice(0, superuserIds.length, 'superuser-1');
    botApi.listIncidents = (async () => ({
        incidents: [
            {
                incidentId: 'resolved01',
                status: 'resolved',
                tags: ['done'],
                description: null,
                contact: null,
                createdAt: '2026-03-10T00:00:00.000Z',
                updatedAt: '2026-03-10T00:00:00.000Z',
                consentedAt: '2026-03-10T00:00:00.000Z',
                pointers: {},
                remediation: {
                    state: 'applied',
                    applied: true,
                    notes: null,
                    updatedAt: null,
                },
            },
            {
                incidentId: 'new12345',
                status: 'new',
                tags: ['safety'],
                description: null,
                contact: null,
                createdAt: '2026-03-12T00:00:00.000Z',
                updatedAt: '2026-03-12T00:00:00.000Z',
                consentedAt: '2026-03-12T00:00:00.000Z',
                pointers: {},
                remediation: {
                    state: 'pending',
                    applied: false,
                    notes: null,
                    updatedAt: null,
                },
            },
            {
                incidentId: 'review001',
                status: 'under_review',
                tags: ['policy'],
                description: null,
                contact: null,
                createdAt: '2026-03-11T00:00:00.000Z',
                updatedAt: '2026-03-11T00:00:00.000Z',
                consentedAt: '2026-03-11T00:00:00.000Z',
                pointers: {},
                remediation: {
                    state: 'applied',
                    applied: true,
                    notes: null,
                    updatedAt: null,
                },
            },
        ],
    })) as typeof botApi.listIncidents;

    try {
        await incidentCommand.execute({
            user: { id: 'superuser-1' },
            options: {
                getSubcommand: () => 'view',
                getString: () => null,
            },
            reply: async (payload: unknown) => {
                replyPayloads.push(payload);
            },
        } as never);

        const payload = replyPayloads[0] as {
            content?: string;
            components?: Array<{
                components?: Array<{
                    options?: Array<{ data?: { value?: string }; value?: string }>;
                    data?: {
                        custom_id?: string;
                        options?: Array<{
                            data?: { value?: string };
                            value?: string;
                        }>;
                    };
                }>;
            }>;
        };
        assert.match(String(payload.content), /select an unprocessed incident/i);
        const menu = payload.components?.[0]?.components?.[0];
        const menuData = menu?.data;
        const menuOptions = menuData?.options ?? menu?.options ?? [];
        assert.equal(
            menuData?.custom_id,
            `${INCIDENT_VIEW_SELECT_PREFIX}superuser-1`
        );
        assert.deepEqual(
            menuOptions.map((option) => option.data?.value ?? option.value),
            ['new12345', 'review001']
        );
    } finally {
        superuserIds.splice(0, superuserIds.length, ...originalIds);
        botApi.listIncidents = originalListIncidents;
    }
});

test('incident picker selection updates the ephemeral view with incident detail', async () => {
    const superuserIds = runtimeConfig.incidentReview.superuserIds as string[];
    const originalIds = [...superuserIds];
    const originalGetIncident = botApi.getIncident;
    const updatePayloads: unknown[] = [];

    superuserIds.splice(0, superuserIds.length, 'superuser-1');
    botApi.getIncident = (async (incidentId) => ({
        incident: {
            incidentId,
            status: 'new',
            tags: ['safety'],
            description: 'reported',
            contact: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            consentedAt: new Date().toISOString(),
            pointers: {
                responseId: 'response_123',
            },
            remediation: {
                state: 'pending',
                applied: false,
                notes: null,
                updatedAt: null,
            },
            auditEvents: [],
        },
    })) as typeof botApi.getIncident;

    try {
        await handleIncidentViewSelect({
            user: { id: 'superuser-1' },
            customId: `${INCIDENT_VIEW_SELECT_PREFIX}superuser-1`,
            values: ['1a2b3c4d'],
            update: async (payload: unknown) => {
                updatePayloads.push(payload);
            },
            reply: async () => undefined,
            deferUpdate: async () => undefined,
        } as never);

        const payload = updatePayloads[0] as { content?: string; components?: unknown[] };
        assert.match(String(payload.content), /Incident 1a2b3c4d/i);
        assert.deepEqual(payload.components, []);
    } finally {
        superuserIds.splice(0, superuserIds.length, ...originalIds);
        botApi.getIncident = originalGetIncident;
    }
});
