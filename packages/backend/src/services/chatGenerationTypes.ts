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
 * Optional non-authoritative EPC hint from planner to execution assembly.
 *
 * This is advisory vocabulary only. Canonical policy ownership stays in EPC
 * contract resolution; this hint cannot define or override EPC ontology.
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
 * intent. `responseIntentHint` is advisory only and non-authoritative.
 */
export type ChatGenerationPlan = {
    reasoningEffort: NonNullable<GenerationRequest['reasoningEffort']>;
    verbosity: NonNullable<GenerationRequest['verbosity']>;
    search?: ChatGenerationSearch;
    weather?: ChatGenerationWeatherRequest;
    responseIntentHint?: ChatGenerationResponseIntentHint;
    temperament?: ResponseTemperament;
};
