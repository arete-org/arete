/**
 * @description: Central backend registry for tool request selection and execution handoff.
 * Tool selection is now unified through context integration - uses toolIntent directly.
 * @footnote-scope: core
 * @footnote-module: ChatToolRegistry
 * @footnote-risk: medium - Registry mistakes can request the wrong tool or misreport telemetry.
 * @footnote-ethics: medium - Tool routing decisions affect answer grounding and user-visible provenance.
 */
import type {
    ToolExecutionContext,
    ToolInvocationIntent,
    ToolInvocationRequest,
} from '@footnote/contracts/ethics-core';
import type { ChatGenerationPlan } from '../chatGenerationTypes.js';
import type { WeatherForecastTool } from '../openMeteoForecastTool.js';
import { executeWeatherForecastTool } from './weatherForecastToolAdapter.js';
import type { BackendToolSelection } from './toolTypes.js';

const buildWebSearchToolIntent = (
    generation: ChatGenerationPlan
): ToolInvocationIntent =>
    generation.search
        ? {
              toolName: 'web_search',
              requested: true,
              input: {
                  query: generation.search.query,
                  intent: generation.search.intent,
                  contextSize: generation.search.contextSize,
                  ...(generation.search.repoHints &&
                      generation.search.repoHints.length > 0 && {
                          repoHints: generation.search.repoHints,
                      }),
                  ...(generation.search.topicHints &&
                      generation.search.topicHints.length > 0 && {
                          topicHints: generation.search.topicHints,
                      }),
              },
          }
        : {
              toolName: 'web_search',
              requested: false,
          };

export const resolveToolSelection = ({
    generation,
    weatherForecastTool,
    webSearchToolRequestOverride,
    inheritedToolExecution,
}: {
    generation: ChatGenerationPlan;
    weatherForecastTool?: WeatherForecastTool;
    webSearchToolRequestOverride?: ToolInvocationRequest;
    inheritedToolExecution?: ToolExecutionContext;
}): BackendToolSelection => {
    if (generation.toolIntent) {
        const toolIntent = generation.toolIntent;
        const toolAvailable =
            toolIntent.toolName === 'weather_forecast'
                ? weatherForecastTool !== undefined
                : true;
        return {
            generation,
            toolIntent,
            toolRequest: {
                toolName: toolIntent.toolName,
                requested: toolIntent.requested,
                eligible: toolAvailable,
                ...(!toolAvailable && {
                    reasonCode: 'tool_unavailable',
                }),
            },
            ...(!toolAvailable && {
                toolExecution: {
                    toolName: toolIntent.toolName,
                    status: 'skipped',
                    reasonCode: 'tool_unavailable',
                } satisfies ToolExecutionContext,
            }),
        };
    }

    if (webSearchToolRequestOverride) {
        return {
            generation,
            toolIntent: buildWebSearchToolIntent(generation),
            toolRequest: webSearchToolRequestOverride,
            ...(inheritedToolExecution !== undefined && {
                toolExecution: inheritedToolExecution,
            }),
        };
    }

    const webSearchToolIntent = buildWebSearchToolIntent(generation);
    return {
        generation,
        toolIntent: webSearchToolIntent,
        toolRequest: webSearchToolIntent.requested
            ? {
                  toolName: 'web_search',
                  requested: true,
                  eligible: true,
              }
            : {
                  toolName: 'web_search',
                  requested: false,
                  eligible: false,
                  reasonCode: 'tool_not_requested',
              },
        ...(inheritedToolExecution !== undefined && {
            toolExecution: inheritedToolExecution,
        }),
    };
};

export const executeSelectedTool = async ({
    toolSelection,
    weatherForecastTool,
    onWarn,
}: {
    toolSelection: BackendToolSelection;
    weatherForecastTool?: WeatherForecastTool;
    onWarn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<{
    toolResultMessage?: string;
    toolExecutionContext?: ToolExecutionContext;
}> => {
    if (
        toolSelection.toolRequest.toolName !== 'weather_forecast' ||
        !toolSelection.toolRequest.requested ||
        !toolSelection.toolRequest.eligible ||
        !toolSelection.toolIntent?.input ||
        !weatherForecastTool
    ) {
        return {
            ...(toolSelection.toolExecution !== undefined && {
                toolExecutionContext: toolSelection.toolExecution,
            }),
        };
    }

    // This cast relies on normalizeToolIntent in chatPlanner.ts, which validates
    // and normalizes weather_forecast input before execution. The guard above
    // ensures execution only proceeds when toolIntent.input exists.
    const weatherInput = toolSelection.toolIntent.input as {
        location: unknown;
        horizonPeriods?: number;
    };
    const weatherExecution = await executeWeatherForecastTool({
        request: {
            location: weatherInput.location as
                | {
                      type: 'lat_lon';
                      latitude: number;
                      longitude: number;
                  }
                | {
                      type: 'place_query';
                      query: string;
                      countryCode?: string;
                  },
            horizonPeriods: weatherInput.horizonPeriods,
        },
        weatherForecastTool,
        onWarn,
    });
    return {
        toolResultMessage: weatherExecution.toolResultMessage,
        toolExecutionContext: weatherExecution.toolExecutionContext,
    };
};
