/**
 * @description: Developer-only slash command that renders an isolated TRACE card image for visual experiments.
 * @footnote-scope: interface
 * @footnote-module: TracePreviewCommand
 * @footnote-risk: low - This command is isolated and does not modify production provenance paths.
 * @footnote-ethics: medium - Experimental TRACE presentation can influence trust perception if mislabeled.
 */
import {
    AttachmentBuilder,
    ChatInputCommandInteraction,
    SlashCommandBuilder,
} from 'discord.js';
import type {
    ResponseTemperament,
    TraceAxisScore,
} from '@footnote/contracts/ethics-core';
import { botApi } from '../api/botApi.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Command } from './BaseCommand.js';

const tracePreviewLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'tracePreviewCommand' })
        : logger;

const TRACE_PREVIEW_FILENAME = 'trace-card.png';
const EPHEMERAL_FLAG = 1 << 6;

/**
 * Narrows a runtime number to the TRACE axis score type.
 * Slash-command min/max guards already constrain this range.
 */
const toTraceAxisScore = (value: number): TraceAxisScore =>
    Math.max(1, Math.min(10, Math.round(value))) as TraceAxisScore;

/**
 * Slash-command definition and handler for the isolated TRACE preview experiment.
 * This stays intentionally separate from production provenance rendering.
 */
const command: Command = {
    data: new SlashCommandBuilder()
        .setName('trace-preview')
        .setDescription(
            'Render an experimental TRACE card image (developer only).'
        )
        .addIntegerOption((option) =>
            option
                .setName('tightness')
                .setDescription('T axis: concision and structural efficiency.')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(10)
        )
        .addIntegerOption((option) =>
            option
                .setName('rationale')
                .setDescription(
                    'R axis: amount of visible rationale and trade-off explanation.'
                )
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(10)
        )
        .addIntegerOption((option) =>
            option
                .setName('attribution')
                .setDescription(
                    'A axis: clarity between sourced and inferred content.'
                )
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(10)
        )
        .addIntegerOption((option) =>
            option
                .setName('caution')
                .setDescription(
                    'C axis: safeguard posture and overclaim restraint.'
                )
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(10)
        )
        .addIntegerOption((option) =>
            option
                .setName('extent')
                .setDescription(
                    'E axis: breadth of viable options and perspectives.'
                )
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(10)
        ),

    /**
     * Requests and returns one experimental TRACE card from backend rendering.
     * This command intentionally avoids touching production provenance flows.
     */
    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        if (interaction.user.id !== runtimeConfig.developerUserId) {
            await interaction.reply({
                content:
                    'This command is currently developer-only while TRACE UI experiments are in progress.',
                flags: [EPHEMERAL_FLAG],
            });
            return;
        }

        try {
            const temperament: ResponseTemperament = {
                tightness: toTraceAxisScore(
                    interaction.options.getInteger('tightness', true)
                ),
                rationale: toTraceAxisScore(
                    interaction.options.getInteger('rationale', true)
                ),
                attribution: toTraceAxisScore(
                    interaction.options.getInteger('attribution', true)
                ),
                caution: toTraceAxisScore(
                    interaction.options.getInteger('caution', true)
                ),
                extent: toTraceAxisScore(
                    interaction.options.getInteger('extent', true)
                ),
            };
            const traceCard = await botApi.postTraceCard({
                temperament,
            });
            const pngBuffer = Buffer.from(traceCard.pngBase64, 'base64');

            const attachment = new AttachmentBuilder(pngBuffer, {
                name: TRACE_PREVIEW_FILENAME,
            });

            await interaction.reply({
                files: [attachment],
                flags: [EPHEMERAL_FLAG],
            });
        } catch (error) {
            tracePreviewLogger.error(
                'Failed to generate TRACE preview trace-card command response.',
                {
                    userId: interaction.user.id,
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content:
                        'TRACE preview failed to render. Check logs for details.',
                    flags: [EPHEMERAL_FLAG],
                });
                return;
            }

            await interaction.reply({
                content:
                    'TRACE preview failed to render. Check logs for details.',
                flags: [EPHEMERAL_FLAG],
            });
        }
    },
};

export default command;
