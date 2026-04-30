/**
 * @description: Covers backend tool policy and registry seams for deterministic selection and fail-open execution.
 * @footnote-scope: test
 * @footnote-module: ChatToolRegistryTests
 * @footnote-risk: medium - Missing tests can hide tool routing regressions that alter retrieval behavior.
 * @footnote-ethics: medium - Tool selection and fail-open handling affect grounding and user trust.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applySingleToolPolicy } from '../src/services/tools/toolPolicy.js';
import {
    executeSelectedTool,
    resolveToolSelection,
} from '../src/services/tools/toolRegistry.js';

test('single-tool policy is now a no-op with unified toolIntent', () => {
    const decision = applySingleToolPolicy({
        reasoningEffort: 'low',
        verbosity: 'low',
        toolIntent: {
            toolName: 'weather_forecast',
            requested: true,
            input: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
            },
        },
        search: {
            query: 'Indianapolis weather alerts',
            contextSize: 'low',
            intent: 'current_facts',
        },
    });

    const toolInput = decision.generation.toolIntent?.input as
        | { location: { type: string } }
        | undefined;
    assert.equal(toolInput?.location.type, 'lat_lon');
    assert.equal(
        decision.generation.search?.query,
        'Indianapolis weather alerts'
    );
    assert.equal(decision.logEvent, undefined);
});

test('registry marks weather tool unavailable with skipped execution metadata when adapter is absent', () => {
    const selection = resolveToolSelection({
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            toolIntent: {
                toolName: 'weather_forecast',
                requested: true,
                input: {
                    location: {
                        type: 'lat_lon',
                        latitude: 39.7684,
                        longitude: -86.1581,
                    },
                },
            },
        },
        weatherForecastTool: undefined,
    });

    assert.deepEqual(selection.toolRequest, {
        toolName: 'weather_forecast',
        requested: true,
        eligible: false,
        reasonCode: 'tool_unavailable',
    });
    assert.deepEqual(selection.toolExecution, {
        toolName: 'weather_forecast',
        status: 'skipped',
        reasonCode: 'tool_unavailable',
    });
});

test('weather adapter execution fails open and returns tool_execution_error when fetch throws', async () => {
    const selection = resolveToolSelection({
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            toolIntent: {
                toolName: 'weather_forecast',
                requested: true,
                input: {
                    location: {
                        type: 'lat_lon',
                        latitude: 39.7684,
                        longitude: -86.1581,
                    },
                },
            },
        },
        weatherForecastTool: {
            fetchForecast: async () => {
                throw new Error('weather upstream unavailable');
            },
        },
    });

    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
        [];
    const execution = await executeSelectedTool({
        toolSelection: selection,
        weatherForecastTool: {
            fetchForecast: async () => {
                throw new Error('weather upstream unavailable');
            },
        },
        onWarn: (message, meta) => {
            warnings.push({ message, meta });
        },
    });

    assert.equal(execution.toolResultMessage, undefined);
    assert.equal(execution.toolExecutionContext?.toolName, 'weather_forecast');
    assert.equal(execution.toolExecutionContext?.status, 'failed');
    assert.equal(
        execution.toolExecutionContext?.reasonCode,
        'tool_execution_error'
    );
    assert.ok((execution.toolExecutionContext?.durationMs ?? 0) >= 0);
    assert.equal(warnings.length, 1);
});

test('web search tool intent forwards topicHints when provided', () => {
    const selection = resolveToolSelection({
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            search: {
                query: 'planner fallback behavior',
                contextSize: 'low',
                intent: 'current_facts',
                topicHints: ['planner fallback', 'chat planner'],
            },
        },
    });

    assert.equal(selection.toolIntent.toolName, 'web_search');
    assert.equal(selection.toolIntent.requested, true);
    assert.deepEqual(
        (selection.toolIntent.input as { topicHints?: string[] }).topicHints,
        ['planner fallback', 'chat planner']
    );
});

test('weather adapter passes through needs_clarification result with status executed', async () => {
    const selection = resolveToolSelection({
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            toolIntent: {
                toolName: 'weather_forecast',
                requested: true,
                input: {
                    location: {
                        type: 'place_query',
                        query: 'New York',
                    },
                },
            },
        },
        weatherForecastTool: {
            fetchForecast: async () => ({
                toolName: 'weather_forecast',
                status: 'needs_clarification',
                request: {
                    location: { type: 'place_query', query: 'New York' },
                },
                clarification: {
                    reasonCode: 'ambiguous_location',
                    question: 'Which New York did you mean?',
                    options: [
                        {
                            id: 'nyc',
                            label: 'New York City, New York, United States',
                            value: {
                                toolName: 'weather_forecast',
                                input: {
                                    location: {
                                        type: 'lat_lon',
                                        latitude: 40.7128,
                                        longitude: -74.006,
                                    },
                                },
                            },
                        },
                        {
                            id: 'nys',
                            label: 'New York State, United States',
                            value: {
                                toolName: 'weather_forecast',
                                input: {
                                    location: {
                                        type: 'place_query',
                                        query: 'New York State',
                                        countryCode: 'US',
                                    },
                                },
                            },
                        },
                    ],
                },
                provenance: {
                    provider: 'open-meteo',
                    endpoint: 'mock',
                    requestedAt: '2026-01-01T00:00:00Z',
                },
            }),
        },
    });

    const execution = await executeSelectedTool({
        toolSelection: selection,
        weatherForecastTool: selection.generation.toolIntent
            ? {
                  fetchForecast: async () => ({
                      toolName: 'weather_forecast',
                      status: 'needs_clarification',
                      request: {
                          location: { type: 'place_query', query: 'New York' },
                      },
                      clarification: {
                          reasonCode: 'ambiguous_location',
                          question: 'Which New York did you mean?',
                          options: [
                              {
                                  id: 'nyc',
                                  label: 'New York City, New York, United States',
                              },
                              {
                                  id: 'nys',
                                  label: 'New York State, United States',
                              },
                          ],
                      },
                      provenance: {
                          provider: 'open-meteo',
                          endpoint: 'mock',
                          requestedAt: '2026-01-01T00:00:00Z',
                      },
                  }),
              }
            : undefined,
        onWarn: () => {},
    });

    assert.equal(execution.toolExecutionContext?.toolName, 'weather_forecast');
    assert.equal(execution.toolExecutionContext?.status, 'executed');
    assert.ok(execution.toolExecutionContext?.clarification !== undefined);
    assert.equal(
        execution.toolExecutionContext?.clarification?.reasonCode,
        'ambiguous_location'
    );
    assert.equal(
        execution.toolExecutionContext?.clarification?.options.length,
        2
    );
});
