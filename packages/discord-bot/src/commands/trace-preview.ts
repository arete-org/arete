/**
 * @description: Developer-only slash command that renders an isolated TRACE preview SVG for visual experiments.
 * @footnote-scope: interface
 * @footnote-module: TracePreviewCommand
 * @footnote-risk: low - This command is isolated and does not modify production provenance paths.
 * @footnote-ethics: medium - Experimental TRACE presentation can influence trust perception if mislabeled.
 */
import {
    AttachmentBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
} from 'discord.js';
import type {
    ResponseTemperament,
    TraceAxisScore,
    RiskTier,
} from '@footnote/contracts/ethics-core';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { renderTracePreviewSvg } from '../utils/tracePreview/tracePreviewSvg.js';
import type { Command } from './BaseCommand.js';

const tracePreviewLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'tracePreviewCommand' })
        : logger;

const TRACE_PREVIEW_FILENAME = 'trace-preview.svg';
const EPHEMERAL_FLAG = 1 << 6;

/**
 * Converts a slash-command option value into a validated RiskTier literal.
 * Returns undefined for any unexpected input to keep command handling fail-open.
 */
const parseRiskTier = (value: string | null): RiskTier | undefined => {
    if (value === 'Low' || value === 'Medium' || value === 'High') {
        return value;
    }
    return undefined;
};

/**
 * Produces a compact one-line axis summary used in embed descriptions.
 */
const formatAxisSummary = (temperament: ResponseTemperament): string =>
    `T${temperament.tightness} R${temperament.rationale} A${temperament.attribution} C${temperament.caution} E${temperament.extent}`;

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
            'Render an experimental TRACE wheel/card SVG (developer only).'
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
        )
        .addIntegerOption((option) =>
            option
                .setName('confidence_pct')
                .setDescription('Optional confidence chip value (0-100).')
                .setRequired(false)
                .setMinValue(0)
                .setMaxValue(100)
        )
        .addStringOption((option) =>
            option
                .setName('risk_tier')
                .setDescription('Optional risk tier chip.')
                .setRequired(false)
                .addChoices(
                    { name: 'Low', value: 'Low' },
                    { name: 'Medium', value: 'Medium' },
                    { name: 'High', value: 'High' }
                )
        )
        .addIntegerOption((option) =>
            option
                .setName('tradeoff_count')
                .setDescription('Optional trade-off count chip.')
                .setRequired(false)
                .setMinValue(0)
                .setMaxValue(99)
        ),

    /**
     * Renders and returns one experimental TRACE preview card.
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
            const confidencePercent =
                interaction.options.getInteger('confidence_pct');
            const tradeoffCount =
                interaction.options.getInteger('tradeoff_count');
            const riskTier = parseRiskTier(
                interaction.options.getString('risk_tier')
            );

            const svg = renderTracePreviewSvg({
                temperament,
                chips: {
                    confidencePercent:
                        typeof confidencePercent === 'number'
                            ? confidencePercent
                            : undefined,
                    tradeoffCount:
                        typeof tradeoffCount === 'number'
                            ? tradeoffCount
                            : undefined,
                    riskTier,
                },
            });

            const attachment = new AttachmentBuilder(Buffer.from(svg, 'utf8'), {
                name: TRACE_PREVIEW_FILENAME,
            });

            const previewEmbed = new EmbedBuilder()
                .setTitle('TRACE Preview (Experimental)')
                .setColor(0x334155)
                .setDescription(
                    [
                        'This is an isolated experiment and is not wired into the production provenance footer.',
                        `Axes: ${formatAxisSummary(temperament)}`,
                    ].join('\n')
                )
                .setImage(`attachment://${TRACE_PREVIEW_FILENAME}`)
                .setFooter({
                    text: 'Developer-only experiment • TODO(TRACE-rollout): integrate after validation',
                });

            await interaction.reply({
                embeds: [previewEmbed],
                files: [attachment],
                flags: [EPHEMERAL_FLAG],
            });
        } catch (error) {
            tracePreviewLogger.error(
                'Failed to generate TRACE preview SVG command response.',
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
