/**
 * @description: Covers the Discord report-issue consent and modal flow.
 * @footnote-scope: test
 * @footnote-module: IncidentReportingTests
 * @footnote-risk: low - Test-only coverage for report interaction helpers.
 * @footnote-ethics: high - Confirms consented reporting and explicit failure messaging.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { botApi } from '../src/api/botApi.js';
import { buildProvenanceActionRow } from '../src/utils/response/provenanceCgi.js';
import {
    handleIncidentReportButton,
    handleIncidentReportCancel,
    handleIncidentReportConsent,
    handleIncidentReportModal,
    INCIDENT_REPORT_CANCEL_PREFIX,
    INCIDENT_REPORT_CONSENT_PREFIX,
    INCIDENT_REPORT_MODAL_PREFIX,
} from '../src/utils/response/incidentReporting.js';

const buildEphemeralMessage = () => ({
    id: 'ephemeral',
    edit: async () => undefined,
});

test('handleIncidentReportButton opens a consent prompt and cancel clears it', async () => {
    const deferReplyPayloads: unknown[] = [];
    const editReplyPayloads: unknown[] = [];
    const updatePayloads: unknown[] = [];
    const originalGetTrace = botApi.getTrace;

    botApi.getTrace = (async () => ({
        status: 200,
        data: {
            responseId: 'response_123',
            provenance: 'Inferred',
            riskTier: 'Low',
            tradeoffCount: 0,
            chainHash: 'hash_abc',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
        },
    })) as typeof botApi.getTrace;

    try {
        await handleIncidentReportButton({
            user: { id: 'user-1' },
            guildId: 'guild-1',
            channelId: 'channel-1',
            message: {
                id: 'source-message',
                content: 'assistant reply',
                components: [buildProvenanceActionRow('response_123')],
                url: 'https://discord.com/channels/1/2/3',
            },
            deferReply: async (payload: unknown) => {
                deferReplyPayloads.push(payload);
            },
            editReply: async (payload: unknown) => {
                editReplyPayloads.push(payload);
                return buildEphemeralMessage();
            },
        } as never);

        assert.equal(deferReplyPayloads.length, 1);
        assert.equal(editReplyPayloads.length, 1);
        const consentPayload = editReplyPayloads[0] as {
            content: string;
            components: Array<{
                components: Array<{
                    customId?: string;
                    data?: { custom_id?: string };
                }>;
            }>;
        };
        const consentCustomId =
            consentPayload.components[0]?.components[0]?.customId ??
            consentPayload.components[0]?.components[0]?.data?.custom_id ??
            '';
        assert.match(consentPayload.content, /durable incident record/i);
        assert.match(consentCustomId, /^incident_report_consent:/);

        await handleIncidentReportCancel({
            user: { id: 'user-1' },
            customId: `${INCIDENT_REPORT_CANCEL_PREFIX}source-message`,
            update: async (payload: unknown) => {
                updatePayloads.push(payload);
            },
        } as never);

        assert.equal(updatePayloads.length, 1);
        assert.match(
            String((updatePayloads[0] as { content?: string }).content),
            /cancelled/i
        );
    } finally {
        botApi.getTrace = originalGetTrace;
    }
});

test('incident report modal stores the incident and remediation outcome', async () => {
    const originalGetTrace = botApi.getTrace;
    const originalReportIncident = botApi.reportIncident;
    const originalRecordRemediation = botApi.recordIncidentRemediation;
    let capturedModal: unknown = null;
    let capturedReportRequest: unknown = null;
    let capturedRemediationRequest: unknown = null;
    const deferReplyPayloads: unknown[] = [];
    let deletedReply = false;

    botApi.getTrace = (async () => ({
        status: 200,
        data: {
            responseId: 'response_123',
            provenance: 'Inferred',
            riskTier: 'Low',
            tradeoffCount: 0,
            chainHash: 'hash_abc',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
        },
    })) as typeof botApi.getTrace;
    botApi.reportIncident = (async (request) => {
        capturedReportRequest = request;
        return {
            incident: {
                incidentId: '1a2b3c4d',
                status: 'new',
                tags: ['safety'],
                description: 'Please review',
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
            remediation: { state: 'pending' },
        };
    }) as typeof botApi.reportIncident;
    botApi.recordIncidentRemediation = (async (incidentId, request) => {
        capturedRemediationRequest = { incidentId, request };
        return {
            incident: {
                incidentId,
                status: 'new',
                tags: ['safety'],
                description: 'Please review',
                contact: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                consentedAt: new Date().toISOString(),
                pointers: {
                    responseId: 'response_123',
                },
                remediation: {
                    state: request.state,
                    applied: request.state === 'applied',
                    notes: request.notes ?? null,
                    updatedAt: new Date().toISOString(),
                },
                auditEvents: [],
            },
        };
    }) as typeof botApi.recordIncidentRemediation;

    try {
        await handleIncidentReportButton({
            user: { id: 'user-1' },
            guildId: 'guild-1',
            channelId: 'channel-1',
            message: {
                id: 'source-message',
                content: 'assistant reply',
                author: { id: 'bot-user' },
                client: { user: { id: 'bot-user' } },
                components: [buildProvenanceActionRow('response_123')],
                url: 'https://discord.com/channels/1/2/3',
            },
            deferReply: async () => undefined,
            editReply: async () => buildEphemeralMessage(),
        } as never);

        await handleIncidentReportConsent({
            user: { id: 'user-1' },
            customId: `${INCIDENT_REPORT_CONSENT_PREFIX}source-message`,
            showModal: async (modal: unknown) => {
                capturedModal = modal;
            },
            reply: async () => undefined,
        } as never);

        assert.ok(capturedModal, 'Expected the consent action to open a modal');

        await handleIncidentReportModal({
            user: { id: 'user-1' },
            guildId: 'guild-1',
            channelId: 'channel-1',
            customId: `${INCIDENT_REPORT_MODAL_PREFIX}source-message`,
            channel: {
                isTextBased: () => true,
                messages: {
                    fetch: async () => ({
                        author: { id: 'bot-user' },
                        client: { user: { id: 'bot-user' } },
                        content: 'assistant reply',
                        edit: async () => undefined,
                    }),
                },
            },
            fields: {
                getTextInputValue: (fieldId: string) => {
                    if (fieldId === 'incident_report_tags') {
                        return 'safety, review';
                    }
                    if (fieldId === 'incident_report_description') {
                        return 'Please review';
                    }
                    if (fieldId === 'incident_report_contact') {
                        return '';
                    }
                    return '';
                },
            },
            deferReply: async (payload: unknown) => {
                deferReplyPayloads.push(payload);
            },
            deleteReply: async () => {
                deletedReply = true;
            },
        } as never);

        const reportRequest = capturedReportRequest as {
            reporterUserId: string;
            responseId: string;
            tags: string[];
            description: string;
        };
        assert.equal(reportRequest.reporterUserId, 'user-1');
        assert.equal(reportRequest.responseId, 'response_123');
        assert.deepEqual(reportRequest.tags, ['safety', 'review']);
        assert.equal(reportRequest.description, 'Please review');

        const remediationRequest = capturedRemediationRequest as {
            incidentId: string;
            request: { actorUserId: string; state: string };
        };
        assert.equal(remediationRequest.incidentId, '1a2b3c4d');
        assert.equal(remediationRequest.request.actorUserId, 'user-1');
        assert.equal(remediationRequest.request.state, 'applied');
        assert.equal(deferReplyPayloads.length, 1);
        assert.equal(deletedReply, true);
    } finally {
        botApi.getTrace = originalGetTrace;
        botApi.reportIncident = originalReportIncident;
        botApi.recordIncidentRemediation = originalRecordRemediation;
    }
});

test('incident report modal replies explicitly on backend failure', async () => {
    const originalGetTrace = botApi.getTrace;
    const originalReportIncident = botApi.reportIncident;
    const deferReplyPayloads: unknown[] = [];
    const editReplyPayloads: unknown[] = [];

    botApi.getTrace = (async () => ({
        status: 200,
        data: {
            responseId: 'response_123',
            provenance: 'Inferred',
            riskTier: 'Low',
            tradeoffCount: 0,
            chainHash: 'hash_abc',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
        },
    })) as typeof botApi.getTrace;
    botApi.reportIncident = (async () => {
        throw new Error('backend exploded');
    }) as typeof botApi.reportIncident;

    try {
        await handleIncidentReportButton({
            user: { id: 'user-1' },
            guildId: 'guild-1',
            channelId: 'channel-1',
            message: {
                id: 'source-message',
                content: 'assistant reply',
                components: [buildProvenanceActionRow('response_123')],
                url: 'https://discord.com/channels/1/2/3',
            },
            deferReply: async () => undefined,
            editReply: async () => buildEphemeralMessage(),
        } as never);

        await handleIncidentReportModal({
            user: { id: 'user-1' },
            guildId: 'guild-1',
            channelId: 'channel-1',
            customId: `${INCIDENT_REPORT_MODAL_PREFIX}source-message`,
            channel: {
                isTextBased: () => true,
                messages: {
                    fetch: async () => ({
                        author: { id: 'bot-user' },
                        client: { user: { id: 'bot-user' } },
                        content: 'assistant reply',
                        edit: async () => undefined,
                    }),
                },
            },
            fields: {
                getTextInputValue: () => '',
            },
            deferReply: async (payload: unknown) => {
                deferReplyPayloads.push(payload);
            },
            editReply: async (payload: unknown) => {
                editReplyPayloads.push(payload);
            },
        } as never);

        assert.equal(deferReplyPayloads.length, 1);
        assert.match(
            String((editReplyPayloads[0] as { content?: string }).content),
            /could not create that incident report/i
        );
    } finally {
        botApi.getTrace = originalGetTrace;
        botApi.reportIncident = originalReportIncident;
    }
});

test('incident report modal keeps the deferred reply open when remediation persistence fails', async () => {
    const originalGetTrace = botApi.getTrace;
    const originalReportIncident = botApi.reportIncident;
    const originalRecordRemediation = botApi.recordIncidentRemediation;
    const modalEditReplyPayloads: unknown[] = [];
    let deletedReply = false;

    botApi.getTrace = (async () => ({
        status: 200,
        data: {
            responseId: 'response_123',
            provenance: 'Inferred',
            riskTier: 'Low',
            tradeoffCount: 0,
            chainHash: 'hash_abc',
            licenseContext: 'MIT + HL3',
            modelVersion: 'gpt-5-mini',
            staleAfter: new Date(Date.now() + 60000).toISOString(),
            citations: [],
        },
    })) as typeof botApi.getTrace;
    botApi.reportIncident = (async () => ({
        incident: {
            incidentId: '1a2b3c4d',
            status: 'new',
            tags: ['safety'],
            description: 'Please review',
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
        remediation: { state: 'pending' },
    })) as typeof botApi.reportIncident;
    botApi.recordIncidentRemediation = (async () => {
        throw new Error('sqlite busy');
    }) as typeof botApi.recordIncidentRemediation;

    try {
        await handleIncidentReportButton({
            user: { id: 'user-1' },
            guildId: 'guild-1',
            channelId: 'channel-1',
            message: {
                id: 'source-message',
                content: 'assistant reply',
                author: { id: 'bot-user' },
                client: { user: { id: 'bot-user' } },
                components: [buildProvenanceActionRow('response_123')],
                url: 'https://discord.com/channels/1/2/3',
            },
            deferReply: async () => undefined,
            editReply: async () => buildEphemeralMessage(),
        } as never);

        await handleIncidentReportModal({
            user: { id: 'user-1' },
            guildId: 'guild-1',
            channelId: 'channel-1',
            customId: `${INCIDENT_REPORT_MODAL_PREFIX}source-message`,
            channel: {
                isTextBased: () => true,
                messages: {
                    fetch: async () => ({
                        author: { id: 'bot-user' },
                        client: { user: { id: 'bot-user' } },
                        content: 'assistant reply',
                        edit: async () => undefined,
                    }),
                },
            },
            fields: {
                getTextInputValue: () => '',
            },
            deferReply: async () => undefined,
            editReply: async (payload: unknown) => {
                modalEditReplyPayloads.push(payload);
            },
            deleteReply: async () => {
                deletedReply = true;
            },
        } as never);

        assert.equal(deletedReply, false);
        assert.match(
            String((modalEditReplyPayloads[0] as { content?: string }).content),
            /remediation tracking could not be saved/i
        );
    } finally {
        botApi.getTrace = originalGetTrace;
        botApi.reportIncident = originalReportIncident;
        botApi.recordIncidentRemediation = originalRecordRemediation;
    }
});
