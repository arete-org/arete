/**
 * @description: Handles image retry button actions and retry token accounting.
 * @footnote-scope: core
 * @footnote-module: RetryButtonHandlers
 * @footnote-risk: high - Retry flow errors can spend tokens incorrectly or fail to deliver regenerated images.
 * @footnote-ethics: medium - Token fairness and transparent retry feedback affect user trust.
 */
import type { ButtonInteraction } from 'discord.js';
import { IMAGE_RETRY_CUSTOM_ID_PREFIX } from '../../commands/image/constants.js';
import {
    evictRetryContext,
    readRetryContext,
} from '../../commands/image/followUpCache.js';
import {
    buildImageResultPresentation,
    createRetryButtonRow,
    executeImageGeneration,
    formatRetryCountdown,
} from '../../commands/image/sessionHelpers.js';
import { runtimeConfig } from '../../config.js';
import {
    buildTokenSummaryLine,
    consumeImageTokens,
    describeTokenAvailability,
    refundImageTokens,
} from '../../utils/imageTokens.js';
import { logger } from '../../utils/logger.js';
import { resolveMemberDisplayName } from '../../utils/response/provenanceInteractions.js';
import { EPHEMERAL_FLAG } from './shared.js';

/**
 * Handles image retry custom IDs.
 */
export async function handleImageRetryButtonInteraction(
    interaction: ButtonInteraction
): Promise<boolean> {
    if (!interaction.customId.startsWith(IMAGE_RETRY_CUSTOM_ID_PREFIX)) {
        return false;
    }

    const retryKey = interaction.customId.slice(
        IMAGE_RETRY_CUSTOM_ID_PREFIX.length
    );
    if (!retryKey) {
        await interaction.reply({
            content: '⚠️ I could not find that image request to retry.',
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    const cachedContext = readRetryContext(retryKey);
    if (!cachedContext) {
        await interaction.reply({
            content:
                '⚠️ Sorry, that retry expired. Please ask me to generate a new image.',
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    const isDeveloper = interaction.user.id === runtimeConfig.developerUserId;
    let retrySpend = null as ReturnType<typeof consumeImageTokens> | null;
    if (!isDeveloper) {
        const spendResult = consumeImageTokens(
            interaction.user.id,
            cachedContext.quality,
            cachedContext.imageModel
        );
        if (!spendResult.allowed) {
            const message = `${describeTokenAvailability(cachedContext.quality, spendResult, cachedContext.imageModel)}\n\n${buildTokenSummaryLine(interaction.user.id)}`;
            const countdown = spendResult.refreshInSeconds;
            const retryRow =
                countdown > 0
                    ? createRetryButtonRow(
                          retryKey,
                          formatRetryCountdown(countdown)
                      )
                    : undefined;
            await interaction.reply({
                content: message,
                flags: [EPHEMERAL_FLAG],
                components: retryRow ? [retryRow] : [],
            });
            return true;
        }

        retrySpend = spendResult;
    }

    await interaction.deferReply();

    try {
        // Remove stale retry controls before posting the fresh result.
        await interaction.message
            .edit({ components: [] })
            .catch(() => undefined);

        const artifacts = await executeImageGeneration(cachedContext, {
            user: {
                username: interaction.user.username,
                nickname: resolveMemberDisplayName(
                    interaction.member,
                    interaction.user.username
                ),
                guildName:
                    interaction.guild?.name ??
                    `No guild for ${interaction.type} interaction`,
            },
            channelContext: {
                channelId: interaction.channelId,
                guildId: interaction.guildId ?? undefined,
            },
        });

        const presentation = buildImageResultPresentation(
            cachedContext,
            artifacts
        );

        evictRetryContext(retryKey);

        await interaction.editReply({
            content: presentation.content,
            embeds: [presentation.embed],
            files: presentation.attachments,
            attachments: [],
            components: presentation.components,
        });
    } catch (error) {
        if (retrySpend) {
            refundImageTokens(interaction.user.id, retrySpend.cost);
        }
        logger.error(
            'Unexpected error while handling image retry button: ' + error
        );
        try {
            await interaction.editReply({
                content:
                    '⚠️ I was unable to generate that image. Please try again later.',
                components: [],
            });
        } catch (replyError) {
            logger.error('Failed to send retry failure message: ' + replyError);
        }
    }

    return true;
}
