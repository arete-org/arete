/**
 * @description: Web-search context integration entry point.
 * @footnote-scope: core
 * @footnote-module: WebSearchContextIntegration
 * @footnote-risk: medium - Search integration routing affects grounding and retrieval transparency.
 * @footnote-ethics: medium - Search source attribution quality affects user trust and governance review.
 */
export { createWebSearchContextStepExecutor } from './webSearchContextStepExecutor.js';
export type {
    WebSearchContextStepIntegrationPayload,
    WebSearchHint,
    WebSearchProviderName,
    WebSearchProviderAttempt,
} from './webSearchContextStepExecutor.js';
