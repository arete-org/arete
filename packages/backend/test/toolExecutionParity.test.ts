/**
 * @description: Pins current orchestrator-owned weather tool behavior before workflow tool-step migration.
 * @footnote-scope: test
 * @footnote-module: ToolExecutionParityTests
 * @footnote-risk: low - Focused parity checks with bounded test doubles.
 * @footnote-ethics: medium - Preserves fail-open and clarification semantics that affect user trust and traceability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenerationRuntime } from '@footnote/agent-runtime';
import type { PostChatRequest } from '@footnote/contracts/web';
import { createMetadata } from './fixtures/responseMetadataFixture.js';
import { runtimeConfig } from '../src/config.js';
import { createChatOrchestrator } from '../src/services/chatOrchestrator.js';
import {
    buildResponseMetadata,
    type ResponseMetadataRuntimeContext,
} from '../src/services/openaiService.js';
import type { WeatherForecastTool } from '../src/services/openMeteoForecastTool.js';

const PLANNER_TOKEN_SENTINEL = 1200;

const createChatRequest = (
    overrides: Partial<PostChatRequest> = {}
): PostChatRequest => ({
    surface: 'discord',
    trigger: { kind: 'direct' },
    latestUserInput: 'What is the weather?',
    conversation: [{ role: 'user', content: 'What is the weather?' }],
    capabilities: {
        canReact: true,
        canGenerateImages: true,
        canUseTts: true,
    },
    ...overrides,
});

const createGenerationRuntime = (
    implementation: (
        request: import('@footnote/agent-runtime').GenerationRequest
    ) => Promise<import('@footnote/agent-runtime').GenerationResult>
): GenerationRuntime => ({
    kind: 'test-runtime',
    generate: implementation,
});

const buildWeatherToolIntentPlannerOutput = (input: {
    location:
        | { type: 'lat_lon'; latitude: number; longitude: number }
        | { query: string };
}): string =>
    JSON.stringify({
        action: 'message',
        modality: 'text',
        requestedCapabilityProfile: 'expressive-generation',
        safetyTier: 'Low',
        reasoning: 'Use weather tool for this forecast question.',
        generation: {
            reasoningEffort: 'low',
            verbosity: 'low',
            temperament: {
                tightness: 4,
                rationale: 3,
                attribution: 4,
                caution: 3,
                extent: 4,
            },
            toolIntent: {
                toolName: 'weather_forecast',
                requested: true,
                input: {
                    location: input.location,
                },
            },
        },
    });

test('weather success keeps tool status executed and still runs generation', async () => {
    let generationCalled = false;
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
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

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: buildWeatherToolIntentPlannerOutput({
                        location: {
                            type: 'lat_lon',
                            latitude: 39.7684,
                            longitude: -86.1581,
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            generationCalled = true;
            return {
                text: 'Generated weather reply',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
        weatherForecastTool,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(generationCalled, true);
    assert.equal(capturedExecutionContext?.tool?.toolName, 'weather_forecast');
    assert.equal(capturedExecutionContext?.tool?.status, 'executed');
});

test('weather failure preserves fail-open generation with failed tool status and reason code', async () => {
    let capturedExecutionContext:
        | ResponseMetadataRuntimeContext['executionContext']
        | undefined;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => {
            throw new Error('weather upstream unavailable');
        },
    };

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: buildWeatherToolIntentPlannerOutput({
                        location: {
                            type: 'lat_lon',
                            latitude: 39.7684,
                            longitude: -86.1581,
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            return {
                text: 'Fallback non-tool weather response',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata: (_assistantMetadata, runtimeContext) => {
            capturedExecutionContext = runtimeContext.executionContext;
            return createMetadata();
        },
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
        weatherForecastTool,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(capturedExecutionContext?.tool?.toolName, 'weather_forecast');
    assert.equal(capturedExecutionContext?.tool?.status, 'failed');
    assert.equal(
        capturedExecutionContext?.tool?.reasonCode,
        'tool_execution_error'
    );
});

test('weather clarification short-circuits generation and records skipped generation metadata', async () => {
    let generationCalled = false;
    const weatherForecastTool: WeatherForecastTool = {
        fetchForecast: async () => ({
            toolName: 'weather_forecast',
            status: 'needs_clarification',
            request: {
                location: {
                    type: 'place_query',
                    query: 'New York',
                },
            },
            clarification: {
                reasonCode: 'ambiguous_location',
                question: 'Which New York did you mean?',
                options: [
                    {
                        id: 'nyc',
                        label: 'New York City, New York, United States',
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

    const orchestrator = createChatOrchestrator({
        generationRuntime: createGenerationRuntime(async (request) => {
            if (request.maxOutputTokens === PLANNER_TOKEN_SENTINEL) {
                return {
                    text: buildWeatherToolIntentPlannerOutput({
                        location: {
                            query: 'New York',
                        },
                    }),
                    model: 'gpt-5-mini',
                };
            }
            generationCalled = true;
            return {
                text: 'should not be generated',
                model: request.model,
                provenance: 'Inferred',
                citations: [],
            };
        }),
        storeTrace: async () => undefined,
        buildResponseMetadata,
        defaultModel: runtimeConfig.modelProfiles.defaultProfileId,
        recordUsage: () => undefined,
        weatherForecastTool,
    });

    const response = await orchestrator.runChat(createChatRequest());

    assert.equal(response.action, 'message');
    assert.equal(generationCalled, false);
    assert.match(response.message, /Which New York did you mean\?/);
    const toolEvent = response.metadata.execution?.find(
        (event) => event.kind === 'tool'
    );
    assert.equal(toolEvent?.toolName, 'weather_forecast');
    assert.equal(toolEvent?.status, 'executed');
    assert.equal(toolEvent?.clarification?.reasonCode, 'ambiguous_location');
    const generationEvent = response.metadata.execution?.find(
        (event) => event.kind === 'generation'
    );
    assert.equal(generationEvent?.status, 'skipped');
});
