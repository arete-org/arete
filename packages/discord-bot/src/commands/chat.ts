/**
 * @description: Adds a slash-only one-shot chat command for fast profile/model switching.
 * @footnote-scope: interface
 * @footnote-module: ChatCommand
 * @footnote-risk: medium - Command wiring errors can misroute requests or hide backend chat failures.
 * @footnote-ethics: medium - Exposes backend profile selection to users and should remain transparent/fail-open.
 */
import {
    AttachmentBuilder,
    ChatInputCommandInteraction,
    SlashCommandBuilder,
} from 'discord.js';
import type {
    PartialResponseTemperament,
    ResponseMetadata,
    TraceAxisScore,
    WorkflowModeId,
} from '@footnote/contracts/policy';
import { botApi } from '../api/botApi.js';
import type { DiscordChatApiResponse } from '../api/index.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { buildProvenanceActionRow } from '../utils/response/provenanceCgi.js';
import type { ChatProfileOption } from '@footnote/contracts/web';
import type { Command, SlashCommand } from './BaseCommand.js';

const MAX_REPLY_LENGTH = 2000;

type ChatCommandWithProfiles = Command & {
    setProfileChoices: (_profiles: ChatProfileOption[]) => void;
};

const clampReplyContent = (content: string): string => {
    if (content.length <= MAX_REPLY_LENGTH) {
        return content;
    }

    return `${content.slice(0, MAX_REPLY_LENGTH - 3)}...`;
};

const buildChatCommandData = (): SlashCommand => {
    const builder = new SlashCommandBuilder()
        .setName('chat')
        .setDescription(
            'Send a one-shot prompt with optional workflow and TRACE tweaks'
        )
        .addStringOption((option) =>
            option
                .setName('prompt')
                .setDescription('Prompt to send to backend chat')
                .setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName('mode')
                .setDescription('Optional answer posture for this request')
                .addChoices(
                    { name: 'Grounded', value: 'grounded' },
                    { name: 'Balanced', value: 'balanced' }
                )
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName('max_review_cycles')
                .setDescription('Optional hard override for review cycle depth')
                .setMinValue(0)
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName('trace_tightness')
                .setDescription('TRACE tightness axis target (1-5)')
                .setMinValue(1)
                .setMaxValue(5)
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName('trace_rationale')
                .setDescription('TRACE rationale axis target (1-5)')
                .setMinValue(1)
                .setMaxValue(5)
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName('trace_attribution')
                .setDescription('TRACE attribution axis target (1-5)')
                .setMinValue(1)
                .setMaxValue(5)
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName('trace_caution')
                .setDescription('TRACE caution axis target (1-5)')
                .setMinValue(1)
                .setMaxValue(5)
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName('trace_extent')
                .setDescription('TRACE extent axis target (1-5)')
                .setMinValue(1)
                .setMaxValue(5)
                .setRequired(false)
        );

    return builder;
};

const toChatFailureMessage = (error: unknown): string =>
    error instanceof Error
        ? `Chat request failed: ${error.message}`
        : 'Chat request failed due to an unknown error.';

const renderNonMessageAction = (response: DiscordChatApiResponse): string => {
    switch (response.action) {
        case 'ignore':
            return 'No response generated for this request.';
        case 'react':
            return `Backend selected reaction mode (${response.reaction}). /chat currently returns text only.`;
        case 'image': {
            const prompt =
                typeof response.imageRequest === 'object' &&
                response.imageRequest &&
                typeof (response.imageRequest as { prompt?: unknown })
                    .prompt === 'string'
                    ? (response.imageRequest as { prompt: string }).prompt
                    : 'unavailable';
            return `Backend selected image mode. Prompt: "${prompt}"`;
        }
        default:
            return `Backend returned unsupported action "${response.action}".`;
    }
};

const hasResponseMetadata = (value: unknown): value is ResponseMetadata =>
    Boolean(
        value &&
        typeof value === 'object' &&
        typeof (value as { responseId?: unknown }).responseId === 'string'
    );

const buildChatDetailsPrefix = (options: {
    modeId: WorkflowModeId | null;
    maxReviewCycles?: number;
    traceTarget?: PartialResponseTemperament;
}): string => {
    const details: string[] = [];
    if (options.modeId) {
        details.push(`> mode: ${options.modeId}`);
    }
    if (options.maxReviewCycles !== undefined) {
        details.push(`> max_review_cycles: ${options.maxReviewCycles}`);
    }
    if (options.traceTarget?.tightness !== undefined) {
        details.push(`> trace_tightness: ${options.traceTarget.tightness}`);
    }
    if (options.traceTarget?.rationale !== undefined) {
        details.push(`> trace_rationale: ${options.traceTarget.rationale}`);
    }
    if (options.traceTarget?.attribution !== undefined) {
        details.push(`> trace_attribution: ${options.traceTarget.attribution}`);
    }
    if (options.traceTarget?.caution !== undefined) {
        details.push(`> trace_caution: ${options.traceTarget.caution}`);
    }
    if (options.traceTarget?.extent !== undefined) {
        details.push(`> trace_extent: ${options.traceTarget.extent}`);
    }

    if (details.length === 0) {
        return '';
    }

    return details.join('\n') + '\n\n';
};

const toTraceAxisScore = (
    value: number | null | undefined
): TraceAxisScore | undefined => {
    if (
        value === 1 ||
        value === 2 ||
        value === 3 ||
        value === 4 ||
        value === 5
    ) {
        return value;
    }
    return undefined;
};

const buildSearchUnavailablePrefix = (
    metadata: ResponseMetadata | null
): string => {
    // Mirror backend execution metadata so Discord users see the same search
    // degradation signal that web users see in provenance UI.
    const isSearchUnavailable = metadata?.execution?.some(
        (event) =>
            event.kind === 'tool' &&
            event.toolName === 'web_search' &&
            event.status === 'skipped' &&
            event.reasonCode === 'search_not_supported_by_selected_profile'
    );
    return isSearchUnavailable
        ? '⚠️ search unavailable for selected model\n\n'
        : '';
};

const chatCommand: ChatCommandWithProfiles = {
    data: buildChatCommandData(),
    setProfileChoices(_profiles: ChatProfileOption[]) {
        // /chat no longer exposes profile_id choices; keep method as no-op
        // to preserve startup wiring compatibility.
    },
    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply();

        const prompt = interaction.options.getString('prompt', true).trim();
        const modeId = interaction.options.getString(
            'mode'
        ) as WorkflowModeId | null;
        const maxReviewCycles =
            interaction.options.getInteger('max_review_cycles') ?? undefined;
        const traceTarget: PartialResponseTemperament = {};
        const traceTightness = toTraceAxisScore(
            interaction.options.getInteger('trace_tightness')
        );
        const traceRationale = toTraceAxisScore(
            interaction.options.getInteger('trace_rationale')
        );
        const traceAttribution = toTraceAxisScore(
            interaction.options.getInteger('trace_attribution')
        );
        const traceCaution = toTraceAxisScore(
            interaction.options.getInteger('trace_caution')
        );
        const traceExtent = toTraceAxisScore(
            interaction.options.getInteger('trace_extent')
        );
        if (traceTightness !== undefined) {
            traceTarget.tightness = traceTightness;
        }
        if (traceRationale !== undefined) {
            traceTarget.rationale = traceRationale;
        }
        if (traceAttribution !== undefined) {
            traceTarget.attribution = traceAttribution;
        }
        if (traceCaution !== undefined) {
            traceTarget.caution = traceCaution;
        }
        if (traceExtent !== undefined) {
            traceTarget.extent = traceExtent;
        }
        const hasTraceTarget = Object.keys(traceTarget).length > 0;

        try {
            const response = await botApi.chatViaApi({
                surface: 'discord',
                botPersonaId: runtimeConfig.profile.id,
                ...(modeId ? { modeId } : {}),
                ...(maxReviewCycles !== undefined && { maxReviewCycles }),
                ...(hasTraceTarget ? { traceTarget } : {}),
                trigger: {
                    kind: 'submit',
                    messageId: interaction.id,
                },
                latestUserInput: prompt,
                conversation: [{ role: 'user', content: prompt }],
                capabilities: {
                    canReact: true,
                    canGenerateImages: true,
                    canUseTts: true,
                },
                surfaceContext: {
                    channelId: interaction.channelId ?? undefined,
                    guildId: interaction.guildId ?? undefined,
                    userId: interaction.user.id,
                },
            });

            if (
                response.action === 'message' &&
                typeof response.message === 'string'
            ) {
                const metadata = hasResponseMetadata(response.metadata)
                    ? response.metadata
                    : null;
                const replyBody = clampReplyContent(
                    `${buildChatDetailsPrefix({ modeId, maxReviewCycles, traceTarget: hasTraceTarget ? traceTarget : undefined })}${buildSearchUnavailablePrefix(metadata)}${response.message}`
                );
                if (!metadata) {
                    await interaction.editReply({
                        content: replyBody,
                    });
                    return;
                }

                const components = [
                    buildProvenanceActionRow(metadata.responseId),
                ];
                const files: AttachmentBuilder[] = [];
                try {
                    const traceCard = await botApi.postTraceCardFromTrace({
                        responseId: metadata.responseId,
                    });
                    files.push(
                        new AttachmentBuilder(
                            Buffer.from(traceCard.pngBase64, 'base64'),
                            {
                                name: 'trace-card.png',
                            }
                        )
                    );
                } catch (error) {
                    logger.warn(
                        'Failed to generate /chat trace-card; sending details controls only.',
                        {
                            responseId: metadata.responseId,
                            interactionId: interaction.id,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        }
                    );
                }

                await interaction.editReply({
                    content: replyBody,
                    components,
                    files,
                });
                return;
            }

            await interaction.editReply({
                content: clampReplyContent(
                    `${buildChatDetailsPrefix({ modeId, maxReviewCycles, traceTarget: hasTraceTarget ? traceTarget : undefined })}${renderNonMessageAction(response)}`
                ),
            });
        } catch (error) {
            logger.error('chat slash command failed', {
                error: error instanceof Error ? error.message : String(error),
                interactionId: interaction.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId,
            });
            await interaction.editReply({
                content: clampReplyContent(toChatFailureMessage(error)),
            });
        }
    },
};

export default chatCommand;
