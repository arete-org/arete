/**
 * @description: Handles modal submit interactions for incident reports and image variation prompts.
 * @footnote-scope: core
 * @footnote-module: ModalSubmitInteractionHandlers
 * @footnote-risk: medium - Broken modal handling can block incident reporting or variation edits.
 * @footnote-ethics: medium - Incident report and prompt-update flows affect trust and transparency.
 */
import type { ModalSubmitInteraction } from 'discord.js';
import {
    IMAGE_VARIATION_PROMPT_INPUT_ID,
    IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX,
} from '../commands/image/constants.js';
import { applyPromptPolicy } from '../commands/image/sessionHelpers.js';
import {
    buildVariationConfiguratorView,
    resetVariationCooldown,
    updateVariationSession,
} from '../commands/image/variationSessions.js';
import {
    handleIncidentReportModal,
    INCIDENT_REPORT_MODAL_PREFIX,
} from '../utils/response/incidentReporting.js';
import { logger } from '../utils/logger.js';
import { buildVariationStatusMessage } from './variationStatus.js';

// Shared ephemeral flag for validation and expiry notices.
const EPHEMERAL_FLAG = 1 << 6;

/**
 * Routes modal submits for incident reporting and variation prompt updates.
 *
 * Return value:
 * - `true` means handled in this module
 * - `false` means the modal id is outside this module's scope
 */
export async function handleModalSubmitInteraction(
    interaction: ModalSubmitInteraction
): Promise<boolean> {
    const { customId } = interaction;

    if (customId.startsWith(INCIDENT_REPORT_MODAL_PREFIX)) {
        // Incident report modal has its own backend-facing validation flow.
        await handleIncidentReportModal(interaction);
        return true;
    }

    if (!customId.startsWith(IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX)) {
        return false;
    }

    const responseId = customId.slice(
        IMAGE_VARIATION_PROMPT_MODAL_ID_PREFIX.length
    );
    const rawPrompt = interaction.fields.getTextInputValue(
        IMAGE_VARIATION_PROMPT_INPUT_ID
    );
    const trimmedPrompt = rawPrompt?.trim();

    if (!trimmedPrompt) {
        // Keep feedback clear and immediate for empty prompt submissions.
        await interaction.reply({
            content: '⚠️ The prompt cannot be empty.',
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    const session = updateVariationSession(
        interaction.user.id,
        responseId,
        (current) => {
            const promptPolicy = applyPromptPolicy(trimmedPrompt);
            current.prompt = promptPolicy.prompt;
            current.refinedPrompt = promptPolicy.prompt;
            current.promptPolicyMaxInputChars = promptPolicy.maxInputChars;
            current.promptPolicyTruncated = promptPolicy.policyTruncated;
        }
    );

    if (!session) {
        await interaction.reply({
            content:
                '⚠️ That variation configurator expired. Press the variation button again.',
            flags: [EPHEMERAL_FLAG],
        });
        return true;
    }

    const refreshed =
        resetVariationCooldown(interaction.user.id, responseId) ?? session;
    try {
        // If the original configurator message is still active, refresh it so
        // users can continue adjusting settings without reopening the flow.
        if (refreshed.messageUpdater) {
            await refreshed.messageUpdater(
                buildVariationConfiguratorView(refreshed, {
                    statusMessage: buildVariationStatusMessage(
                        interaction.user.id
                    ),
                })
            );
        }
    } catch (error) {
        logger.warn(
            'Failed to refresh variation configurator after prompt update:' +
                error
        );
    }

    await interaction.reply({
        content:
            '✅ Prompt updated! Adjust other settings and press **Generate variation** when ready.',
        flags: [EPHEMERAL_FLAG],
    });
    return true;
}
