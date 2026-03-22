/**
 * @description: Composes shared conversational prompt layers for backend-owned
 * text and realtime surfaces.
 * @footnote-scope: utility
 * @footnote-module: ConversationPromptLayers
 * @footnote-risk: high - Layer ordering mistakes here can desync backend text and voice behavior.
 * @footnote-ethics: high - Shared prompt layers define safety, identity, and disclosure behavior across user-facing surfaces.
 */

import { renderPromptBundle } from '@footnote/prompts';
import { promptRegistry } from './promptRegistry.js';

export type ConversationSurface =
    | 'discord-chat'
    | 'discord-realtime'
    | 'reflect-chat';

const resolveSurfaceSystemKeys = (
    surface: ConversationSurface
): readonly (
    | 'conversation.shared.system'
    | 'discord.chat.system'
    | 'discord.realtime.system'
    | 'reflect.chat.system'
)[] => {
    switch (surface) {
        case 'discord-chat':
            return ['conversation.shared.system', 'discord.chat.system'];
        case 'discord-realtime':
            return ['conversation.shared.system', 'discord.realtime.system'];
        case 'reflect-chat':
            return ['conversation.shared.system', 'reflect.chat.system'];
    }
};

const resolveSurfacePersonaKeys = (
    surface: ConversationSurface
): readonly (
    | 'conversation.shared.persona.footnote'
    | 'discord.chat.persona.footnote'
    | 'discord.realtime.persona.footnote'
    | 'reflect.chat.persona.footnote'
)[] => {
    switch (surface) {
        case 'discord-chat':
            return [
                'conversation.shared.persona.footnote',
                'discord.chat.persona.footnote',
            ];
        case 'discord-realtime':
            return [
                'conversation.shared.persona.footnote',
                'discord.realtime.persona.footnote',
            ];
        case 'reflect-chat':
            return [
                'conversation.shared.persona.footnote',
                'reflect.chat.persona.footnote',
            ];
    }
};

/**
 * Renders the shared behavioral system layer plus the surface-specific system
 * rules for a backend-owned conversation surface.
 */
export const renderConversationSystemPrompt = (
    surface: ConversationSurface,
    variables: Record<string, string> = {}
): string =>
    renderPromptBundle(
        promptRegistry,
        resolveSurfaceSystemKeys(surface),
        variables
    );

/**
 * Renders the default persona bundle for a backend-owned conversation surface.
 * Callers may replace this whole bundle with a profile overlay when needed.
 */
export const renderDefaultConversationPersonaPrompt = (
    surface: ConversationSurface,
    variables: Record<string, string> = {}
): string =>
    renderPromptBundle(
        promptRegistry,
        resolveSurfacePersonaKeys(surface),
        variables
    );
