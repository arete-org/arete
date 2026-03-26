/**
 * @description: Shared constants for button-interaction handlers.
 * @footnote-scope: core
 * @footnote-module: ButtonInteractionShared
 * @footnote-risk: low - Constant drift can cause inconsistent ephemeral behavior.
 * @footnote-ethics: low - Consistent private responses reduce accidental exposure in shared channels.
 */

// Discord sets bit 6 for ephemeral responses.
// We centralize this to avoid accidental mismatches across handlers.
export const EPHEMERAL_FLAG = 1 << 6;

// Shared message used when a variation session expires before action execution.
export const VARIATION_EXPIRED_MESSAGE =
    '⚠️ That variation configurator expired. Press the variation button again.';
