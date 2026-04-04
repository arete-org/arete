/**
 * @description: Routes incident and breaker alerts to configured Discord and SMTP email targets.
 * @footnote-scope: core
 * @footnote-module: IncidentAlerts
 * @footnote-risk: medium - Delivery bugs can hide urgent operator events, but must never block primary request flow.
 * @footnote-ethics: high - Alert routing influences timely human oversight for safety and incident handling.
 */

import nodemailer from 'nodemailer';
import type { CorrelationEnvelope } from '@footnote/contracts';
import type { RuntimeConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

const DISCORD_MESSAGE_CHAR_LIMIT = 1900;

export type IncidentAlertEvent = {
    type: 'incident';
    action:
        | 'incident.created'
        | 'incident.status_changed'
        | 'incident.note_added'
        | 'incident.remediated';
    incidentId: string;
    status: string;
    responseId: string | null;
    tags: string[];
    description: string | null;
    remediationState: string;
    correlation: CorrelationEnvelope;
};

export type BreakerAlertEvent = {
    type: 'breaker';
    action: 'chat.orchestration.breaker_action_applied';
    surface: 'web' | 'discord';
    breakerAction: string;
    ruleId: string;
    reasonCode: string;
    reason: string;
    safetyTier: string;
    responseId: string | null;
    correlation: CorrelationEnvelope;
};

export type IncidentAlertEventPayload = IncidentAlertEvent | BreakerAlertEvent;

type DiscordDeliveryInput = {
    botToken: string;
    channelId: string;
    roleId: string | null;
    content: string;
};

type EmailDeliveryInput = {
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUsername: string | null;
    smtpPassword: string | null;
    from: string;
    to: string[];
    subject: string;
    text: string;
};

type CreateIncidentAlertRouterOptions = {
    config: RuntimeConfig['alerts'];
    sendDiscord?: (input: DiscordDeliveryInput) => Promise<void>;
    sendEmail?: (input: EmailDeliveryInput) => Promise<void>;
    onDeliveryFailure?: (meta: {
        alertChannel: 'discord' | 'email';
        alertType: IncidentAlertEventPayload['type'];
        alertAction: IncidentAlertEventPayload['action'];
        error: string;
    }) => void;
};

const incidentAlertLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'incidentAlerts' })
        : logger;

const truncateForDiscord = (value: string): string =>
    value.length <= DISCORD_MESSAGE_CHAR_LIMIT
        ? value
        : `${value.slice(0, DISCORD_MESSAGE_CHAR_LIMIT - 3)}...`;

const formatCorrelation = (correlation: CorrelationEnvelope): string =>
    [
        `conversationId=${correlation.conversationId ?? 'none'}`,
        `requestId=${correlation.requestId ?? 'none'}`,
        `incidentId=${correlation.incidentId ?? 'none'}`,
        `responseId=${correlation.responseId ?? 'none'}`,
    ].join(' ');

const formatDiscordMessage = (event: IncidentAlertEventPayload): string => {
    if (event.type === 'incident') {
        return truncateForDiscord(
            [
                `Footnote incident alert`,
                `action=${event.action}`,
                `incidentId=${event.incidentId}`,
                `status=${event.status}`,
                `remediationState=${event.remediationState}`,
                `tags=${event.tags.join(',') || 'none'}`,
                `responseId=${event.responseId ?? 'none'}`,
                `description=${event.description ?? 'none'}`,
                formatCorrelation(event.correlation),
            ].join('\n')
        );
    }

    return truncateForDiscord(
        [
            `Footnote breaker alert`,
            `action=${event.action}`,
            `surface=${event.surface}`,
            `breakerAction=${event.breakerAction}`,
            `ruleId=${event.ruleId}`,
            `reasonCode=${event.reasonCode}`,
            `reason=${event.reason}`,
            `safetyTier=${event.safetyTier}`,
            `responseId=${event.responseId ?? 'none'}`,
            formatCorrelation(event.correlation),
        ].join('\n')
    );
};

const formatEmail = (
    event: IncidentAlertEventPayload
): { subject: string; text: string } => {
    if (event.type === 'incident') {
        return {
            subject: `[Footnote][Incident] ${event.action} ${event.incidentId}`,
            text: [
                'Footnote incident alert',
                `action: ${event.action}`,
                `incidentId: ${event.incidentId}`,
                `status: ${event.status}`,
                `remediationState: ${event.remediationState}`,
                `tags: ${event.tags.join(', ') || 'none'}`,
                `responseId: ${event.responseId ?? 'none'}`,
                `description: ${event.description ?? 'none'}`,
                `correlation: ${formatCorrelation(event.correlation)}`,
            ].join('\n'),
        };
    }

    return {
        subject: `[Footnote][Breaker] ${event.breakerAction} (${event.reasonCode})`,
        text: [
            'Footnote breaker alert',
            `action: ${event.action}`,
            `surface: ${event.surface}`,
            `breakerAction: ${event.breakerAction}`,
            `ruleId: ${event.ruleId}`,
            `reasonCode: ${event.reasonCode}`,
            `reason: ${event.reason}`,
            `safetyTier: ${event.safetyTier}`,
            `responseId: ${event.responseId ?? 'none'}`,
            `correlation: ${formatCorrelation(event.correlation)}`,
        ].join('\n'),
    };
};

const defaultDiscordSender = async ({
    botToken,
    channelId,
    roleId,
    content,
}: DiscordDeliveryInput): Promise<void> => {
    const messageContent = roleId ? `<@&${roleId}> ${content}` : content;
    const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bot ${botToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                content: messageContent,
                allowed_mentions: roleId
                    ? {
                          parse: [],
                          roles: [roleId],
                      }
                    : {
                          parse: [],
                      },
            }),
        }
    );

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Discord API returned ${response.status}: ${body.slice(0, 200)}`
        );
    }
};

const defaultEmailSender = async ({
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUsername,
    smtpPassword,
    from,
    to,
    subject,
    text,
}: EmailDeliveryInput): Promise<void> => {
    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        ...(smtpUsername && smtpPassword
            ? {
                  auth: {
                      user: smtpUsername,
                      pass: smtpPassword,
                  },
              }
            : {}),
    });

    await transporter.sendMail({
        from,
        to,
        subject,
        text,
    });
};

/**
 * Builds fail-open incident/breaker alert routing.
 */
export const createIncidentAlertRouter = ({
    config,
    sendDiscord = defaultDiscordSender,
    sendEmail = defaultEmailSender,
    onDeliveryFailure,
}: CreateIncidentAlertRouterOptions) => {
    const notify = async (event: IncidentAlertEventPayload): Promise<void> => {
        const deliveries: Promise<void>[] = [];
        const discordMessage = formatDiscordMessage(event);
        const emailContent = formatEmail(event);

        if (
            config.discord.enabled &&
            config.discord.botToken &&
            config.discord.channelId
        ) {
            deliveries.push(
                sendDiscord({
                    botToken: config.discord.botToken,
                    channelId: config.discord.channelId,
                    roleId: config.discord.roleId,
                    content: discordMessage,
                }).catch((error: unknown) => {
                    const errorMessage =
                        error instanceof Error ? error.message : String(error);
                    const failureMeta = {
                        alertChannel: 'discord' as const,
                        alertType: event.type,
                        alertAction: event.action,
                        error: errorMessage,
                    };
                    onDeliveryFailure?.(failureMeta);
                    incidentAlertLogger.warn('incident alert delivery failed', {
                        event: 'incident.alert.delivery_failed',
                        ...failureMeta,
                    });
                })
            );
        }

        if (
            config.email.enabled &&
            config.email.smtpHost &&
            config.email.from &&
            config.email.to.length > 0
        ) {
            deliveries.push(
                sendEmail({
                    smtpHost: config.email.smtpHost,
                    smtpPort: config.email.smtpPort,
                    smtpSecure: config.email.smtpSecure,
                    smtpUsername: config.email.smtpUsername,
                    smtpPassword: config.email.smtpPassword,
                    from: config.email.from,
                    to: config.email.to,
                    subject: emailContent.subject,
                    text: emailContent.text,
                }).catch((error: unknown) => {
                    const errorMessage =
                        error instanceof Error ? error.message : String(error);
                    const failureMeta = {
                        alertChannel: 'email' as const,
                        alertType: event.type,
                        alertAction: event.action,
                        error: errorMessage,
                    };
                    onDeliveryFailure?.(failureMeta);
                    incidentAlertLogger.warn('incident alert delivery failed', {
                        event: 'incident.alert.delivery_failed',
                        ...failureMeta,
                    });
                })
            );
        }

        if (deliveries.length === 0) {
            return;
        }

        await Promise.all(deliveries);
    };

    return {
        notify,
    };
};

export type IncidentAlertRouter = ReturnType<typeof createIncidentAlertRouter>;
