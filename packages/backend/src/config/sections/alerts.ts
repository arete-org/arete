/**
 * @description: Builds incident/breaker alert routing settings for Discord and SMTP email targets.
 * @footnote-scope: utility
 * @footnote-module: BackendAlertsSection
 * @footnote-risk: medium - Invalid alert routing config can silently drop operator notifications.
 * @footnote-ethics: high - Alert routing affects incident awareness and response accountability.
 */

import { envDefaultValues } from '@footnote/config-spec';
import {
    parseBooleanEnv,
    parseCsvEnv,
    parseOptionalTrimmedString,
    parsePositiveIntEnv,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

/**
 * Resolves alert routing targets and disables each channel type when required
 * config values are missing.
 */
export const buildAlertsSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['alerts'] => {
    const discordEnabled = parseBooleanEnv(
        env.INCIDENT_ALERTS_DISCORD_ENABLED,
        envDefaultValues.INCIDENT_ALERTS_DISCORD_ENABLED,
        'INCIDENT_ALERTS_DISCORD_ENABLED',
        warn
    );
    const discordBotToken = parseOptionalTrimmedString(
        env.INCIDENT_ALERTS_DISCORD_BOT_TOKEN
    );
    const discordChannelId = parseOptionalTrimmedString(
        env.INCIDENT_ALERTS_DISCORD_CHANNEL_ID
    );
    const discordRoleId = parseOptionalTrimmedString(
        env.INCIDENT_ALERTS_DISCORD_ROLE_ID
    );
    const discordConfigured = Boolean(discordBotToken && discordChannelId);
    if (discordEnabled && !discordConfigured) {
        warn(
            'INCIDENT_ALERTS_DISCORD_ENABLED is true but required Discord target values are missing (need INCIDENT_ALERTS_DISCORD_BOT_TOKEN and INCIDENT_ALERTS_DISCORD_CHANNEL_ID). Discord alerts will be disabled.'
        );
    }

    const emailEnabled = parseBooleanEnv(
        env.INCIDENT_ALERTS_EMAIL_ENABLED,
        envDefaultValues.INCIDENT_ALERTS_EMAIL_ENABLED,
        'INCIDENT_ALERTS_EMAIL_ENABLED',
        warn
    );
    const emailSmtpHost = parseOptionalTrimmedString(
        env.INCIDENT_ALERTS_EMAIL_SMTP_HOST
    );
    const emailSmtpPort = parsePositiveIntEnv(
        env.INCIDENT_ALERTS_EMAIL_SMTP_PORT,
        envDefaultValues.INCIDENT_ALERTS_EMAIL_SMTP_PORT,
        'INCIDENT_ALERTS_EMAIL_SMTP_PORT',
        warn
    );
    const emailSmtpSecure = parseBooleanEnv(
        env.INCIDENT_ALERTS_EMAIL_SMTP_SECURE,
        envDefaultValues.INCIDENT_ALERTS_EMAIL_SMTP_SECURE,
        'INCIDENT_ALERTS_EMAIL_SMTP_SECURE',
        warn
    );
    const emailSmtpUsername = parseOptionalTrimmedString(
        env.INCIDENT_ALERTS_EMAIL_SMTP_USERNAME
    );
    const emailSmtpPassword = parseOptionalTrimmedString(
        env.INCIDENT_ALERTS_EMAIL_SMTP_PASSWORD
    );
    const emailFrom = parseOptionalTrimmedString(
        env.INCIDENT_ALERTS_EMAIL_FROM
    );
    const emailTo = parseCsvEnv(env.INCIDENT_ALERTS_EMAIL_TO, []);
    const emailHasAuthPair =
        (!emailSmtpUsername && !emailSmtpPassword) ||
        (emailSmtpUsername && emailSmtpPassword);
    if (!emailHasAuthPair) {
        warn(
            'INCIDENT_ALERTS_EMAIL_SMTP_USERNAME and INCIDENT_ALERTS_EMAIL_SMTP_PASSWORD must be set together. Ignoring SMTP auth settings.'
        );
    }
    const emailConfigured = Boolean(
        emailSmtpHost && emailFrom && emailTo.length
    );
    if (emailEnabled && !emailConfigured) {
        warn(
            'INCIDENT_ALERTS_EMAIL_ENABLED is true but required email target values are missing (need INCIDENT_ALERTS_EMAIL_SMTP_HOST, INCIDENT_ALERTS_EMAIL_FROM, and INCIDENT_ALERTS_EMAIL_TO). Email alerts will be disabled.'
        );
    }

    return {
        discord: {
            enabled: discordEnabled && discordConfigured,
            botToken: discordBotToken,
            channelId: discordChannelId,
            roleId: discordRoleId,
        },
        email: {
            enabled: emailEnabled && emailConfigured,
            smtpHost: emailSmtpHost,
            smtpPort: emailSmtpPort,
            smtpSecure: emailSmtpSecure,
            smtpUsername: emailHasAuthPair ? emailSmtpUsername : null,
            smtpPassword: emailHasAuthPair ? emailSmtpPassword : null,
            from: emailFrom,
            to: emailTo,
        },
    };
};
