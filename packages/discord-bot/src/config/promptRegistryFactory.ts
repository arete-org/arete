/**
 * @description: Creates Discord prompt registries from the shared canonical prompt package without runtime env coupling.
 * @footnote-scope: utility
 * @footnote-module: DiscordPromptRegistryFactory
 * @footnote-risk: medium - Wrong wiring here can desync bot-local prompt overrides from canonical defaults.
 * @footnote-ethics: high - Bot-local prompts must stay aligned with shared Footnote safety and provenance rules.
 */

import { createPromptRegistry, type PromptRegistry } from '@footnote/prompts';

export const createDiscordPromptRegistry = (
    overridePath?: string
): PromptRegistry =>
    createPromptRegistry({
        overridePath,
    });
