/**
 * @description: Backend-owned weather tool adapter execution + prompt context shaping.
 * Encapsulates fail-open weather tool behavior away from chat orchestrator.
 * @footnote-scope: core
 * @footnote-module: WeatherForecastToolAdapter
 * @footnote-risk: medium - Adapter regressions can degrade weather context quality, but blast radius is one optional tool path.
 * @footnote-ethics: medium - Weather guidance can influence user decisions, so we preserve explicit provenance and failure semantics.
 */
import type {
    ToolExecutionContext,
    ToolInvocationReasonCode,
} from '@footnote/contracts/ethics-core';
import type {
    WeatherForecastTool,
    WeatherForecastToolResult,
} from '../contextIntegrations/weather/index.js';
import { wrapToolResultPayload } from '../contextIntegrations/toolResultFormatter.js';
import type { ChatGenerationWeatherRequest } from '../chatGenerationTypes.js';

const formatWeatherToolResultMessage = (
    result: WeatherForecastToolResult
): string => {
    const compactResult =
        result.status === 'ok'
            ? {
                  toolName: result.toolName,
                  status: result.status,
                  location: result.location,
                  forecast: {
                      periods: result.forecast.periods.map((period) => ({
                          name: period.name,
                          startsAt: period.startsAt,
                          endsAt: period.endsAt,
                          temperature: period.temperature,
                          wind: period.wind,
                          shortForecast: period.shortForecast,
                          precipitationProbability:
                              period.precipitationProbability,
                      })),
                  },
                  provenance: {
                      citationUrl: result.provenance.citationUrl,
                      citationLabel: result.provenance.citationLabel,
                  },
              }
            : result;

    return wrapToolResultPayload(result.toolName, compactResult);
};

export const executeWeatherForecastTool = async ({
    request,
    weatherForecastTool,
    onWarn,
}: {
    request: ChatGenerationWeatherRequest;
    weatherForecastTool: WeatherForecastTool;
    onWarn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<{
    toolResultMessage?: string;
    toolExecutionContext: ToolExecutionContext;
}> => {
    const mapWeatherErrorCodeToReasonCode = (
        code: string | undefined
    ): ToolInvocationReasonCode =>
        code === 'timeout'
            ? 'tool_timeout'
            : code === 'http_error'
              ? 'tool_http_error'
              : code === 'network_error'
                ? 'tool_network_error'
                : code === 'invalid_response'
                  ? 'tool_invalid_response'
                  : 'tool_execution_error';

    const weatherToolStartedAt = Date.now();
    try {
        const weatherToolResult =
            await weatherForecastTool.fetchForecast(request);
        const weatherToolDurationMs = Math.max(
            0,
            Date.now() - weatherToolStartedAt
        );
        return {
            toolResultMessage:
                formatWeatherToolResultMessage(weatherToolResult),
            toolExecutionContext: {
                toolName: 'weather_forecast',
                status:
                    weatherToolResult.status === 'ok' ||
                    weatherToolResult.status === 'needs_clarification'
                        ? 'executed'
                        : 'failed',
                ...(weatherToolResult.status === 'needs_clarification' && {
                    clarification: weatherToolResult.clarification,
                }),
                ...(weatherToolResult.status === 'error' && {
                    reasonCode: mapWeatherErrorCodeToReasonCode(
                        weatherToolResult.error.code
                    ),
                }),
                durationMs: weatherToolDurationMs,
            },
        };
    } catch (error) {
        const weatherToolDurationMs = Math.max(
            0,
            Date.now() - weatherToolStartedAt
        );
        onWarn(
            'weather tool failed open; continuing generation without weather context',
            {
                error: error instanceof Error ? error.message : String(error),
            }
        );
        return {
            toolExecutionContext: {
                toolName: 'weather_forecast',
                status: 'failed',
                reasonCode: 'tool_execution_error',
                durationMs: weatherToolDurationMs,
            },
        };
    }
};
