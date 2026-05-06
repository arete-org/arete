/**
 * @description: Direct weather forecast context-step executor that surfaces structured citations.
 * @footnote-scope: core
 * @footnote-module: WeatherForecastContextStepExecutor
 * @footnote-risk: low - Executor handles one known integration; failures are fail-open per existing weather semantics.
 * @footnote-ethics: low - Provenance transparency improves with structured citations surfaced in trace/response metadata.
 */
import type {
    Citation,
    ExecutionStatus,
    ToolInvocationReasonCode,
    ToolClarification,
} from '@footnote/contracts/ethics-core';
import type {
    ContextStepExecutor,
    ContextStepResult,
} from '../workflowEngine.js';
import type {
    WeatherForecastTool,
    WeatherForecastToolResult,
} from '../openMeteoForecastTool.js';
import { formatWeatherToolResultMessage } from '../openMeteoForecastTool.js';

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
              : code === 'location_not_resolved'
                ? 'unspecified_tool_outcome'
                : 'tool_execution_error';

type WeatherInput = {
    location: unknown;
    horizonPeriods?: number;
};

const parseWeatherInput = (input: unknown): WeatherInput | undefined => {
    if (input === null || typeof input !== 'object') {
        return undefined;
    }
    const obj = input as Record<string, unknown>;
    if (!('location' in obj)) {
        return undefined;
    }
    return {
        location: obj.location,
        horizonPeriods:
            typeof obj.horizonPeriods === 'number'
                ? obj.horizonPeriods
                : undefined,
    };
};

const normalizeWeatherLocation = (
    location: unknown
):
    | {
          type: 'lat_lon';
          latitude: number;
          longitude: number;
      }
    | {
          type: 'place_query';
          query: string;
          countryCode?: string;
      }
    | undefined => {
    if (location === null || typeof location !== 'object') {
        return undefined;
    }
    const loc = location as Record<string, unknown>;
    if (
        loc.type === 'lat_lon' &&
        typeof loc.latitude === 'number' &&
        typeof loc.longitude === 'number'
    ) {
        const latitude = loc.latitude;
        const longitude = loc.longitude;
        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return undefined;
        }
        return {
            type: 'lat_lon',
            latitude,
            longitude,
        };
    }
    if (loc.type === 'place_query' && typeof loc.query === 'string') {
        const query = loc.query.trim();
        if (query.length === 0) {
            return undefined;
        }
        return {
            type: 'place_query',
            query,
            countryCode:
                typeof loc.countryCode === 'string'
                    ? loc.countryCode
                    : undefined,
        };
    }
    return undefined;
};

/**
 * Creates a fail-open context-step executor for weather forecast integration.
 * This is the provenance boundary for weather context execution in the workflow engine.
 *
 * @param weatherForecastTool - The weather API client; if undefined, execution is skipped.
 * @param onWarn - Callback for logging recoverable issues (e.g., API failures).
 *
 * @returns A ContextStepExecutor that:
 *   - Returns status:'skipped' with reasonCode:'tool_unavailable' if weatherForecastTool is missing
 *   - Returns status:'skipped' with reasonCode:'not_requested' if request.requested is false
 *   - Returns status:'skipped' with reasonCode:'not_eligible' if request.eligible is false
 *   - Returns status:'failed' with reasonCode:'unspecified_tool_outcome' for invalid input
 *   - Returns status:'executed' with contextMessages for successful weather retrieval
 *   - Returns status:'executed' with clarification for ambiguous location queries
 *   - Returns status:'failed' with appropriate reasonCode for API errors
 *
 * Fail-open behavior: Weather API failures do not block workflow execution; instead,
 * a warning is logged via onWarn and generation proceeds without weather context.
 * Sources (citationUrl/citationLabel) are surfaced as structured Citation[] when available.
 *
 * @param onWarn - Invoked when the weather API throws or returns an error, with the error message.
 */
export const createWeatherForecastContextStepExecutor = ({
    weatherForecastTool,
    onWarn,
}: {
    weatherForecastTool?: WeatherForecastTool;
    onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): ContextStepExecutor => {
    const warn = onWarn ?? (() => undefined);

    return async ({ request }): Promise<ContextStepResult> => {
        if (!weatherForecastTool) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: request.reasonCode ?? 'tool_unavailable',
                },
            };
        }

        if (!request.requested) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode: request.reasonCode ?? 'tool_not_requested',
                },
            };
        }

        if (!request.eligible) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'skipped',
                    reasonCode:
                        request.reasonCode ?? 'unspecified_tool_outcome',
                },
            };
        }

        const weatherInput = parseWeatherInput(request.input);
        if (!weatherInput) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'failed',
                    reasonCode: 'unspecified_tool_outcome',
                },
            };
        }

        const normalizedLocation = normalizeWeatherLocation(
            weatherInput.location
        );
        if (!normalizedLocation) {
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'failed',
                    reasonCode: 'unspecified_tool_outcome',
                },
            };
        }

        const weatherToolStartedAt = Date.now();

        let weatherToolResult: WeatherForecastToolResult;
        try {
            weatherToolResult = await weatherForecastTool.fetchForecast({
                location: normalizedLocation,
                horizonPeriods: weatherInput.horizonPeriods,
            });
        } catch (error) {
            const weatherToolDurationMs = Math.max(
                0,
                Date.now() - weatherToolStartedAt
            );
            warn(
                'weather tool failed open; continuing generation without weather context',
                {
                    error:
                        error instanceof Error ? error.message : String(error),
                }
            );
            return {
                executionContext: {
                    toolName: request.integrationName,
                    status: 'failed',
                    reasonCode: 'tool_execution_error',
                    durationMs: weatherToolDurationMs,
                },
            };
        }

        const weatherToolDurationMs = Math.max(
            0,
            Date.now() - weatherToolStartedAt
        );

        let sources: Citation[] | undefined;
        if (weatherToolResult.status === 'ok') {
            const provenance = weatherToolResult.provenance;
            sources = [
                {
                    title: provenance.citationLabel,
                    url: provenance.citationUrl,
                },
            ];
        }

        const executionContext: {
            toolName: string;
            status: ExecutionStatus;
            reasonCode?: ToolInvocationReasonCode;
            clarification?: ToolClarification;
            durationMs: number;
        } = {
            toolName: request.integrationName,
            status:
                weatherToolResult.status === 'ok' ||
                weatherToolResult.status === 'needs_clarification'
                    ? 'executed'
                    : 'failed',
            durationMs: weatherToolDurationMs,
        };

        if (weatherToolResult.status === 'needs_clarification') {
            executionContext.clarification = weatherToolResult.clarification;
        } else if (weatherToolResult.status === 'error') {
            executionContext.reasonCode = mapWeatherErrorCodeToReasonCode(
                weatherToolResult.error.code
            );
        }

        const clarification =
            'clarification' in executionContext
                ? executionContext.clarification
                : undefined;

        return {
            executionContext,
            contextMessages: [
                formatWeatherToolResultMessage(weatherToolResult),
            ],
            ...(clarification !== undefined && { clarification }),
            ...(sources !== undefined && { sources }),
        };
    };
};
