/**
 * @description: Reverse image search context integration entry point.
 * @footnote-scope: core
 * @footnote-module: ReverseImageSearchContextIntegration
 * @footnote-risk: low - Re-exports only.
 * @footnote-ethics: low - Re-exports only.
 */
export { createReverseImageSearchContextStepExecutor } from './reverseImageSearchContextStepExecutor.js';
export { createSerpApiReverseImageSearchProvider } from './serpApiReverseImageSearchProvider.js';
export type {
    ReverseImageSearchMatch,
    ReverseImageSearchProvider,
    ReverseImageSearchProviderResponse,
} from './reverseImageSearchContextStepExecutor.js';

export const REVERSE_IMAGE_SEARCH_INTEGRATION_NAME =
    'reverse_image_search' as const;
