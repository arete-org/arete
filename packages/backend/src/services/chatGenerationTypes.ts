/**
 * @description: Shared backend-only types for chat planner output and generation settings.
 * @footnote-scope: core
 * @footnote-module: ChatGenerationTypes
 * @footnote-risk: medium - Type drift here can desynchronize planner output from message execution.
 * @footnote-ethics: medium - Retrieval settings influence grounding and provenance quality.
 */
import type {
    GenerationRequest,
    GenerationSearchRequest,
} from '@footnote/agent-runtime';
import type {
    ChatRepoSearchHint,
    ResponseTemperament,
} from '@footnote/contracts';
import type { ExecutionResponseMode } from './executionPolicyContract.js';
export type { ChatRepoSearchHint } from '@footnote/contracts';

/**
 * Chat narrows generic repo hints to the known Footnote-specific tags that
 * planner prompts are allowed to emit today.
 */
export type ChatGenerationSearch = Omit<
    GenerationSearchRequest,
    'repoHints' | 'topicHints'
> & {
    repoHints?: ChatRepoSearchHint[];
    topicHints?: string[];
};

export type ChatGenerationWeatherLocation =
    | {
          type: 'lat_lon';
          latitude: number;
          longitude: number;
      }
    | {
          type: 'gridpoint';
          office: string;
          gridX: number;
          gridY: number;
      };

export type ChatGenerationWeatherRequest = {
    location: ChatGenerationWeatherLocation;
    horizonPeriods?: number;
};

/**
 * Optional EPC-adjacent hint from planner to execution.
 *
 * This is intent vocabulary only. It does not execute EPC policy by itself.
 */
export type ChatGenerationResponseIntentHint = {
    responseMode: ExecutionResponseMode;
};

/**
 * Chat-specific generation settings. Runtime-facing search and generation
 * knobs come from `@footnote/agent-runtime`, while TRACE temperament remains
 * backend-owned because it feeds Footnote metadata rather than runtime execution directly.
 *
 * `reasoningEffort` and `verbosity` are generation controls, not EPC response
 * intent. Use `responseIntentHint` when callers need explicit EPC vocabulary.
 */
export type ChatGenerationPlan = {
    reasoningEffort: NonNullable<GenerationRequest['reasoningEffort']>;
    verbosity: NonNullable<GenerationRequest['verbosity']>;
    search?: ChatGenerationSearch;
    weather?: ChatGenerationWeatherRequest;
    responseIntentHint?: ChatGenerationResponseIntentHint;
    temperament?: ResponseTemperament;
};
