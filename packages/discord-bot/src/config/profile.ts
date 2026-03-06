/**
 * @description: Parses bot profile env configuration into a typed object used by vendoring flows.
 * @footnote-scope: utility
 * @footnote-module: BotProfileConfig
 * @footnote-risk: medium - Incorrect parsing can apply the wrong profile identity or overlay source.
 * @footnote-ethics: medium - Profile configuration shapes assistant identity and disclosure behavior.
 */

import { envDefaultValues } from '@footnote/config-spec';

/**
 * Parsed bot profile configuration derived from environment variables.
 */
export interface BotProfileConfig {
    id: string;
    displayName: string;
    promptOverlayText: string | null;
    promptOverlayPath: string | null;
}

const normalizeOptionalEnvString = (
    value: string | undefined
): string | null => {
    if (!value) {
        return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
};

/**
 * Reads bot profile values from env with trimming and baseline defaults.
 */
export const readBotProfileConfig = (
    env: NodeJS.ProcessEnv = process.env
): BotProfileConfig => {
    return {
        id:
            normalizeOptionalEnvString(env.BOT_PROFILE_ID) ??
            envDefaultValues.BOT_PROFILE_ID,
        displayName:
            normalizeOptionalEnvString(env.BOT_PROFILE_DISPLAY_NAME) ??
            envDefaultValues.BOT_PROFILE_DISPLAY_NAME,
        promptOverlayText: normalizeOptionalEnvString(
            env.BOT_PROFILE_PROMPT_OVERLAY
        ),
        promptOverlayPath: normalizeOptionalEnvString(
            env.BOT_PROFILE_PROMPT_OVERLAY_PATH
        ),
    };
};
