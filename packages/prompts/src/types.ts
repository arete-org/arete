/**
 * @description: Canonical prompt registry types shared across backend and Discord runtimes.
 * @footnote-scope: utility
 * @footnote-module: SharedPromptTypes
 * @footnote-risk: medium - Prompt typing drift can break rendering or hide missing keys.
 * @footnote-ethics: high - Shared prompt definitions shape behavior across all Footnote surfaces.
 */

/**
 * All supported prompt keys. Keeping this list in one package makes prompt
 * ownership explicit and prevents backend/bot drift.
 */
export const promptKeys = [
    'conversation.shared.system',
    'conversation.shared.persona.footnote',
    'discord.chat.system',
    'discord.chat.persona.footnote',
    'discord.image.system',
    'discord.image.persona.footnote',
    'discord.image.developer',
    'discord.realtime.system',
    'discord.realtime.persona.footnote',
    'discord.planner.system',
    'reflect.planner.system',
    'reflect.chat.system',
    'reflect.chat.persona.footnote',
    'discord.summarizer.system',
    'text.news.system',
] as const;

export type PromptKey = (typeof promptKeys)[number];

/**
 * Tracks metadata used by downstream systems (for example cache hints).
 */
export interface PromptCachePolicy {
    strategy?: string;
    ttlSeconds?: number;
    [key: string]: unknown;
}

export interface PromptMetadata {
    description?: string;
    cache?: PromptCachePolicy;
}

export interface PromptDefinition extends PromptMetadata {
    template: string;
}

export interface PromptCatalog {
    prompts: Record<PromptKey, PromptDefinition>;
}

export type PromptVariables = Record<
    string,
    string | number | boolean | null | undefined
>;

export interface RenderedPrompt extends PromptMetadata {
    content: string;
}

export interface PromptLogger {
    info?(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
    error?(message: string, meta?: Record<string, unknown>): void;
}

export interface CreatePromptRegistryOptions {
    overridePath?: string;
    logger?: PromptLogger;
}

export interface PromptRegistry {
    getPrompt(key: PromptKey): PromptDefinition;
    renderPrompt(key: PromptKey, variables?: PromptVariables): RenderedPrompt;
    hasPrompt(key: PromptKey): boolean;
    assertKeys(keys: readonly PromptKey[]): void;
}
