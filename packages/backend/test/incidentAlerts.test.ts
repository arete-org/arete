/**
 * @description: Validates incident alert routing across Discord/email targets with fail-open delivery behavior.
 * @footnote-scope: test
 * @footnote-module: IncidentAlertRouterTests
 * @footnote-risk: medium - Missing coverage could let alert delivery regress silently.
 * @footnote-ethics: high - Alerts are part of human oversight for safety-relevant incidents.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncidentAlertRouter } from '../src/services/incidentAlerts.js';

const incidentEvent = {
    type: 'incident' as const,
    action: 'incident.created' as const,
    incidentId: 'abcd1234',
    status: 'new',
    responseId: 'resp_123',
    tags: ['safety'],
    description: 'please review',
    remediationState: 'pending',
    correlation: {
        conversationId: 'session_123',
        requestId: 'message_123',
        incidentId: 'abcd1234',
        responseId: 'resp_123',
    },
};

const breakerEvent = {
    type: 'breaker' as const,
    action: 'chat.orchestration.breaker_action_applied' as const,
    surface: 'discord' as const,
    authorityLevel: 'influence' as const,
    enforcement: 'observe_only' as const,
    breakerAction: 'block',
    ruleId: 'safety.rule.v1',
    reasonCode: 'test_reason',
    reason: 'test breaker reason',
    safetyTier: 'High',
    responseAction: 'message' as const,
    responseModality: 'text' as const,
    responseId: null,
    correlation: {
        conversationId: null,
        requestId: 'message_999',
        incidentId: null,
        responseId: null,
    },
};

test('router delivers incident and breaker alerts and forwards configured Discord roleId', async () => {
    const discordCalls: Array<{ content: string; roleId: string | null }> = [];
    const emailCalls: Array<{ subject: string; text: string }> = [];
    const router = createIncidentAlertRouter({
        config: {
            discord: {
                enabled: true,
                botToken: 'bot-token',
                channelId: '123456789012345678',
                roleId: '876543210987654321',
            },
            email: {
                enabled: true,
                smtpHost: 'smtp.example.com',
                smtpPort: 587,
                smtpSecure: false,
                smtpUsername: null,
                smtpPassword: null,
                from: 'alerts@example.com',
                to: ['ops@example.com'],
            },
        },
        sendDiscord: async (input) => {
            discordCalls.push({
                content: input.content,
                roleId: input.roleId,
            });
        },
        sendEmail: async (input) => {
            emailCalls.push({ subject: input.subject, text: input.text });
        },
    });

    await router.notify(incidentEvent);
    await router.notify(breakerEvent);

    assert.equal(discordCalls.length, 2);
    assert.match(discordCalls[0]?.content ?? '', /Footnote incident alert/);
    assert.match(discordCalls[1]?.content ?? '', /Footnote breaker alert/);
    assert.equal(discordCalls[0]?.roleId, '876543210987654321');
    assert.equal(discordCalls[1]?.roleId, '876543210987654321');
    assert.equal(emailCalls.length, 2);
    assert.match(emailCalls[0]?.subject ?? '', /\[Footnote\]\[Incident\]/);
    assert.match(emailCalls[1]?.subject ?? '', /\[Footnote\]\[Breaker\]/);
    assert.match(emailCalls[0]?.text ?? '', /incidentId: abcd1234/);
    assert.match(emailCalls[1]?.text ?? '', /breakerAction: block/);
    assert.match(emailCalls[1]?.text ?? '', /authorityLevel: influence/);
    assert.match(emailCalls[1]?.text ?? '', /enforcement: observe_only/);
    assert.match(emailCalls[1]?.text ?? '', /responseAction: message/);
});

test('router stays fail-open and reports structured failure metadata', async () => {
    const failures: Array<{
        alertChannel: 'discord' | 'email';
        alertType: 'incident' | 'breaker';
        alertAction: string;
        error: string;
    }> = [];
    const router = createIncidentAlertRouter({
        config: {
            discord: {
                enabled: true,
                botToken: 'bot-token',
                channelId: '123456789012345678',
                roleId: null,
            },
            email: {
                enabled: true,
                smtpHost: 'smtp.example.com',
                smtpPort: 587,
                smtpSecure: false,
                smtpUsername: null,
                smtpPassword: null,
                from: 'alerts@example.com',
                to: ['ops@example.com'],
            },
        },
        sendDiscord: async () => {
            throw new Error('discord fail');
        },
        sendEmail: async () => {
            throw new Error('smtp fail');
        },
        onDeliveryFailure: (meta) => {
            failures.push(meta);
        },
    });

    await assert.doesNotReject(async () => {
        await router.notify(incidentEvent);
    });
    await new Promise<void>((resolve) => {
        setImmediate(() => resolve());
    });
    assert.deepEqual(failures.map((failure) => failure.alertChannel).sort(), [
        'discord',
        'email',
    ]);
    assert.equal(failures[0]?.alertType, 'incident');
    assert.equal(failures[0]?.alertAction, 'incident.created');
});

test('router stays fail-open when onDeliveryFailure throws', async () => {
    const router = createIncidentAlertRouter({
        config: {
            discord: {
                enabled: true,
                botToken: 'bot-token',
                channelId: '123456789012345678',
                roleId: null,
            },
            email: {
                enabled: false,
                smtpHost: null,
                smtpPort: 587,
                smtpSecure: false,
                smtpUsername: null,
                smtpPassword: null,
                from: null,
                to: [],
            },
        },
        sendDiscord: async () => {
            throw new Error('discord fail');
        },
        onDeliveryFailure: () => {
            throw new Error('failure callback boom');
        },
    });

    await assert.doesNotReject(async () => {
        await router.notify(incidentEvent);
    });
});
