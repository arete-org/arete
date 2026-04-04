/**
 * @description: Verifies alert routing config parsing and validation for Discord and SMTP channels.
 * @footnote-scope: test
 * @footnote-module: BackendAlertConfigTests
 * @footnote-risk: medium - Misparsed alert config can silently disable operator notifications.
 * @footnote-ethics: high - Alert config correctness affects incident visibility and escalation timing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeConfig } from '../src/config/buildRuntimeConfig.js';

test('alert config defaults both channels to disabled', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig({}, (message) => warnings.push(message));

    assert.equal(config.alerts.discord.enabled, false);
    assert.equal(config.alerts.email.enabled, false);
    assert.equal(config.alerts.email.smtpPort, 587);
    assert.equal(config.alerts.email.smtpSecure, false);
});

test('discord alerts disable when enabled without required token/channel', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig(
        {
            INCIDENT_ALERTS_DISCORD_ENABLED: 'true',
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.alerts.discord.enabled, false);
    assert.match(
        warnings.join('\n'),
        /INCIDENT_ALERTS_DISCORD_ENABLED is true/i
    );
});

test('email alerts require host/from/to and paired auth credentials', () => {
    const warnings: string[] = [];
    const config = buildRuntimeConfig(
        {
            INCIDENT_ALERTS_EMAIL_ENABLED: 'true',
            INCIDENT_ALERTS_EMAIL_SMTP_HOST: 'smtp.example.com',
            INCIDENT_ALERTS_EMAIL_SMTP_USERNAME: 'admin',
            INCIDENT_ALERTS_EMAIL_FROM: 'alerts@example.com',
            INCIDENT_ALERTS_EMAIL_TO: 'ops@example.com',
        },
        (message) => warnings.push(message)
    );

    assert.equal(config.alerts.email.enabled, true);
    assert.equal(config.alerts.email.smtpUsername, null);
    assert.equal(config.alerts.email.smtpPassword, null);
    assert.match(
        warnings.join('\n'),
        /SMTP_USERNAME and INCIDENT_ALERTS_EMAIL_SMTP_PASSWORD must be set together/i
    );
});
