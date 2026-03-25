/**
 * @description: Public entrypoint for the shared canonical prompt package.
 * @footnote-scope: utility
 * @footnote-module: SharedPromptsIndex
 * @footnote-risk: medium - Bad exports here can break backend and bot prompt resolution at once.
 * @footnote-ethics: high - This package is the single source of truth for Footnote prompt defaults.
 */

export { createPromptRegistry } from './promptRegistry.js';
export { renderPromptBundle } from './composition.js';
export {
    promptKeys,
    type CreatePromptRegistryOptions,
    type PromptCachePolicy,
    type PromptCatalog,
    type PromptDefinition,
    type PromptKey,
    type PromptLogger,
    type PromptMetadata,
    type PromptRegistry,
    type PromptVariables,
    type RenderedPrompt,
} from './types.js';
