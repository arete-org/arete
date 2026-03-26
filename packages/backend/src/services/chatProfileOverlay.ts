/**
 * @description: Resolves backend-owned chat persona overlay and display-name settings.
 * @footnote-scope: core
 * @footnote-module: ChatProfileOverlay
 * @footnote-risk: medium - Incorrect overlay selection can apply the wrong persona instructions.
 * @footnote-ethics: medium - Persona overlay behavior affects disclosure and user-facing response style.
 */

import type { PostChatRequest } from '@footnote/contracts/web';
import { buildProfileOverlaySystemMessage } from './prompts/profilePromptOverlay.js';
import { runtimeConfig } from '../config.js';

const DEFAULT_BOT_PROFILE_DISPLAY_NAME = 'Footnote';

type ChatProfileOverlayLogger = {
    warn: (
        message: string,
        meta?: {
            requestedProfileId?: string;
            runtimeProfileId: string;
            surface: PostChatRequest['surface'];
        }
    ) => void;
};

/**
 * Uses the shared profile display-name env so non-overlay persona templates
 * resolve to the same name operators configured for the deployment.
 */
export const resolveBotProfileDisplayName = (): string => {
    const envValue = process.env.BOT_PROFILE_DISPLAY_NAME;
    if (typeof envValue === 'string' && envValue.trim().length > 0) {
        return envValue.trim();
    }

    return DEFAULT_BOT_PROFILE_DISPLAY_NAME;
};

/**
 * Chat profile selection is backend-owned. The bot may suggest a profile ID,
 * but the backend only honors the active runtime profile and warns on mismatch.
 */
export const resolveActiveProfileOverlayPrompt = (
    request: Pick<PostChatRequest, 'profileId' | 'surface'>,
    logger: ChatProfileOverlayLogger
): string | null => {
    const requestedProfileId = request.profileId?.trim();
    const runtimeProfileId = runtimeConfig.profile.id;

    if (requestedProfileId && requestedProfileId !== runtimeProfileId) {
        logger.warn('profile id mismatch', {
            requestedProfileId,
            runtimeProfileId,
            surface: request.surface,
        });
    }

    // Runtime profile config stays authoritative even when callers include a
    // profileId hint in the request payload.
    return buildProfileOverlaySystemMessage(runtimeConfig.profile, 'chat');
};
