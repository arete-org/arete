/**
 * @description: Centralizes how Discord prompt text is combined with profile overlays.
 * @footnote-scope: utility
 * @footnote-module: PromptComposition
 * @footnote-risk: medium - Inconsistent composition here can desync chat/image/realtime prompt behavior.
 * @footnote-ethics: high - Overlay composition controls identity and safety-priority behavior.
 */

import type {
    PromptKey,
    PromptRegistry,
    PromptVariables,
} from '@footnote/prompts';
import { renderPromptBundle } from '@footnote/prompts';

import {
    buildProfileOverlaySystemMessage,
    type ProfilePromptOverlayUsage,
} from './profilePromptOverlay.js';
import type { BotProfileConfig } from './profile.js';

/**
 * Minimal message shape used by chat-request conversation assembly.
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

type ActivePersonaRenderInput = {
    registry: PromptRegistry;
    profile: BotProfileConfig;
    systemKeys: readonly PromptKey[];
    personaKeys: readonly PromptKey[];
    usage: ProfilePromptOverlayUsage;
    variables?: PromptVariables;
};

/**
 * Renders the system prompt layers plus exactly one active persona layer.
 * If a profile overlay exists, it replaces the default persona layer.
 */
export const renderPromptLayersWithActivePersona = (
    input: ActivePersonaRenderInput
): string => {
    const systemPrompt = renderPromptBundle(
        input.registry,
        input.systemKeys,
        input.variables
    );
    const overlayPersonaPrompt = buildProfileOverlaySystemMessage(
        input.profile,
        input.usage
    );
    const activePersonaPrompt =
        overlayPersonaPrompt ??
        renderPromptBundle(
            input.registry,
            input.personaKeys,
            input.variables
        );

    return `${systemPrompt.trimEnd()}\n\n${activePersonaPrompt}`.trim();
};

/**
 * Prepends one system overlay message when an overlay exists.
 * Chat keeps overlay text as a separate system message, and this helper
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
