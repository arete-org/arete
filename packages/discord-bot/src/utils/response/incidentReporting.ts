/**
 * @description: Drives the consented Discord incident report flow and forwards durable incident state updates to the backend.
 * @footnote-scope: interface
 * @footnote-module: IncidentReporting
 * @footnote-risk: high - Incorrect flow handling can lose reports or misreport remediation status.
 * @footnote-ethics: high - This flow governs user consent, privacy-sensitive reporting, and visible remediation.
 */
import type {
    ButtonInteraction,
    InteractionReplyOptions,
    Message,
    ModalSubmitInteraction,
} from 'discord.js';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { logger } from '../logger.js';
import { botApi, isDiscordApiClientError } from '../../api/botApi.js';
import {
    remediateReportedAssistantMessage,
    type IncidentRemediationOutcome,
} from './incidentRemediation.js';
import {
    resolveProvenanceMetadata,
    resolveResponseAnchorMessage,
    safeInteractionReply,
} from './provenanceInteractions.js';

const incidentReportLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'incidentReporting' })
        : logger;

const INCIDENT_REPORT_SESSION_TTL_MS = 15 * 60_000;
const EPHEMERAL_FLAG = 1 << 6;

export const INCIDENT_REPORT_CONSENT_PREFIX = 'incident_report_consent:';
export const INCIDENT_REPORT_CANCEL_PREFIX = 'incident_report_cancel:';
export const INCIDENT_REPORT_MODAL_PREFIX = 'incident_report_modal:';
export const INCIDENT_REPORT_TAGS_INPUT_ID = 'incident_report_tags';
export const INCIDENT_REPORT_DESCRIPTION_INPUT_ID =
    'incident_report_description';
export const INCIDENT_REPORT_CONTACT_INPUT_ID = 'incident_report_contact';

type IncidentReportSession = {
    sourceMessageId: string;
    targetMessageId?: string;
    channelId: string;
    guildId?: string;
    responseId?: string;
    chainHash?: string;
    modelVersion?: string;
    jumpUrl?: string;
};

type IncidentReportSessionRecord = {
    session: IncidentReportSession;
    expiresAt: number;
};

// Keep short-lived consent state in memory so we can bridge the button click
// and modal submit without persisting anything before the user consents.
const sessions = new Map<string, IncidentReportSessionRecord>();

const buildIncidentReportSessionKey = (
    userId: string,
    sourceMessageId: string
): string => `${userId}:${sourceMessageId}`;

const getSessionExpiry = (): number => Date.now() + INCIDENT_REPORT_SESSION_TTL_MS;

const clearIncidentReportSession = (sessionKey: string): void => {
    sessions.delete(sessionKey);
};

const pruneExpiredSessions = (): void => {
    const now = Date.now();
    for (const [sessionKey, record] of sessions) {
        if (record.expiresAt <= now) {
            sessions.delete(sessionKey);
        }
    }
};

const getIncidentReportSession = (
    sessionKey: string
): IncidentReportSession | undefined => {
    pruneExpiredSessions();
    const record = sessions.get(sessionKey);
    if (!record) {
        return undefined;
    }
    if (record.expiresAt <= Date.now()) {
        sessions.delete(sessionKey);
        return undefined;
    }
    return record.session;
};

const setIncidentReportSession = (
    sessionKey: string,
    session: IncidentReportSession
): void => {
    pruneExpiredSessions();
    sessions.set(sessionKey, {
        session,
        expiresAt: getSessionExpiry(),
    });
};

/**
 * Parses free-form comma-separated tags from the modal into a clean unique list
 * before sending them to the backend.
 */
const parseTagInput = (value: string): string[] =>
    [...new Set(
        value
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0)
    )];

/**
 * Keeps API errors readable in ephemeral replies and structured logs.
 */
const formatApiError = (error: unknown): string => {
    if (isDiscordApiClientError(error)) {
        return error.details ? `${error.message} (${error.details})` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
};

/**
 * Builds a log payload without forcing every handler to repeat the same
 * interaction metadata.
 */
const buildLogContext = (
    interaction: ButtonInteraction | ModalSubmitInteraction,
    extra?: Record<string, unknown>
): Record<string, unknown> => ({
    userId: interaction.user.id,
    guildId: interaction.guildId ?? null,
    channelId: interaction.channelId ?? null,
    messageId: 'message' in interaction && interaction.message
        ? interaction.message.id
        : null,
    ...extra,
});

/**
 * Wraps the shared safe reply helper so the report flow can keep user-facing
 * actions and log labels close together.
 */
const getReplyMessage = async (
    interaction: ButtonInteraction,
    payload: InteractionReplyOptions,
    logContext: Record<string, unknown>,
    logLabel: string
): Promise<void> => {
    await safeInteractionReply(interaction, payload, logContext, logLabel);
};

/**
 * Starts the report flow by collecting the best available provenance pointers,
 * then asking for explicit consent before any durable write happens.
 */
export const handleIncidentReportButton = async (
    interaction: ButtonInteraction
): Promise<void> => {
    const logContext = buildLogContext(interaction);
    const anchorMessage = await resolveResponseAnchorMessage(interaction.message);
    const { responseId, metadata } = await resolveProvenanceMetadata(
        interaction.message
    );

    const sessionKey = buildIncidentReportSessionKey(
        interaction.user.id,
        interaction.message.id
    );
    setIncidentReportSession(sessionKey, {
        sourceMessageId: interaction.message.id,
        targetMessageId: anchorMessage?.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId ?? undefined,
        responseId,
        chainHash: metadata?.chainHash,
        modelVersion: metadata?.modelVersion,
        jumpUrl: anchorMessage?.url,
    });

    const warningSuffix = anchorMessage
        ? ''
        : '\n\nI may not be able to hide the target message automatically if I cannot recover the original assistant message.';

    await getReplyMessage(
        interaction,
        {
            content:
                `Reporting this message will create a durable incident record for maintainers to review.${warningSuffix}`,
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(
                            `${INCIDENT_REPORT_CONSENT_PREFIX}${interaction.message.id}`
                        )
                        .setLabel('I consent')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId(
                            `${INCIDENT_REPORT_CANCEL_PREFIX}${interaction.message.id}`
                        )
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary)
                ),
            ],
            flags: [EPHEMERAL_FLAG],
        },
        logContext,
        'incident_report_prompt'
    );
};

/**
 * Cancels the current report flow and drops the in-memory session.
 */
export const handleIncidentReportCancel = async (
    interaction: ButtonInteraction
): Promise<void> => {
    const sourceMessageId = interaction.customId.slice(
        INCIDENT_REPORT_CANCEL_PREFIX.length
    );
    clearIncidentReportSession(
        buildIncidentReportSessionKey(interaction.user.id, sourceMessageId)
    );
    await interaction.update({
        content: 'Incident report cancelled. No record was created.',
        components: [],
    });
};

/**
 * Opens the optional-details modal after the user confirms consent.
 */
export const handleIncidentReportConsent = async (
    interaction: ButtonInteraction
): Promise<void> => {
    const sourceMessageId = interaction.customId.slice(
        INCIDENT_REPORT_CONSENT_PREFIX.length
    );
    const session = getIncidentReportSession(
        buildIncidentReportSessionKey(interaction.user.id, sourceMessageId)
    );
    if (!session) {
        await interaction.reply({
            content: 'That report session expired. Please click Report Issue again.',
            flags: [EPHEMERAL_FLAG],
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`${INCIDENT_REPORT_MODAL_PREFIX}${sourceMessageId}`)
        .setTitle('Report Issue')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(INCIDENT_REPORT_TAGS_INPUT_ID)
                    .setLabel('Tags (optional, comma separated)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(250)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(INCIDENT_REPORT_DESCRIPTION_INPUT_ID)
                    .setLabel('Description (optional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(1000)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(INCIDENT_REPORT_CONTACT_INPUT_ID)
                    .setLabel('Contact (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(250)
            )
        );

    await interaction.showModal(modal);
};

/**
 * Submits the durable incident report, attempts the immediate Discord-side
 * remediation, and then sends the remediation outcome back to the backend.
 */
export const handleIncidentReportModal = async (
    interaction: ModalSubmitInteraction
): Promise<void> => {
    const sourceMessageId = interaction.customId.slice(
        INCIDENT_REPORT_MODAL_PREFIX.length
    );
    const sessionKey = buildIncidentReportSessionKey(
        interaction.user.id,
        sourceMessageId
    );
    const session = getIncidentReportSession(sessionKey);
    if (!session) {
        await interaction.reply({
            content: 'That report session expired. Please click Report Issue again.',
            flags: [EPHEMERAL_FLAG],
        });
        return;
    }

    const tags = parseTagInput(
        interaction.fields.getTextInputValue(INCIDENT_REPORT_TAGS_INPUT_ID)
    );
    const description = interaction.fields
        .getTextInputValue(INCIDENT_REPORT_DESCRIPTION_INPUT_ID)
        .trim();
    const contact = interaction.fields
        .getTextInputValue(INCIDENT_REPORT_CONTACT_INPUT_ID)
        .trim();

    const logContext = buildLogContext(interaction, {
        sourceMessageId,
        targetMessageId: session.targetMessageId ?? null,
        responseId: session.responseId ?? null,
    });
    let replyDeferred = false;

    try {
        await interaction.deferReply({
            flags: [EPHEMERAL_FLAG],
        });
        replyDeferred = true;

        const reportResponse = await botApi.reportIncident({
            reporterUserId: interaction.user.id,
            guildId: session.guildId,
            channelId: session.channelId,
            messageId: session.targetMessageId,
            jumpUrl: session.jumpUrl,
            responseId: session.responseId,
            chainHash: session.chainHash,
            modelVersion: session.modelVersion,
            tags,
            description: description || undefined,
            contact: contact || undefined,
            consentedAt: new Date().toISOString(),
        });

        let remediationOutcome: IncidentRemediationOutcome = {
            state: 'failed',
            notes: 'Could not fetch the target message for remediation.',
        };

        if (session.targetMessageId && interaction.channel?.isTextBased()) {
            try {
                const targetMessage = (await interaction.channel.messages.fetch(
                    session.targetMessageId
                )) as Message;
                remediationOutcome =
                    await remediateReportedAssistantMessage(targetMessage);
            } catch (error) {
                remediationOutcome = {
                    state: 'failed',
                    notes: `Could not fetch the target message for remediation: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        }

        try {
            await botApi.recordIncidentRemediation(
                reportResponse.incident.incidentId,
                {
                    actorUserId: interaction.user.id,
                    state: remediationOutcome.state,
                    notes: remediationOutcome.notes,
                }
            );
        } catch (error) {
            incidentReportLogger.error(
                'Failed to persist incident remediation outcome',
                {
                    ...logContext,
                    incidentId: reportResponse.incident.incidentId,
                    remediationState: remediationOutcome.state,
                    error: formatApiError(error),
                }
            );
            remediationOutcome = {
                state: 'failed',
                notes:
                    'The incident was stored, but remediation tracking could not be saved.',
            };
        }

        clearIncidentReportSession(sessionKey);
        try {
            await interaction.deleteReply();
        } catch (deleteError) {
            incidentReportLogger.warn(
                'Failed to remove success confirmation for incident report',
                {
                    ...logContext,
                    incidentId: reportResponse.incident.incidentId,
                    remediationState: remediationOutcome.state,
                    error: formatApiError(deleteError),
                }
            );
        }
    } catch (error) {
        incidentReportLogger.error('Failed to submit incident report', {
            ...logContext,
            error: formatApiError(error),
        });
        clearIncidentReportSession(sessionKey);
        if (replyDeferred) {
            await interaction.editReply({
                content: `I could not create that incident report: ${formatApiError(error)}`,
            });
            return;
        }

        await interaction.reply({
            content: `I could not create that incident report: ${formatApiError(error)}`,
            flags: [EPHEMERAL_FLAG],
        });
    }
};
