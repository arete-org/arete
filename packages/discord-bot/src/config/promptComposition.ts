/**
 * @description: Centralizes how Discord prompt text is combined with profile overlays.
 * @footnote-scope: utility
 * @footnote-module: PromptComposition
 * @footnote-risk: medium - Inconsistent composition here can desync reflect/image/realtime prompt behavior.
 * @footnote-ethics: high - Overlay composition controls identity and safety-priority behavior.
 */

import type {
    PromptKey,
    PromptRegistry,
    PromptVariables,
} from '@footnote/prompts';

import {
    buildProfileOverlaySystemMessage,
    composePromptWithProfileOverlay,
    type ProfilePromptOverlayUsage,
} from './profilePromptOverlay.js';
import type { BotProfileConfig } from './profile.js';

/**
 * Minimal message shape used by reflect-request conversation assembly.
 */
export interface PromptConversationMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * Result shape when optionally prepending one profile overlay system message.
 */
export interface PromptConversationOverlayResult {
    conversation: PromptConversationMessage[];
    overlayAdded: boolean;
}

type AppendedOverlayRenderInput = {
    registry: PromptRegistry;
    profile: BotProfileConfig;
    key: PromptKey;
    usage: ProfilePromptOverlayUsage;
    variables?: PromptVariables;
};

/**
 * Renders a prompt and appends the profile overlay block when configured.
 * This is used by append-style paths such as image, realtime, and provenance.
 */
export const renderPromptWithAppendedProfileOverlay = (
    input: AppendedOverlayRenderInput
): string => {
    const rendered = input.registry.renderPrompt(input.key, input.variables);
    return composePromptWithProfileOverlay(
        rendered.content,
        input.profile,
        input.usage
    );
};

/**
 * Prepends one system overlay message when an overlay exists.
 * Reflect keeps overlay text as a separate system message, and this helper
 * centralizes that behavior in one place.
 */
export const prependProfileOverlaySystemMessageToConversation = (
    profile: BotProfileConfig,
    usage: ProfilePromptOverlayUsage,
    conversation: readonly PromptConversationMessage[]
): PromptConversationOverlayResult => {
    const overlayMessage = buildProfileOverlaySystemMessage(profile, usage);
    if (!overlayMessage) {
        return {
            conversation: [...conversation],
            overlayAdded: false,
        };
    }

    return {
        conversation: [
            {
                role: 'system',
                content: overlayMessage,
            },
            ...conversation,
        ],
        overlayAdded: true,
    };
};
