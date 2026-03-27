/**
 * @description: Builds backend Ollama connectivity config used by model-profile provider routing.
 * @footnote-scope: utility
 * @footnote-module: BackendOllamaSection
 * @footnote-risk: medium - Wrong base URL or enablement parsing can make Ollama profiles appear healthy when they are not.
 * @footnote-ethics: medium - Provider routing determines where user prompts are processed.
 */

import { parseBooleanFlag, parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig } from '../types.js';

/**
 * Builds the Ollama section from env.
 *
 * This section is intentionally lightweight: provider profile availability
 * checks happen in model profile catalog loading.
 */
export const buildOllamaSection = (
    env: NodeJS.ProcessEnv
): RuntimeConfig['ollama'] => ({
    baseUrl: parseOptionalTrimmedString(env.OLLAMA_BASE_URL),
    apiKey: parseOptionalTrimmedString(env.OLLAMA_API_KEY),
    localInferenceEnabled: parseBooleanFlag(env.OLLAMA_LOCAL_INFERENCE_ENABLED),
});
