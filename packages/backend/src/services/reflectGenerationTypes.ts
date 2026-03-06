/**
 * @description: Shared backend-only types for reflect planner output and message-generation options.
 * @footnote-scope: core
 * @footnote-module: ReflectGenerationTypes
 * @footnote-risk: medium - Type drift here can desynchronize planner output from message execution.
 * @footnote-ethics: medium - Retrieval settings influence grounding and provenance quality.
 */
import type { ResponseTemperament } from '@footnote/contracts/ethics-core';

export type ReflectSearchIntent = 'repo_explainer' | 'current_facts';

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

export type ReflectWebSearchPlan = {
    query: string;
    searchContextSize: 'low' | 'medium' | 'high';
    searchIntent: ReflectSearchIntent;
    repoHints: ReflectRepoSearchHint[];
};

export type ReflectGenerationPlan = {
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
    verbosity: 'low' | 'medium' | 'high';
    toolChoice: 'none' | 'web_search';
    webSearch?: ReflectWebSearchPlan;
    temperament?: ResponseTemperament;
};
