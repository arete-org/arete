/**
 * @description: Shared backend-only types for reflect planner output and generation settings.
 * @footnote-scope: core
 * @footnote-module: ReflectGenerationTypes
 * @footnote-risk: medium - Type drift here can desynchronize planner output from message execution.
 * @footnote-ethics: medium - Retrieval settings influence grounding and provenance quality.
 */
import type {
    GenerationRequest,
    GenerationSearchRequest,
} from '@footnote/agent-runtime';
import type { ResponseTemperament } from '@footnote/contracts/ethics-core';

export type ReflectRepoSearchHint =
    | 'architecture'
    | 'backend'
    | 'contracts'
    | 'discord'
    | 'images'
    | 'onboarding'
    | 'web'
    | 'observability'
    | 'openapi'
    | 'prompts'
    | 'provenance'
    | 'reflect'
    | 'traces'
    | 'voice';

/**
 * Reflect narrows generic repo hints to the known Footnote-specific tags that
 * planner prompts are allowed to emit today.
 */
export type ReflectGenerationSearch = Omit<
    GenerationSearchRequest,
    'repoHints'
> & {
    repoHints?: ReflectRepoSearchHint[];
};

/**
 * Reflect-specific generation settings. Runtime-facing search and generation
 * knobs come from `@footnote/agent-runtime`, while TRACE temperament remains
 * backend-owned because it feeds Footnote metadata rather than runtime
 * execution directly.
 */
export type ReflectGenerationPlan = {
    reasoningEffort: NonNullable<GenerationRequest['reasoningEffort']>;
    verbosity: NonNullable<GenerationRequest['verbosity']>;
    search?: ReflectGenerationSearch;
    temperament?: ResponseTemperament;
};
