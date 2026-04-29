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

    assert.equal(
        decision.generation.toolIntent?.input.location.type,
        'lat_lon'
    );
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
