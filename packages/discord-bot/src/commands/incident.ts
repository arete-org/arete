/**
 * @description: Private Discord slash commands for superusers to review and update incidents through the backend admin APIs.
 * @footnote-scope: interface
 * @footnote-module: IncidentCommand
 * @footnote-risk: high - Incorrect authorization or formatting can expose incident review data to the wrong users.
 * @footnote-ethics: high - Incident review commands surface sensitive reports and remediation state.
 */
import {
    ChatInputCommandInteraction,
    MessageFlags,
    SlashCommandBuilder,
} from 'discord.js';
import type { IncidentDetail, IncidentSummary } from '@footnote/contracts/web';
import { botApi, isDiscordApiClientError } from '../api/botApi.js';
import { logger } from '../utils/logger.js';
import { isIncidentSuperuser } from '../utils/incidentSuperusers.js';
import type { Command } from './BaseCommand.js';

const incidentCommandLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'incidentCommand' })
        : logger;

const EPHEMERAL_FLAG = MessageFlags.Ephemeral;
const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const INCIDENT_STATUS_CHOICES: IncidentSummary['status'][] = [
    'new',
    'under_review',
    'confirmed',
    'dismissed',
    'resolved',
];

/**
 * Shortens long hashes so operator replies stay readable without exposing more
 * of the digest than they need.
 */
const shorten = (value: string | undefined, length = 12): string | null => {
    if (!value) {
        return null;
    }
    return value.length <= length ? value : value.slice(0, length);
};

/**
 * Trims command output to fit Discord's message limit. This protects `/incident
 * view` from failing when descriptions or audit notes are long.
 */
const limitDiscordMessage = (value: string): string => {
    if (value.length <= DISCORD_MESSAGE_MAX_LENGTH) {
        return value;
    }

    return `${value.slice(0, DISCORD_MESSAGE_MAX_LENGTH - 16)}\n... (truncated)`;
};

/**
 * Renders one compact block for `/incident list`.
 */
const formatIncidentSummary = (incident: IncidentSummary): string => {
    const lines = [
        `**${incident.incidentId}**`,
        `Status: ${incident.status}`,
        `Tags: ${incident.tags.join(', ') || 'none'}`,
        `Created: ${incident.createdAt}`,
    ];
    if (incident.pointers.responseId) {
        lines.push(`Response ID: ${incident.pointers.responseId}`);
    }
    if (incident.remediation.updatedAt) {
        lines.push(
            `Remediation: ${incident.remediation.state} (${incident.remediation.updatedAt})`
        );
    } else {
        lines.push(`Remediation: ${incident.remediation.state}`);
    }
    return lines.join('\n');
};

/**
 * Renders the private operator view for one incident. Hashes stay shortened and
 * only the newest audit entries are shown to keep the reply scannable.
 */
const formatIncidentDetail = (incident: IncidentDetail): string => {
    const pointerLines = [
        incident.pointers.responseId
            ? `Response ID: ${incident.pointers.responseId}`
            : null,
        incident.pointers.guildId
            ? `Guild hash: ${shorten(incident.pointers.guildId)}`
            : null,
        incident.pointers.channelId
            ? `Channel hash: ${shorten(incident.pointers.channelId)}`
            : null,
        incident.pointers.messageId
            ? `Message hash: ${shorten(incident.pointers.messageId)}`
            : null,
        incident.pointers.modelVersion
            ? `Model: ${incident.pointers.modelVersion}`
            : null,
        incident.pointers.chainHash
            ? `Chain hash: ${shorten(incident.pointers.chainHash, 16)}`
            : null,
    ].filter((line): line is string => Boolean(line));

    const auditLines = incident.auditEvents.slice(-6).map((event) => {
        const actor = event.actorHash ? ` actor=${shorten(event.actorHash)}` : '';
        const notes = event.notes ? ` notes=${event.notes}` : '';
        return `- ${event.createdAt} ${event.action}${actor}${notes}`;
    });

    return [
        `**Incident ${incident.incidentId}**`,
        `Status: ${incident.status}`,
        `Tags: ${incident.tags.join(', ') || 'none'}`,
        `Created: ${incident.createdAt}`,
        `Updated: ${incident.updatedAt}`,
        `Consented: ${incident.consentedAt}`,
        `Description: ${incident.description ?? 'none'}`,
        `Contact: ${incident.contact ?? 'none'}`,
        `Remediation: ${incident.remediation.state}`,
        `Remediation applied: ${incident.remediation.applied ? 'yes' : 'no'}`,
        `Remediation notes: ${incident.remediation.notes ?? 'none'}`,
        `Remediation updated: ${incident.remediation.updatedAt ?? 'none'}`,
        pointerLines.length > 0 ? pointerLines.join('\n') : 'Pointers: none',
        auditLines.length > 0
            ? `Audit:\n${auditLines.join('\n')}`
            : 'Audit: none',
    ].join('\n');
};

/**
 * Turns backend client errors into one readable line for both Discord replies
 * and structured logs.
 */
const formatApiError = (error: unknown): string => {
    if (isDiscordApiClientError(error)) {
        return error.details ? `${error.message} (${error.details})` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
};

const incidentCommand: Command = {
    data: new SlashCommandBuilder()
        .setName('incident')
        .setDescription('Review and update incident reports (superusers only).')
        .addSubcommand((subcommand) =>
            subcommand
                .setName('list')
                .setDescription('List recent incidents.')
                .addStringOption((option) =>
                    option
                        .setName('status')
                        .setDescription('Optional status filter.')
                        .setRequired(false)
                        .addChoices(
                            ...INCIDENT_STATUS_CHOICES.map((status) => ({
                                name: status,
                                value: status,
                            }))
                        )
                )
                .addStringOption((option) =>
                    option
                        .setName('tag')
                        .setDescription('Optional exact tag filter.')
                        .setRequired(false)
                )
                .addStringOption((option) =>
                    option
                        .setName('created_from')
                        .setDescription('Optional ISO date lower bound.')
                        .setRequired(false)
                )
                .addStringOption((option) =>
                    option
                        .setName('created_to')
                        .setDescription('Optional ISO date upper bound.')
                        .setRequired(false)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('view')
                .setDescription('View one incident by short ID.')
                .addStringOption((option) =>
                    option
                        .setName('incident_id')
                        .setDescription('Incident short ID.')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('status')
                .setDescription('Update incident status.')
                .addStringOption((option) =>
                    option
                        .setName('incident_id')
                        .setDescription('Incident short ID.')
                        .setRequired(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('status')
                        .setDescription('New incident status.')
                        .setRequired(true)
                        .addChoices(
                            ...INCIDENT_STATUS_CHOICES.map((status) => ({
                                name: status,
                                value: status,
                            }))
                        )
                )
                .addStringOption((option) =>
                    option
                        .setName('note')
                        .setDescription('Optional audit note for this change.')
                        .setRequired(false)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('note')
                .setDescription('Append an internal note to an incident.')
                .addStringOption((option) =>
                    option
                        .setName('incident_id')
                        .setDescription('Incident short ID.')
                        .setRequired(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('note')
                        .setDescription('Internal note to append.')
                        .setRequired(true)
                )
        ),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        if (!isIncidentSuperuser(interaction.user.id)) {
            await interaction.reply({
                content:
                    'You do not have permission to use incident review commands.',
                flags: [EPHEMERAL_FLAG],
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand(true);

        try {
            switch (subcommand) {
                case 'list': {
                    const response = await botApi.listIncidents({
                        status: interaction.options.getString('status') ?? undefined,
                        tag: interaction.options.getString('tag') ?? undefined,
                        createdFrom:
                            interaction.options.getString('created_from') ??
                            undefined,
                        createdTo:
                            interaction.options.getString('created_to') ??
                            undefined,
                    });
                    const content =
                        response.incidents.length > 0
                            ? limitDiscordMessage(
                                  response.incidents
                                      .slice(0, 10)
                                      .map(formatIncidentSummary)
                                      .join('\n\n')
                              )
                            : 'No incidents matched the current filters.';
                    await interaction.reply({
                        content,
                        flags: [EPHEMERAL_FLAG],
                    });
                    return;
                }
                case 'view': {
                    const incidentId = interaction.options.getString(
                        'incident_id',
                        true
                    );
                    const response = await botApi.getIncident(incidentId);
                    await interaction.reply({
                        content: limitDiscordMessage(
                            formatIncidentDetail(response.incident)
                        ),
                        flags: [EPHEMERAL_FLAG],
                    });
                    return;
                }
                case 'status': {
                    const incidentId = interaction.options.getString(
                        'incident_id',
                        true
                    );
                    const status = interaction.options.getString(
                        'status',
                        true
                    ) as IncidentSummary['status'];
                    const note = interaction.options.getString('note') ?? undefined;
                    const response = await botApi.updateIncidentStatus(incidentId, {
                        status,
                        actorUserId: interaction.user.id,
                        notes: note,
                    });
                    await interaction.reply({
                        content: `Updated **${response.incident.incidentId}** to **${response.incident.status}**.`,
                        flags: [EPHEMERAL_FLAG],
                    });
                    return;
                }
                case 'note': {
                    const incidentId = interaction.options.getString(
                        'incident_id',
                        true
                    );
                    const note = interaction.options.getString('note', true);
                    const response = await botApi.addIncidentNote(incidentId, {
                        actorUserId: interaction.user.id,
                        notes: note,
                    });
                    await interaction.reply({
                        content: `Added a note to **${response.incident.incidentId}**.`,
                        flags: [EPHEMERAL_FLAG],
                    });
                    return;
                }
                default:
                    await interaction.reply({
                        content: 'Unsupported incident subcommand.',
                        flags: [EPHEMERAL_FLAG],
                    });
            }
        } catch (error) {
            incidentCommandLogger.error('Incident command failed', {
                userId: interaction.user.id,
                subcommand,
                error: formatApiError(error),
            });
            await interaction.reply({
                content: `Incident command failed: ${formatApiError(error)}`,
                flags: [EPHEMERAL_FLAG],
            });
        }
    },
};

export default incidentCommand;
