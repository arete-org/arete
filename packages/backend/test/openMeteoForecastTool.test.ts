/**
 * @description: Covers the backend-owned Open-Meteo forecast adapter normalization and fail-open behavior.
 * @footnote-scope: test
 * @footnote-module: OpenMeteoForecastToolTests
 * @footnote-risk: low - Test-only coverage; runtime behavior lives in the adapter.
 * @footnote-ethics: medium - Reliable weather-tool behavior reduces overconfident claims on external forecast data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpenMeteoForecastTool } from '../src/services/openMeteoForecastTool.js';

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

test('open-meteo tool resolves place query and returns normalized forecast payload', async () => {
    const now = new Date('2026-03-27T12:00:00.000Z');
    const calls: string[] = [];
    const tool = createOpenMeteoForecastTool({
        now: () => now,
        fetchImpl: async (input) => {
            const url = String(input);
            calls.push(url);
            if (url.includes('/v1/search')) {
                return createMockResponse({
                    ok: true,
                    status: 200,
                    body: {
                        results: [
                            {
                                name: 'Topeka',
                                latitude: 39.0483,
                                longitude: -95.678,
                                country_code: 'US',
                                admin1: 'Kansas',
                                timezone: 'America/Chicago',
                            },
                        ],
                    },
                });
            }

            return createMockResponse({
                ok: true,
                status: 200,
                body: {
                    timezone: 'America/Chicago',
                    daily_units: {
                        temperature_2m_max: 'C',
                        wind_speed_10m_max: 'km/h',
                    },
                    daily: {
                        time: ['2026-03-27'],
                        temperature_2m_max: [20],
                        temperature_2m_min: [10],
                        weather_code: [1],
                        precipitation_probability_max: [10],
                        wind_speed_10m_max: [16],
                        wind_direction_10m_dominant: [315],
                    },
                },
            });
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'place_query',
            query: 'Topeka',
        },
        horizonPeriods: 3,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.location.name, 'Topeka');
        assert.equal(result.location.countryCode, 'US');
        assert.equal(result.forecast.periods.length, 1);
        assert.equal(result.forecast.periods[0]?.temperature.value, 15);
        assert.equal(result.provenance.provider, 'open-meteo');
        assert.match(result.provenance.endpoint, /api\.open-meteo\.com/);
        assert.equal(result.provenance.requestedAt, now.toISOString());
        assert.match(
            String(result.provenance.resolvedFromEndpoint),
            /geocoding-api\.open-meteo\.com/
        );
    }
});

test('open-meteo tool supports direct lat/lon input', async () => {
    const tool = createOpenMeteoForecastTool({
        fetchImpl: async (input) => {
            const url = String(input);
            assert.match(url, /api\.open-meteo\.com\/v1\/forecast/);
            return createMockResponse({
                ok: true,
                status: 200,
                body: {
                    daily_units: {
                        temperature_2m_max: 'C',
                        wind_speed_10m_max: 'km/h',
                    },
                    daily: {
                        time: ['2026-03-27'],
                        temperature_2m_max: [11],
                        temperature_2m_min: [3],
                        weather_code: [0],
                        wind_speed_10m_max: [8],
                        wind_direction_10m_dominant: [45],
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
    });

    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.location.latitude, 39.0458);
        assert.equal(result.forecast.periods[0]?.name, 'Today');
    }
});

test('open-meteo tool returns timeout error result and remains serializable', async () => {
    const tool = createOpenMeteoForecastTool({
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
            type: 'place_query',
            query: 'Topeka',
        },
    });

    assert.equal(result.status, 'error');
    if (result.status === 'error') {
        assert.equal(result.error.code, 'timeout');
        assert.equal(typeof JSON.stringify(result), 'string');
    }
});

test('open-meteo tool returns location_not_resolved when geocoding returns no results', async () => {
    const tool = createOpenMeteoForecastTool({
        fetchImpl: async (input) => {
            const url = String(input);
            if (url.includes('/v1/search')) {
                return createMockResponse({
                    ok: true,
                    status: 200,
                    body: {},
                });
            }
            throw new Error('should not reach forecast call');
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'place_query',
            query: 'NonExistentPlace12345',
        },
    });

    assert.equal(result.status, 'error');
    if (result.status === 'error') {
        assert.equal(result.error.code, 'location_not_resolved');
        assert.match(result.error.message, /no matching location/i);
    }
});

test('open-meteo tool returns invalid_response when geocoding returns result without coords', async () => {
    const tool = createOpenMeteoForecastTool({
        fetchImpl: async (input) => {
            const url = String(input);
            if (url.includes('/v1/search')) {
                return createMockResponse({
                    ok: true,
                    status: 200,
                    body: {
                        results: [
                            {
                                name: 'Ambiguous',
                            },
                        ],
                    },
                });
            }
            throw new Error('should not reach forecast call');
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'place_query',
            query: 'Ambiguous',
        },
    });

    assert.equal(result.status, 'error');
    if (result.status === 'error') {
        assert.equal(result.error.code, 'invalid_response');
        assert.match(result.error.message, /without usable coordinates/i);
    }
});

test('open-meteo tool resolves place query with countryCode context', async () => {
    const calls: string[] = [];
    const tool = createOpenMeteoForecastTool({
        fetchImpl: async (input) => {
            const url = String(input);
            calls.push(url);
            if (url.includes('/v1/search')) {
                assert.match(url, /countryCode=US/);
                return createMockResponse({
                    ok: true,
                    status: 200,
                    body: {
                        results: [
                            {
                                name: 'Indianapolis',
                                latitude: 39.7684,
                                longitude: -86.1581,
                                country_code: 'US',
                                admin1: 'Indiana',
                                timezone: 'America/Indiana/Indianapolis',
                            },
                        ],
                    },
                });
            }
            return createMockResponse({
                ok: true,
                status: 200,
                body: {
                    daily_units: {
                        temperature_2m_max: 'C',
                        wind_speed_10m_max: 'km/h',
                    },
                    daily: {
                        time: ['2026-04-29'],
                        temperature_2m_max: [18],
                        temperature_2m_min: [8],
                        weather_code: [3],
                        precipitation_probability_max: [20],
                        wind_speed_10m_max: [20],
                        wind_direction_10m_dominant: [180],
                    },
                },
            });
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'place_query',
            query: 'Indianapolis',
            countryCode: 'US',
        },
    });

    assert.equal(calls.length, 2);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.location.name, 'Indianapolis');
        assert.equal(result.location.admin1, 'Indiana');
    }
});

test('open-meteo tool returns needs_clarification for same-name locations in different admin regions', async () => {
    const tool = createOpenMeteoForecastTool({
        fetchImpl: async (input) => {
            const url = String(input);
            if (url.includes('/v1/search')) {
                return createMockResponse({
                    ok: true,
                    status: 200,
                    body: {
                        results: [
                            {
                                name: 'Springfield',
                                latitude: 39.7817,
                                longitude: -89.6501,
                                country_code: 'US',
                                admin1: 'Illinois',
                                population: 114394,
                            },
                            {
                                name: 'Springfield',
                                latitude: 42.1015,
                                longitude: -72.5898,
                                country_code: 'US',
                                admin1: 'Massachusetts',
                                population: 155770,
                            },
                        ],
                    },
                });
            }
            throw new Error('should not reach forecast call');
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'place_query',
            query: 'Springfield',
        },
    });

    assert.equal(result.status, 'needs_clarification');
    if (result.status === 'needs_clarification') {
        assert.equal(result.clarification.reasonCode, 'ambiguous_location');
        assert.equal(result.clarification.options.length, 2);
        assert.match(result.clarification.question, /Which location/);
    }
});

test('open-meteo tool selects top result when countryCode is provided', async () => {
    const tool = createOpenMeteoForecastTool({
        fetchImpl: async (input) => {
            const url = String(input);
            if (url.includes('/v1/search')) {
                return createMockResponse({
                    ok: true,
                    status: 200,
                    body: {
                        results: [
                            {
                                name: 'Toronto',
                                latitude: 43.6532,
                                longitude: -79.3832,
                                country_code: 'CA',
                                admin1: 'Ontario',
                            },
                            {
                                name: 'Toronto',
                                latitude: 43.6532,
                                longitude: -79.3832,
                                country_code: 'US',
                                admin1: 'Ohio',
                            },
                        ],
                    },
                });
            }
            return createMockResponse({
                ok: true,
                status: 200,
                body: {
                    daily_units: {
                        temperature_2m_max: 'C',
                        wind_speed_10m_max: 'km/h',
                    },
                    daily: {
                        time: ['2026-04-29'],
                        temperature_2m_max: [15],
                        temperature_2m_min: [5],
                        weather_code: [0],
                        precipitation_probability_max: [10],
                        wind_speed_10m_max: [10],
                        wind_direction_10m_dominant: [180],
                    },
                },
            });
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'place_query',
            query: 'Toronto',
            countryCode: 'CA',
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.location.name, 'Toronto');
        assert.equal(result.location.countryCode, 'CA');
    }
});

test('open-meteo tool returns location_not_resolved when no geocoding results', async () => {
    const tool = createOpenMeteoForecastTool({
        fetchImpl: async (_input) => {
            return createMockResponse({
                ok: true,
                status: 200,
                body: {},
            });
        },
    });

    const result = await tool.fetchForecast({
        location: {
            type: 'place_query',
            query: 'NonExistentPlace12345',
        },
    });

    assert.equal(result.status, 'error');
    if (result.status === 'error') {
        assert.equal(result.error.code, 'location_not_resolved');
    }
});
