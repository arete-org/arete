/**
 * @description: Verifies tool-registry context-step adapter mapping into workflow context-step executor results.
 * Confirms weather success, failure, and clarification semantics are preserved.
 * @footnote-scope: test
 * @footnote-module: ToolRegistryContextStepAdapterTests
 * @footnote-risk: medium - Missing coverage could hide mapping drift before workflow timing cutover.
 * @footnote-ethics: medium - Context-step outcome fidelity is required for transparent fail-open and clarification behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { WeatherForecastTool } from '../src/services/openMeteoForecastTool.js';
import { createToolRegistryContextStepExecutor } from '../src/services/contextIntegrations/toolRegistryContextStepAdapter.js';

test('context-step adapter maps weather success to executed context with tool result message', async () => {
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'ok',
            request: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
            },
            location: {
                name: 'Indianapolis, IN',
            },
            forecast: {
                generatedAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                periods: [],
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: 'mock',
                requestedAt: '2026-01-01T00:00:00Z',
            },
        }),
    };
    const contextStepExecutor = createToolRegistryContextStepExecutor({
        weatherForecastTool,
    });

    const result = await contextStepExecutor({
        request: {
            integrationName: 'weather_forecast',
            requested: true,
            eligible: true,
            input: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
            },
        },
        workflowId: 'wf_1',
        workflowName: 'message_with_review_loop',
        attempt: 1,
    });

    assert.equal(result.executionContext.toolName, 'weather_forecast');
    assert.equal(result.executionContext.status, 'executed');
    assert.equal(result.executionContext.reasonCode, undefined);
    assert.equal(result.contextMessages?.length, 1);
    assert.match(
        result.contextMessages?.[0] ?? '',
        /BEGIN Backend Tool Result/
    );
});

test('context-step adapter preserves weather fail-open failure reason codes', async () => {
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => {
            throw new Error('weather upstream unavailable');
        },
    };
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
        [];
    const contextStepExecutor = createToolRegistryContextStepExecutor({
        weatherForecastTool,
        onWarn: (message, meta) => {
            warnings.push({ message, meta });
        },
    });

    const result = await contextStepExecutor({
        request: {
            integrationName: 'weather_forecast',
            requested: true,
            eligible: true,
            input: {
                location: {
                    type: 'lat_lon',
                    latitude: 39.7684,
                    longitude: -86.1581,
                },
            },
        },
        workflowId: 'wf_2',
        workflowName: 'message_with_review_loop',
        attempt: 1,
    });

    assert.equal(result.executionContext.toolName, 'weather_forecast');
    assert.equal(result.executionContext.status, 'failed');
    assert.equal(result.executionContext.reasonCode, 'tool_execution_error');
    assert.equal(result.contextMessages, undefined);
    assert.equal(warnings.length, 1);
});

test('context-step adapter maps weather clarification to executed context with clarification payload', async () => {
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'needs_clarification',
            request: {
                location: {
                    type: 'place_query',
                    query: 'Springfield',
                },
            },
            clarification: {
                reasonCode: 'ambiguous_location',
                question: 'Which Springfield did you mean?',
                options: [
                    {
                        id: 'springfield_il',
                        label: 'Springfield, Illinois',
                    },
                ],
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: 'mock',
                requestedAt: '2026-01-01T00:00:00Z',
            },
        }),
    };
    const contextStepExecutor = createToolRegistryContextStepExecutor({
        weatherForecastTool,
    });

    const result = await contextStepExecutor({
        request: {
            integrationName: 'weather_forecast',
            requested: true,
            eligible: true,
            input: {
                location: {
                    type: 'place_query',
                    query: 'Springfield',
                },
            },
        },
        workflowId: 'wf_3',
        workflowName: 'message_with_review_loop',
        attempt: 1,
    });

    assert.equal(result.executionContext.toolName, 'weather_forecast');
    assert.equal(result.executionContext.status, 'executed');
    assert.equal(
        result.executionContext.clarification?.reasonCode,
        'ambiguous_location'
    );
    assert.equal(result.clarification?.reasonCode, 'ambiguous_location');
    assert.equal(result.contextMessages?.length, 1);
});
