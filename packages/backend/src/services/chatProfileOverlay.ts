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
    return runtimeConfig.profile.displayName;
};

/**
 * Persona overlay selection is backend-owned and tied to runtime bot profile.
 * Request profile selection is handled separately by chat orchestrator routing.
 */
export const resolveActiveProfileOverlayPrompt = (
    _request: Pick<PostChatRequest, 'profileId' | 'surface'>,
    _logger: ChatProfileOverlayLogger
): string | null => {
    // Runtime profile config stays authoritative for persona overlay text.
    return buildProfileOverlaySystemMessage(runtimeConfig.profile, 'chat');
};
