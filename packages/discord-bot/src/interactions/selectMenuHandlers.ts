/**
 * @description: Handles Discord string-select interactions for image variations and incident review.
 * @footnote-scope: core
 * @footnote-module: SelectMenuInteractionHandlers
 * @footnote-risk: medium - Misrouted select handlers can corrupt session state or block review actions.
 * @footnote-ethics: medium - Incident selection and image refinement choices affect user-facing outcomes.
 */
import type { StringSelectMenuInteraction } from 'discord.js';
import {
    IMAGE_VARIATION_ASPECT_SELECT_PREFIX,
    IMAGE_VARIATION_IMAGE_MODEL_SELECT_PREFIX,
    IMAGE_VARIATION_PROMPT_ADJUST_SELECT_PREFIX,
    IMAGE_VARIATION_QUALITY_SELECT_PREFIX,
} from '../commands/image/constants.js';
import { resolveAspectRatioSettings } from '../commands/image/aspect.js';
import {
    IMAGE_MODEL_LABELS,
    buildVariationConfiguratorView,
    resetVariationCooldown,
    updateVariationSession,
} from '../commands/image/variationSessions.js';
import type { ImageGenerationContext } from '../commands/image/retryCache.js';
import type {
    ImageQualityType,
    ImageRenderModel,
} from '../commands/image/types.js';
import {
    handleIncidentViewSelect,
    INCIDENT_VIEW_SELECT_PREFIX,
} from '../commands/incident.js';
import { buildVariationStatusMessage } from './variationStatus.js';

// Shared ephemeral flag used for session-expiry notices.
const EPHEMERAL_FLAG = 1 << 6;
const ALLOWED_IMAGE_QUALITY_VALUES = new Set<ImageQualityType>([
    'low',
    'medium',
    'high',
]);

/**
 * Routes string-select interactions for variation controls and incident views.
 *
 * Return value:
 * - `true` means handled in this module
 * - `false` means the select id is outside this module's scope
 */
export async function handleStringSelectMenuInteraction(
    interaction: StringSelectMenuInteraction
): Promise<boolean> {
    const { customId, values } = interaction;
    const selected = values?.[0];

    if (!selected) {
        // Keep Discord interaction state consistent for empty selections.
        await interaction.deferUpdate();
        return true;
    }

    const respondWithExpiryNotice = async () => {
        await interaction.reply({
            content:
                '⚠️ That variation configurator expired. Press the variation button again.',
            flags: [EPHEMERAL_FLAG],
        });
    };

    if (customId.startsWith(IMAGE_VARIATION_QUALITY_SELECT_PREFIX)) {
        if (!ALLOWED_IMAGE_QUALITY_VALUES.has(selected as ImageQualityType)) {
            await interaction.deferUpdate();
            return true;
        }

        const responseId = customId.slice(
            IMAGE_VARIATION_QUALITY_SELECT_PREFIX.length
        );
        const session = updateVariationSession(
            interaction.user.id,
            responseId,
            (current) => {
                current.quality = selected as ImageQualityType;
            }
        );

        if (!session) {
            await respondWithExpiryNotice();
            return true;
        }

        const refreshed =
            resetVariationCooldown(interaction.user.id, responseId) ?? session;
        // Always refresh the existing configurator so users see updated state.
        await interaction.update(
            buildVariationConfiguratorView(refreshed, {
                statusMessage: buildVariationStatusMessage(interaction.user.id),
            })
        );
        return true;
    }

    if (customId.startsWith(IMAGE_VARIATION_ASPECT_SELECT_PREFIX)) {
        const responseId = customId.slice(
            IMAGE_VARIATION_ASPECT_SELECT_PREFIX.length
        );
        const session = updateVariationSession(
            interaction.user.id,
            responseId,
            (current) => {
                const { size, aspectRatio, aspectRatioLabel } =
                    resolveAspectRatioSettings(
                        selected as ImageGenerationContext['aspectRatio']
                    );
                current.size = size;
                current.aspectRatio = aspectRatio;
                current.aspectRatioLabel = aspectRatioLabel;
            }
        );

        if (!session) {
            await respondWithExpiryNotice();
            return true;
        }

        const refreshed =
            resetVariationCooldown(interaction.user.id, responseId) ?? session;
        await interaction.update(
            buildVariationConfiguratorView(refreshed, {
                statusMessage: buildVariationStatusMessage(interaction.user.id),
            })
        );
        return true;
    }

    if (customId.startsWith(IMAGE_VARIATION_IMAGE_MODEL_SELECT_PREFIX)) {
        if (!(selected in IMAGE_MODEL_LABELS)) {
            await interaction.deferUpdate();
            return true;
        }

        const responseId = customId.slice(
            IMAGE_VARIATION_IMAGE_MODEL_SELECT_PREFIX.length
        );
        const session = updateVariationSession(
            interaction.user.id,
            responseId,
            (current) => {
                current.imageModel = selected as ImageRenderModel;
            }
        );

        if (!session) {
            await respondWithExpiryNotice();
            return true;
        }

        const refreshed =
            resetVariationCooldown(interaction.user.id, responseId) ?? session;
        await interaction.update(
            buildVariationConfiguratorView(refreshed, {
                statusMessage: buildVariationStatusMessage(interaction.user.id),
            })
        );
        return true;
    }

    if (customId.startsWith(IMAGE_VARIATION_PROMPT_ADJUST_SELECT_PREFIX)) {
        const responseId = customId.slice(
            IMAGE_VARIATION_PROMPT_ADJUST_SELECT_PREFIX.length
        );
        const session = updateVariationSession(
            interaction.user.id,
            responseId,
            (current) => {
                current.allowPromptAdjustment = selected === 'allow';
            }
        );

        if (!session) {
            await respondWithExpiryNotice();
            return true;
        }

        const refreshed =
            resetVariationCooldown(interaction.user.id, responseId) ?? session;
        await interaction.update(
            buildVariationConfiguratorView(refreshed, {
                statusMessage: buildVariationStatusMessage(interaction.user.id),
            })
        );
        return true;
    }

    if (customId.startsWith(INCIDENT_VIEW_SELECT_PREFIX)) {
        // Incident review select menus stay delegated to incident command logic.
        await handleIncidentViewSelect(interaction);
        return true;
    }

    return false;
}
