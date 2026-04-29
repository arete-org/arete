/**
 * @description: Central backend registry for tool request selection and execution handoff.
 * Keeps tool wiring additive so new tools are added with one adapter + one registry entry.
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

const buildWeatherForecastToolIntent = (
    generation: ChatGenerationPlan
): ToolInvocationIntent =>
    generation.weather
        ? {
              toolName: 'weather_forecast',
              requested: true,
              input: generation.weather,
          }
        : {
              toolName: 'weather_forecast',
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
    const weatherToolIntent = buildWeatherForecastToolIntent(generation);
    if (weatherToolIntent.requested) {
        const weatherToolAvailable = weatherForecastTool !== undefined;
        return {
            generation,
            toolIntent: weatherToolIntent,
            toolRequest: {
                toolName: 'weather_forecast',
                requested: true,
                eligible: weatherToolAvailable,
                ...(!weatherToolAvailable && {
                    reasonCode: 'tool_unavailable',
                }),
            },
            ...(!weatherToolAvailable && {
                toolExecution: {
                    toolName: 'weather_forecast',
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
    // TODO(JBA-20): Promote web_search to an explicit adapter registration for
    // symmetry with backend-executed tools, even when execution remains runtime-owned.
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
        !toolSelection.toolRequest.eligible ||
        !toolSelection.generation.weather ||
        !weatherForecastTool
    ) {
        return {
            ...(toolSelection.toolExecution !== undefined && {
                toolExecutionContext: toolSelection.toolExecution,
            }),
        };
    }

    const weatherExecution = await executeWeatherForecastTool({
        request: toolSelection.generation.weather,
        weatherForecastTool,
        onWarn,
    });
    return {
        toolResultMessage: weatherExecution.toolResultMessage,
        toolExecutionContext: weatherExecution.toolExecutionContext,
    };
};
