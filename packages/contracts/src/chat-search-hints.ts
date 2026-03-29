/**
 * @description: Defines shared planner search-hint vocabularies consumed by backend normalization and structured planner contracts.
 * @footnote-scope: interface
 * @footnote-module: ChatSearchHints
 * @footnote-risk: medium - Drift in these shared values can desynchronize planner output and search behavior.
 * @footnote-ethics: medium - Search-hint vocabulary influences retrieval quality and grounding.
 */

export const chatRepoSearchHints = [
    'architecture',
    'backend',
    'contracts',
    'discord',
    'images',
    'onboarding',
    'web',
    'observability',
    'openapi',
    'prompts',
    'provenance',
    'chat',
    'traces',
    'voice',
] as const;

export type ChatRepoSearchHint = (typeof chatRepoSearchHints)[number];

/**
 * Canonical topic-hint query-term expansion used by repo_explainer retrieval.
 * Unknown topic hints are still passed through as instruction text by backend.
 */
export const chatTopicHintQueryTerms: Readonly<
    Record<string, readonly string[]>
> = {
    architecture: ['architecture'],
    backend: ['backend'],
    contracts: ['contracts'],
    discord: ['discord'],
    images: ['image generation', 'images'],
    onboarding: ['onboarding', 'getting started'],
    web: ['web'],
    observability: ['observability'],
    openapi: ['openapi'],
    prompts: ['prompts'],
    provenance: ['provenance'],
    chat: ['chat'],
    traces: ['traces'],
    voice: ['voice'],
    'incident lifecycle': ['incident lifecycle', 'incident'],
    'trace envelope': ['trace envelope', 'execution metadata'],
    'weather tool': ['weather forecast tool', 'weather'],
};
