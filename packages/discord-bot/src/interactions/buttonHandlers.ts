/**
 * @description: Top-level dispatcher for Discord button interactions.
 * @footnote-scope: core
 * @footnote-module: ButtonInteractionHandlers
 * @footnote-risk: high - Incorrect routing can break critical user actions across provenance, incident, and image flows.
 * @footnote-ethics: high - Routing determines whether transparency and incident pathways remain accessible.
 */
import type { ButtonInteraction } from 'discord.js';
import { handleImageRetryButtonInteraction } from './button/retryButtons.js';
import { handleIncidentButtonInteraction } from './button/incidentButtons.js';
import { handleProvenanceButtonInteraction } from './button/provenanceButtons.js';
import { handleVariationButtonInteraction } from './button/variationButtons.js';

/**
 * Main button router for the bot.
 *
 * Return value:
 * - `true` means this module handled the button and the caller should stop.
 * - `false` means no known prefix matched and the caller may continue.
 */
export async function handleButtonInteraction(
    interaction: ButtonInteraction
): Promise<boolean> {
    if (await handleProvenanceButtonInteraction(interaction)) {
        return true;
    }

    if (await handleIncidentButtonInteraction(interaction)) {
        return true;
    }

    if (await handleVariationButtonInteraction(interaction)) {
        return true;
    }

    if (await handleImageRetryButtonInteraction(interaction)) {
        return true;
    }

    return false;
}
