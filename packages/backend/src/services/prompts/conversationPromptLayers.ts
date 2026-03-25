/**
 * @description: Composes shared conversational prompt layers for backend-owned
 * text and realtime surfaces.
 * @footnote-scope: utility
 * @footnote-module: ConversationPromptLayers
 * @footnote-risk: high - Layer ordering mistakes here can desync backend text and voice behavior.
 * @footnote-ethics: high - Shared prompt layers define safety, identity, and disclosure behavior across user-facing surfaces.
 */

import { renderPromptBundle } from '@footnote/prompts';
import type { PromptVariables } from '@footnote/prompts';
import { promptRegistry } from './promptRegistry.js';

const surfaceSystemKeys = {
    'discord-chat': ['conversation.shared.system', 'discord.chat.system'],
    'discord-realtime': [
        'conversation.shared.system',
        'discord.realtime.system',
    ],
    'web-chat': ['conversation.shared.system', 'chat.web.system'],
} as const;

const surfacePersonaKeys = {
    'discord-chat': [
        'conversation.shared.persona.footnote',
        'discord.chat.persona.footnote',
    ],
    'discord-realtime': [
        'conversation.shared.persona.footnote',
        'discord.realtime.persona.footnote',
    ],
    'web-chat': [
        'conversation.shared.persona.footnote',
        'chat.web.persona.footnote',
    ],
} as const;

export type ConversationSurface = keyof typeof surfaceSystemKeys;

export interface ConversationPromptLayers {
    systemPrompt: string;
    personaPrompt: string;
}

/**
 * Renders both prompt bundles for a backend-owned conversational surface.
 * Callers keep the system bundle fixed and may replace the persona bundle with
 * a profile overlay when needed.
 */
export const renderConversationPromptLayers = (
    surface: ConversationSurface,
    variables: PromptVariables = {}
): ConversationPromptLayers => ({
    systemPrompt: renderPromptBundle(
        promptRegistry,
        surfaceSystemKeys[surface],
        variables
    ),
    personaPrompt: renderPromptBundle(
        promptRegistry,
        surfacePersonaKeys[surface],
        variables
    ),
});
