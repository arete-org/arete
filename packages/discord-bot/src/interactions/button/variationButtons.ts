/**
 * @description: Handles image-variation button flows, including configurator launch, reset, cancel, modal open, and generate.
 * @footnote-scope: core
 * @footnote-module: VariationButtonHandlers
 * @footnote-risk: high - Session lifecycle or token-accounting mistakes can cause failed generations or inconsistent state.
 * @footnote-ethics: medium - Variation controls affect user-visible output quality and resource fairness.
 */
import type { ButtonInteraction } from 'discord.js';
import {
    IMAGE_VARIATION_CANCEL_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_GENERATE_CUSTOM_ID_PREFIX,
    IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX,
    IMAGE_VARIATION_RESET_PROMPT_CUSTOM_ID_PREFIX,
} from '../../commands/image/constants.js';
import {
    readFollowUpContext,
    saveFollowUpContext,
} from '../../commands/image/followUpCache.js';
import { recoverContextFromMessage } from '../../commands/image/contextResolver.js';
import { runImageGenerationSession } from '../../commands/image.js';
import { formatRetryCountdown } from '../../commands/image/sessionHelpers.js';
import {
    buildPromptModal,
    buildVariationConfiguratorView,
    disposeVariationSession,
    getVariationSession,
    initialiseVariationSession,
    resetVariationCooldown,
    setVariationSessionUpdater,
    updateVariationSession,
    applyVariationCooldown,
} from '../../commands/image/variationSessions.js';
import { runtimeConfig } from '../../config.js';
import {
    consumeImageTokens,
    describeTokenAvailability,
    refundImageTokens,
} from '../../utils/imageTokens.js';
import { logger } from '../../utils/logger.js';
import { buildVariationStatusMessage } from '../variationStatus.js';
import { EPHEMERAL_FLAG, VARIATION_EXPIRED_MESSAGE } from './shared.js';

/**
 * Handles "Generate variation" button actions.
 */
async function handleGenerateVariationButton(
    interaction: ButtonInteraction,
    customId: string
): Promise<boolean> {
    if (!customId.startsWith(IMAGE_VARIATION_GENERATE_CUSTOM_ID_PREFIX)) {
        return false;
    }

    const responseId = customId.slice(IMAGE_VARIATION_GENERATE_CUSTOM_ID_PREFIX.length);
    const session = getVariationSession(interaction.user.id, responseId);
    if (!session) {
        await interaction.reply({
            content: VARIATION_EXPIRED_MESSAGE,
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    const cooldownRemaining = session.cooldownUntil
        ? Math.max(0, Math.ceil((session.cooldownUntil - Date.now()) / 1000))
        : 0;
    if (cooldownRemaining > 0) {
        await interaction.reply({
            content: `⚠️ Please wait ${formatRetryCountdown(cooldownRemaining)} before generating another variation.`,
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    const developerBypass = interaction.user.id === runtimeConfig.developerUserId;
    let tokenSpend = null as ReturnType<typeof consumeImageTokens> | null;

    // Token accounting here mirrors slash-command image generation behavior.
    if (!developerBypass) {
        const spendResult = consumeImageTokens(
            interaction.user.id,
            session.quality,
            session.imageModel
        );
        if (!spendResult.allowed) {
            const statusMessage = buildVariationStatusMessage(
                interaction.user.id,
                describeTokenAvailability(
                    session.quality,
                    spendResult,
                    session.imageModel
                )
            );

            const updatedSession =
                spendResult.remainingTokens === 0 && spendResult.refreshInSeconds > 0
                    ? (applyVariationCooldown(
                          interaction.user.id,
                          responseId,
                          spendResult.refreshInSeconds
                      ) ?? session)
                    : (resetVariationCooldown(interaction.user.id, responseId) ??
                      session);

            if (session.messageUpdater) {
                try {
                    await session.messageUpdater(
                        buildVariationConfiguratorView(updatedSession, {
                            statusMessage,
                        })
                    );
                } catch (error) {
                    logger.warn(
                        'Failed to refresh variation configurator after token denial: ' +
                            error
                    );
                }
            }

            await interaction.reply({
                content: statusMessage,
                flags: [EPHEMERAL_FLAG],
            });
            return true;
        }

        tokenSpend = spendResult;
    }

    try {
        if (session.messageUpdater) {
            await session.messageUpdater({
                content: '⏳ Generating variation…',
                embeds: [],
                components: [],
            });
        }
    } catch (error) {
        logger.warn(
            'Failed to update variation configurator before generation:' + error
        );
    }

    await interaction.deferReply();

    try {
        const runContext = {
            prompt: session.prompt,
            originalPrompt: session.originalPrompt,
            refinedPrompt: session.refinedPrompt,
            textModel: session.textModel,
            imageModel: session.imageModel,
            size: session.size,
            aspectRatio: session.aspectRatio,
            aspectRatioLabel: session.aspectRatioLabel,
            quality: session.quality,
            background: session.background,
            style: session.style,
            allowPromptAdjustment: session.allowPromptAdjustment,
            outputFormat: session.outputFormat,
            outputCompression: session.outputCompression,
        };

        const result = await runImageGenerationSession(
            interaction,
            runContext,
            responseId
        );

        if (!result.success && tokenSpend) {
            refundImageTokens(interaction.user.id, tokenSpend.cost);
        }
    } catch (error) {
        logger.error('Unexpected error while generating variation:' + error);
        if (tokenSpend) {
            refundImageTokens(interaction.user.id, tokenSpend.cost);
        }
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '⚠️ Something went wrong while generating that variation.',
                flags: [EPHEMERAL_FLAG],
            });
        }
    } finally {
        disposeVariationSession(`${interaction.user.id}:${responseId}`);
    }

    return true;
}

/**
 * Handles "Reset prompt" button actions.
 */
async function handleResetVariationPromptButton(
    interaction: ButtonInteraction,
    customId: string
): Promise<boolean> {
    if (!customId.startsWith(IMAGE_VARIATION_RESET_PROMPT_CUSTOM_ID_PREFIX)) {
        return false;
    }

    const responseId = customId.slice(IMAGE_VARIATION_RESET_PROMPT_CUSTOM_ID_PREFIX.length);
    const session = updateVariationSession(
        interaction.user.id,
        responseId,
        (current) => {
            current.prompt = current.originalPrompt;
            current.refinedPrompt = current.originalPrompt;
        }
    );

    if (!session) {
        await interaction.reply({
            content: VARIATION_EXPIRED_MESSAGE,
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    const refreshed = resetVariationCooldown(interaction.user.id, responseId) ?? session;
    await interaction.update(
        buildVariationConfiguratorView(refreshed, {
            statusMessage: buildVariationStatusMessage(interaction.user.id),
        })
    );
    return true;
}

/**
 * Handles "Cancel variation" button actions.
 */
async function handleCancelVariationButton(
    interaction: ButtonInteraction,
    customId: string
): Promise<boolean> {
    if (!customId.startsWith(IMAGE_VARIATION_CANCEL_CUSTOM_ID_PREFIX)) {
        return false;
    }

    const responseId = customId.slice(IMAGE_VARIATION_CANCEL_CUSTOM_ID_PREFIX.length);
    disposeVariationSession(`${interaction.user.id}:${responseId}`);
    await interaction.update({
        content: '❎ Variation cancelled.',
        embeds: [],
        components: [],
    });
    return true;
}

/**
 * Handles prompt-edit modal launch buttons for variation flows.
 */
async function handleVariationPromptModalButton(
    interaction: ButtonInteraction,
    customId: string
): Promise<boolean> {
    if (!customId.startsWith(IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX)) {
        return false;
    }

    const responseId = customId.slice(IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX.length);
    const session = getVariationSession(interaction.user.id, responseId);
    if (!session) {
        await interaction.reply({
            content: VARIATION_EXPIRED_MESSAGE,
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    await interaction.showModal(buildPromptModal(responseId, session.prompt));
    return true;
}

/**
 * Handles the initial "Create variation" button from an image result message.
 */
async function handleVariationEntryButton(
    interaction: ButtonInteraction,
    customId: string
): Promise<boolean> {
    if (!customId.startsWith(IMAGE_VARIATION_CUSTOM_ID_PREFIX)) {
        return false;
    }

    const followUpResponseId = customId.slice(IMAGE_VARIATION_CUSTOM_ID_PREFIX.length);
    if (!followUpResponseId) {
        await interaction.reply({
            content: '⚠️ I could not determine which image to vary.',
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    let cachedContext = readFollowUpContext(followUpResponseId);

    // Recover from message metadata when cache entries have aged out.
    if (!cachedContext) {
        try {
            const recovered = await recoverContextFromMessage(interaction.message);
            if (recovered) {
                cachedContext = recovered;
                saveFollowUpContext(followUpResponseId, recovered);
            }
        } catch (error) {
            logger.error(
                'Failed to recover cached context for variation button:' + error
            );
        }
    }

    if (!cachedContext) {
        await interaction.reply({
            content:
                '⚠️ Sorry, I can no longer create a variation for that image. Please run /image again.',
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    cachedContext.originalPrompt = cachedContext.originalPrompt ?? cachedContext.prompt;
    cachedContext.refinedPrompt = cachedContext.refinedPrompt ?? null;
    saveFollowUpContext(followUpResponseId, cachedContext);

    const session = initialiseVariationSession(
        interaction.user.id,
        followUpResponseId,
        cachedContext
    );

    // Store an updater callback so later select/modal/button actions can
    // refresh the same configurator message safely.
    await interaction.deferReply({ flags: [EPHEMERAL_FLAG] });
    const view = buildVariationConfiguratorView(session, {
        statusMessage: buildVariationStatusMessage(interaction.user.id),
    });
    await interaction.editReply(view);
    const storedSession = setVariationSessionUpdater(
        interaction.user.id,
        followUpResponseId,
        (options) => interaction.editReply(options)
    );
    if (!storedSession) {
        logger.warn(
            'Failed to store variation configurator updater: session missing after initialisation.'
        );
    }

    return true;
}

/**
 * Public router for all variation-related button interactions.
 */
export async function handleVariationButtonInteraction(
    interaction: ButtonInteraction
): Promise<boolean> {
    const { customId } = interaction;

    if (await handleGenerateVariationButton(interaction, customId)) {
        return true;
    }

    if (await handleResetVariationPromptButton(interaction, customId)) {
        return true;
    }

    if (await handleCancelVariationButton(interaction, customId)) {
        return true;
    }

    if (await handleVariationPromptModalButton(interaction, customId)) {
        return true;
    }

    if (await handleVariationEntryButton(interaction, customId)) {
        return true;
    }

    return false;
}
