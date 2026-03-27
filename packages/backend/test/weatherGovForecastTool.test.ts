/**
 * @description: Covers the backend-owned weather.gov forecast adapter normalization and fail-open behavior.
 * @footnote-scope: test
 * @footnote-module: WeatherGovForecastToolTests
 * @footnote-risk: low - Test-only coverage; runtime behavior lives in the adapter.
 * @footnote-ethics: medium - Reliable weather-tool behavior reduces overconfident claims on external forecast data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWeatherGovForecastTool } from '../src/services/weatherGovForecastTool.js';

type MockResponseInit = {
    ok: boolean;
    status: number;
    body: unknown;
};

const createMockResponse = ({ ok, status, body }: MockResponseInit): Response =>
    ({
        ok,
        status,
        async json() {
            return body;
        },
    }) as Response;

test('weather.gov tool resolves lat/lon through points and returns normalized forecast payload', async () => {
    const now = new Date('2026-03-27T12:00:00.000Z');
    const calls: string[] = [];
    const tool = createWeatherGovForecastTool({
        now: () => now,
        fetchImpl: async (input) => {
            const url = String(input);
            calls.push(url);
            if (url.includes('/points/')) {
                return createMockResponse({
                    ok: true,
                    status: 200,
                    body: {
                        properties: {
                            forecast:
                                'https://api.weather.gov/gridpoints/TOP/31,80/forecast',
                            gridId: 'TOP',
                            gridX: 31,
                            gridY: 80,
                            timeZone: 'America/Chicago',
                            relativeLocation: {
                                properties: {
                                    city: 'Topeka',
                                    state: 'KS',
                                },
                            },
                        },
                    },
                });
            }

            return createMockResponse({
                ok: true,
                status: 200,
                body: {
                    properties: {
                        generatedAt: '2026-03-27T11:55:00.000Z',
                        updateTime: '2026-03-27T11:50:00.000Z',
                        periods: [
                            {
                                name: 'Today',
                                startTime: '2026-03-27T12:00:00-05:00',
                                endTime: '2026-03-27T18:00:00-05:00',
                                isDaytime: true,
                                temperature: 58,
                                temperatureUnit: 'F',
                                windSpeed: '10 mph',
                                windDirection: 'NW',
                                shortForecast: 'Sunny',
                                detailedForecast: 'Sunny with light wind.',
                                probabilityOfPrecipitation: {
                                    value: 10,
                                },
                            },
                        ],
                    },
                },
            });
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'lat_lon',
            latitude: 39.0458,
            longitude: -95.6694,
        },
        horizonPeriods: 3,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.location.name, 'Topeka, KS');
        assert.equal(result.location.office, 'TOP');
        assert.equal(result.forecast.periods.length, 1);
        assert.equal(result.forecast.periods[0]?.temperature.value, 58);
        assert.equal(result.provenance.provider, 'weather.gov');
        assert.equal(
            result.provenance.endpoint,
            'https://api.weather.gov/gridpoints/TOP/31,80/forecast'
        );
        assert.equal(result.provenance.requestedAt, now.toISOString());
        assert.equal(
            result.provenance.resolvedFromEndpoint,
            'https://api.weather.gov/points/39.0458,-95.6694'
        );
    }
});

test('weather.gov tool supports resolved gridpoint input directly', async () => {
    const tool = createWeatherGovForecastTool({
        fetchImpl: async (input) => {
            const url = String(input);
            assert.match(url, /\/gridpoints\/TOP\/31,80\/forecast$/);
            return createMockResponse({
                ok: true,
                status: 200,
                body: {
                    properties: {
                        periods: [
                            {
                                name: 'Tonight',
                                startTime: '2026-03-27T18:00:00-05:00',
                                endTime: '2026-03-28T06:00:00-05:00',
                                isDaytime: false,
                                temperature: 41,
                                temperatureUnit: 'F',
                                windSpeed: '6 mph',
                                windDirection: 'NE',
                                shortForecast: 'Clear',
                                detailedForecast: 'Clear overnight.',
                            },
                        ],
                    },
                },
            });
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'gridpoint',
            office: 'top',
            gridX: 31,
            gridY: 80,
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.location.office, 'TOP');
        assert.equal(result.forecast.periods[0]?.name, 'Tonight');
    }
});

test('weather.gov tool returns timeout error result and remains serializable', async () => {
    const tool = createWeatherGovForecastTool({
        requestTimeoutMs: 1,
        fetchImpl: async (_input, init) =>
            await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            }),
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'gridpoint',
            office: 'TOP',
            gridX: 31,
            gridY: 80,
        },
    });

    assert.equal(result.status, 'error');
    if (result.status === 'error') {
        assert.equal(result.error.code, 'timeout');
        assert.equal(typeof JSON.stringify(result), 'string');
    }
});
