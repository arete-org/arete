/**
 * @description: Small shared helpers for combining multiple prompt layers into
 * one rendered instruction block.
 * @footnote-scope: utility
 * @footnote-module: SharedPromptComposition
 * @footnote-risk: medium - Wrong layer ordering here can desync prompt behavior across surfaces.
 * @footnote-ethics: high - Prompt composition order controls which safety and identity rules the model sees.
 */

import type { PromptKey, PromptRegistry, PromptVariables } from './types.js';

/**
 * Renders a list of prompt keys and joins the non-empty results with blank
 * lines. This gives callers one consistent way to build layered prompts.
 */
export const renderPromptBundle = (
    registry: PromptRegistry,
    keys: readonly PromptKey[],
    variables: PromptVariables = {}
): string =>
    keys
        .map((key) => registry.renderPrompt(key, variables).content.trim())
        .filter((content) => content.length > 0)
        .join('\n\n')
        .trim();
