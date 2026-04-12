/**
 * @description: Compatibility facade for backend OpenAI service exports while
 * implementation details live in responsibility-scoped submodules.
 * @footnote-scope: utility
 * @footnote-module: ChatOpenAIService
 * @footnote-risk: medium - Incorrect re-export wiring can break callers across backend surfaces.
 * @footnote-ethics: medium - Export drift can indirectly impact metadata transparency behavior.
 */

// Owns: stable import surface for existing callers.
// Does not own: provider request implementation or metadata assembly internals.

export type {
    AssistantResponseMetadata,
    AssistantUsage,
    GenerateResponseOptions,
    OpenAIService,
    OpenAIResponseMetadata,
    ResponseMetadataRetrievalContext,
    ResponseMetadataRuntimeContext,
} from './openaiService/types.js';

export {
    extractMarkdownLinkCitations,
    normalizeFallbackCitationTitle,
} from './openaiService/citations.js';

export { buildResponseMetadata } from './openaiService/metadata.js';
export { SimpleOpenAIService } from './openaiService/request.js';
