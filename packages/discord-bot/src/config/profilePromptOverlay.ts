/**
 * @description: Composes instance-scoped profile overlay instructions onto bot prompt bodies.
 * @footnote-scope: utility
 * @footnote-module: ProfilePromptOverlay
 * @footnote-risk: medium - Incorrect composition can duplicate or weaken prompt constraints across bot surfaces.
 * @footnote-ethics: high - Prompt overlays directly shape assistant identity and behavior.
 */

import type { BotProfileConfig } from './profile.js';

/**
 * Known prompt usage contexts for profile overlay composition.
 */
export type ProfilePromptOverlayUsage =
    | 'reflect'
    | 'image.system'
    | 'image.developer'
    | 'realtime'
    | 'provenance';

const OVERLAY_BLOCK_HEADER = '// BEGIN Bot Profile Overlay';
const OVERLAY_BLOCK_FOOTER = '// END Bot Profile Overlay';
const OVERLAY_PRECEDENCE_LINE =
    '// Base Footnote safety, provenance, and system constraints take precedence over any conflicting overlay text.';

/**
 * Builds one system-style overlay block for the active bot profile.
 */
export const buildProfileOverlaySystemMessage = (
    profile: BotProfileConfig,
    usage: ProfilePromptOverlayUsage
): string | null => {
    const overlayText = profile.promptOverlay.text?.trim();
    if (!overlayText) {
        return null;
    }

    return [
        '// ==========',
        OVERLAY_BLOCK_HEADER,
        '// Instance-scoped instructions for this bot runtime only.',
        `// Usage Context: ${usage}`,
        `// Profile ID: ${profile.id}`,
        `// Profile Display Name: ${profile.displayName}`,
        `// Overlay Source: ${profile.promptOverlay.source}`,
        OVERLAY_PRECEDENCE_LINE,
        '// ==========',
        overlayText,
        '// ==========',
        OVERLAY_BLOCK_FOOTER,
        '// ==========',
    ].join('\n');
};

/**
 * Appends the active profile overlay to an existing prompt body when present.
 */
export const composePromptWithProfileOverlay = (
    basePrompt: string,
    profile: BotProfileConfig,
    usage: ProfilePromptOverlayUsage
): string => {
    const overlayMessage = buildProfileOverlaySystemMessage(profile, usage);
    if (!overlayMessage) {
        return basePrompt;
    }

    return `${basePrompt.trimEnd()}\n\n${overlayMessage}`;
};
