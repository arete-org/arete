/**
 * @description: Verifies weather tool behavior through the workflow context-step path.
 * @footnote-scope: test
 * @footnote-module: ToolExecutionParityTests
 * @footnote-risk: low - Focused parity checks with bounded test doubles.
 * @footnote-ethics: medium - Preserves fail-open and clarification semantics that affect user trust and traceability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRuntime } from '@footnote/agent-runtime';
import type { WeatherForecastTool } from '../src/services/openMeteoForecastTool.js';
import { runBoundedReviewWorkflow } from '../src/services/workflowEngine.js';

const createTestRuntime = (
    implementation: (
        request: import('@footnote/agent-runtime').GenerationRequest
    ) => Promise<import('@footnote/agent-runtime').GenerationResult>
): GenerationRuntime => ({
    kind: 'test-runtime',
    generate: implementation,
});

test('weather success flows through workflow context-step: tool step recorded in lineage', async () => {
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
                periods: [],
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: 'mock',
                requestedAt: '2026-01-01T00:00:00Z',
            },
        }),
    };

    const generationRuntime = createTestRuntime(async () => ({
        text: 'Weather forecast for Indianapolis: clear skies',
        model: 'gpt-5-mini',
        usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
        },
        provenance: 'Inferred',
        citations: [],
    }));

    const result = await runBoundedReviewWorkflow({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'What is the weather?' }],
        },
        messagesWithHints: [{ role: 'user', content: 'What is the weather?' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop',
            maxIterations: 1,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        contextStepRequest: {
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
        contextStepExecutor: async ({ request }) => {
            const execution = await weatherForecastTool.fetchForecast(
                request.input as {
                    location: {
                        type: string;
                        latitude: number;
                        longitude: number;
                    };
                }
            );
            return {
                executionContext: {
                    toolName: 'weather_forecast',
                    status: 'executed',
                    durationMs: 10,
                },
                contextMessages: [
                    `Weather in ${execution.location.name}: clear skies`,
                ],
            };
        },
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
            promptTokens: generationResult.usage?.promptTokens ?? 0,
            completionTokens: generationResult.usage?.completionTokens ?? 0,
            totalTokens: generationResult.usage?.totalTokens ?? 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
    });

    assert.equal(
        result.outcome,
        'generated',
        'Workflow should generate when context step succeeds'
    );
    const toolStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'tool'
    );
    assert.ok(toolStep, 'Workflow should have a tool step');
    assert.equal(
        toolStep?.outcome.status,
        'executed',
        'Tool step should be executed'
    );
    assert.ok(
        toolStep?.outcome.artifacts?.length ?? 0 > 0,
        'Tool step should have context artifacts'
    );
});

test('weather failure preserves fail-open: generation runs, tool step recorded as failed', async () => {
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => {
            throw new Error('weather upstream unavailable');
        },
    };

    const generationRuntime = createTestRuntime(async () => ({
        text: 'Fallback weather response',
        model: 'gpt-5-mini',
        usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
        },
        provenance: 'Inferred',
        citations: [],
    }));

    const result = await runBoundedReviewWorkflow({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [{ role: 'user', content: 'What is the weather?' }],
        },
        messagesWithHints: [{ role: 'user', content: 'What is the weather?' }],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop',
            maxIterations: 1,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        contextStepRequest: {
            integrationName: 'weather_forecast',
            requested: true,
            eligible: true,
            input: { location: 'Indianapolis' },
        },
        contextStepExecutor: async () => {
            try {
                await weatherForecastTool.fetchForecast({
                    location: 'Indianapolis',
                } as never);
                return {
                    executionContext: {
                        toolName: 'weather_forecast',
                        status: 'executed',
                    },
                };
            } catch {
                return {
                    executionContext: {
                        toolName: 'weather_forecast',
                        status: 'failed',
                        reasonCode: 'tool_execution_error',
                    },
                };
            }
        },
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
            promptTokens: generationResult.usage?.promptTokens ?? 0,
            completionTokens: generationResult.usage?.completionTokens ?? 0,
            totalTokens: generationResult.usage?.totalTokens ?? 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
    });

    assert.equal(
        result.outcome,
        'generated',
        'Workflow should still generate on context step failure (fail-open)'
    );
    const toolStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'tool'
    );
    assert.ok(toolStep, 'Workflow should have a tool step');
    assert.equal(
        toolStep?.outcome.status,
        'failed',
        'Tool step should be marked as failed'
    );
    assert.equal(
        toolStep?.reasonCode,
        'tool_execution_error',
        'Tool step should have error reason code'
    );
});

test('weather clarification short-circuits: no generation, clarification response returned', async () => {
    let generationCalls = 0;
    const generationRuntime = createTestRuntime(async () => {
        generationCalls += 1;
        return {
            text: 'should not be generated',
            model: 'gpt-5-mini',
            usage: {
                promptTokens: 10,
                completionTokens: 5,
                totalTokens: 15,
            },
            provenance: 'Inferred',
            citations: [],
        };
    });

    const result = await runBoundedReviewWorkflow({
        generationRuntime,
        generationRequest: {
            model: 'gpt-5-mini',
            messages: [
                { role: 'user', content: 'What is the weather in New York?' },
            ],
        },
        messagesWithHints: [
            { role: 'user', content: 'What is the weather in New York?' },
        ],
        generationStartedAtMs: Date.now(),
        workflowConfig: {
            workflowName: 'message_with_review_loop',
            maxIterations: 0,
            maxDurationMs: 15000,
        },
        workflowPolicy: {
            enablePlanning: false,
            enableToolUse: true,
            enableReplanning: false,
            enableGeneration: true,
            enableAssessment: true,
            enableRevision: true,
        },
        contextStepRequest: {
            integrationName: 'weather_forecast',
            requested: true,
            eligible: true,
            input: { location: 'New York' },
        },
        contextStepExecutor: async () => ({
            executionContext: {
                toolName: 'weather_forecast',
                status: 'executed',
            },
            clarification: {
                reasonCode: 'ambiguous_location',
                question: 'Which New York did you mean?',
                options: [
                    {
                        id: 'nyc',
                        label: 'New York City, New York, United States',
                    },
                    { id: 'albany', label: 'Albany, New York, United States' },
                ],
            },
        }),
        captureUsage: (generationResult) => ({
            model: generationResult.model ?? 'gpt-5-mini',
            promptTokens: generationResult.usage?.promptTokens ?? 0,
            completionTokens: generationResult.usage?.completionTokens ?? 0,
            totalTokens: generationResult.usage?.totalTokens ?? 0,
            estimatedCost: {
                inputCostUsd: 0,
                outputCostUsd: 0,
                totalCostUsd: 0,
            },
        }),
    });

    assert.equal(
        result.outcome,
        'no_generation',
        'Workflow should not generate when clarification is needed'
    );
    assert.equal(
        generationCalls,
        0,
        'Generation should not be called when clarification is needed'
    );
    const toolStep = result.workflowLineage.steps.find(
        (step) => step.stepKind === 'tool'
    );
    assert.ok(toolStep, 'Workflow should have a tool step');
    assert.equal(
        toolStep?.outcome.status,
        'executed',
        'Tool step should be executed'
    );
    assert.equal(
        toolStep?.outcome.signals?.clarificationReasonCode,
        'ambiguous_location',
        'Tool step should have clarification reason'
    );
    assert.equal(
        result.contextStepResult?.clarification?.reasonCode,
        'ambiguous_location',
        'Context result should have clarification'
    );
});
