/**
 * @description: Applies deterministic tool-selection policy before orchestration.
 * Keeps one-tool-at-a-time behavior explicit and backend-owned.
 * @footnote-scope: core
 * @footnote-module: ChatToolPolicy
 * @footnote-risk: medium - Policy errors can route the wrong tool and degrade retrieval quality.
 * @footnote-ethics: medium - Tool selection policy affects source grounding and user trust in answer provenance.
 */
import type { ChatGenerationPlan } from '../chatGenerationTypes.js';
import type { ToolPolicyLogEvent } from './toolTypes.js';

export type ToolPolicyDecision = {
    generation: ChatGenerationPlan;
    logEvent?: ToolPolicyLogEvent;
};

export const applySingleToolPolicy = (
    generation: ChatGenerationPlan
): ToolPolicyDecision => {
    const weatherRequested = generation.weather !== undefined;
    const searchRequested = generation.search !== undefined;
    if (!weatherRequested || !searchRequested) {
        return { generation };
    }

    return {
        generation: {
            ...generation,
            search: undefined,
        },
        logEvent: {
            event: 'chat.orchestration.tool_policy',
            policy: 'single_tool_weather_priority_v1',
            droppedToolName: 'web_search',
            selectedToolName: 'weather_forecast',
        },
    };
};
