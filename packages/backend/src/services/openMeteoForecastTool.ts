/**
 * @description: Backend-owned Open-Meteo forecast retrieval with optional place-name geocoding and normalized serializable output.
 * Keeps provider specifics (geocoding + forecast endpoint contracts) inside one fail-open tool boundary.
 * @footnote-scope: core
 * @footnote-module: OpenMeteoForecastTool
 * @footnote-risk: medium - Parsing or transport regressions can degrade weather retrieval quality, but blast radius is isolated to one optional tool path.
 * @footnote-ethics: medium - Forecast errors can impact user decisions, so the adapter preserves provenance and explicit uncertainty.
 */
import type { ToolClarification } from '@footnote/contracts/ethics-core';
import type { ChatGenerationWeatherRequest } from './chatGenerationTypes.js';

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODING_URL =
    'https://geocoding-api.open-meteo.com/v1/search';
const DEFAULT_REQUEST_TIMEOUT_MS = 6_000;
const DEFAULT_HORIZON_PERIODS = 5;
const MIN_HORIZON_PERIODS = 1;
const MAX_HORIZON_PERIODS = 12;

type FetchLike = typeof fetch;

type WeatherToolErrorCode =
    | 'timeout'
    | 'http_error'
    | 'network_error'
    | 'invalid_response'
    | 'location_not_resolved';

type JsonFetchSuccess<TValue> = {
    ok: true;
    data: TValue;
};

type JsonFetchFailure = {
    ok: false;
    code: WeatherToolErrorCode;
    message: string;
    httpStatus?: number;
};

type JsonFetchResult<TValue> = JsonFetchSuccess<TValue> | JsonFetchFailure;

type OpenMeteoGeocodingResult = {
    name?: string;
    latitude?: number;
    longitude?: number;
    country_code?: string;
    admin1?: string;
    admin2?: string;
    timezone?: string;
    population?: number;
};

type OpenMeteoGeocodingResponse = {
    results?: OpenMeteoGeocodingResult[];
};

type OpenMeteoDailyUnits = {
    temperature_2m_max?: string;
    wind_speed_10m_max?: string;
};

type OpenMeteoDaily = {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
    precipitation_probability_max?: number[];
    wind_speed_10m_max?: number[];
    wind_direction_10m_dominant?: number[];
};

type OpenMeteoForecastResponse = {
    latitude?: number;
    longitude?: number;
    timezone?: string;
    generationtime_ms?: number;
    daily_units?: OpenMeteoDailyUnits;
    daily?: OpenMeteoDaily;
};

export type WeatherForecastRequest = ChatGenerationWeatherRequest;

export type WeatherForecastPeriod = {
    name: string;
    startsAt: string;
    endsAt: string;
    isDaytime: boolean;
    temperature: {
        value: number;
        unit: string;
    };
    wind: {
        speed: string;
        direction: string;
    };
    shortForecast: string;
    detailedForecast: string;
    precipitationProbability?: number;
};

export type WeatherToolProvenance = {
    provider: 'open-meteo';
    endpoint: string;
    requestedAt: string;
    resolvedFromEndpoint?: string;
};

export type WeatherForecastToolResult =
    | {
          toolName: 'weather_forecast';
          status: 'ok';
          request: WeatherForecastRequest;
          location: {
              name?: string;
              timezone?: string;
              latitude?: number;
              longitude?: number;
              countryCode?: string;
              admin1?: string;
              population?: number;
          };
          forecast: {
              generatedAt?: string;
              updatedAt?: string;
              periods: WeatherForecastPeriod[];
          };
          provenance: WeatherToolProvenance;
      }
    | {
          toolName: 'weather_forecast';
          status: 'error';
          request: WeatherForecastRequest;
          error: {
              code: WeatherToolErrorCode;
              message: string;
              httpStatus?: number;
          };
          provenance: WeatherToolProvenance;
      }
    | {
          toolName: 'weather_forecast';
          status: 'needs_clarification';
          request: WeatherForecastRequest;
          clarification: ToolClarification;
          provenance: WeatherToolProvenance;
      };

export type WeatherForecastTool = {
    fetchForecast: (
        request: WeatherForecastRequest
    ) => Promise<WeatherForecastToolResult>;
};

export type CreateOpenMeteoForecastToolOptions = {
    requestTimeoutMs?: number;
    fetchImpl?: FetchLike;
    now?: () => Date;
};

const clampHorizonPeriods = (horizonPeriods: number | undefined): number => {
    if (
        typeof horizonPeriods !== 'number' ||
        !Number.isFinite(horizonPeriods) ||
        !Number.isInteger(horizonPeriods)
    ) {
        return DEFAULT_HORIZON_PERIODS;
    }

    return Math.min(
        MAX_HORIZON_PERIODS,
        Math.max(MIN_HORIZON_PERIODS, horizonPeriods)
    );
};

const createTimeoutSignal = (
    timeoutMs: number
): {
    signal: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
} => {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timeoutHandle),
        didTimeout: () => timedOut,
    };
};

const fetchJson = async <TValue>(
    url: string,
    timeoutMs: number,
    fetchImpl: FetchLike
): Promise<JsonFetchResult<TValue>> => {
    const abortContext = createTimeoutSignal(timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
            },
            signal: abortContext.signal,
        });

        if (!response.ok) {
            return {
                ok: false,
                code: 'http_error',
                message: `open-meteo responded with HTTP ${response.status}`,
                httpStatus: response.status,
            };
        }

        const payload = (await response.json()) as unknown;
        if (
            typeof payload !== 'object' ||
            payload === null ||
            Array.isArray(payload)
        ) {
            return {
                ok: false,
                code: 'invalid_response',
                message: 'Open-Meteo response is not a valid object',
            };
        }
        return {
            ok: true,
            data: payload as TValue,
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return {
                ok: false,
                code: abortContext.didTimeout() ? 'timeout' : 'network_error',
                message: abortContext.didTimeout()
                    ? `open-meteo request timed out after ${timeoutMs}ms`
                    : 'open-meteo request aborted',
            };
        }

        return {
            ok: false,
            code: 'network_error',
            message:
                error instanceof Error
                    ? error.message
                    : 'open-meteo request failed',
        };
    } finally {
        abortContext.cleanup();
    }
};

const weatherCodeToLabel = (weatherCode: number): string => {
    if (weatherCode === 0) {
        return 'Clear sky';
    }
    if (weatherCode >= 1 && weatherCode <= 3) {
        return 'Partly cloudy';
    }
    if (weatherCode === 45 || weatherCode === 48) {
        return 'Fog';
    }
    if (weatherCode >= 51 && weatherCode <= 57) {
        return 'Drizzle';
    }
    if (weatherCode >= 58 && weatherCode <= 60) {
        return 'Mixed rain and drizzle';
    }
    if (weatherCode >= 61 && weatherCode <= 67) {
        return 'Rain';
    }
    if (weatherCode >= 71 && weatherCode <= 77) {
        return 'Snow';
    }
    if (weatherCode >= 80 && weatherCode <= 82) {
        return 'Rain showers';
    }
    if (weatherCode >= 85 && weatherCode <= 86) {
        return 'Snow showers';
    }
    if (weatherCode >= 95) {
        return 'Thunderstorm';
    }
    return 'Variable conditions';
};

const toWindDirectionLabel = (degrees: number): string => {
    const normalized = ((degrees % 360) + 360) % 360;
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(normalized / 45) % 8;
    return directions[index] ?? 'N';
};

const buildErrorResult = ({
    request,
    requestedAt,
    endpoint,
    resolvedFromEndpoint,
    code,
    message,
    httpStatus,
}: {
    request: WeatherForecastRequest;
    requestedAt: string;
    endpoint: string;
    resolvedFromEndpoint?: string;
    code: WeatherToolErrorCode;
    message: string;
    httpStatus?: number;
}): WeatherForecastToolResult => ({
    toolName: 'weather_forecast',
    status: 'error',
    request,
    error: {
        code,
        message,
        ...(httpStatus !== undefined && { httpStatus }),
    },
    provenance: {
        provider: 'open-meteo',
        endpoint,
        requestedAt,
        ...(resolvedFromEndpoint !== undefined && { resolvedFromEndpoint }),
    },
});

const buildClarificationResult = ({
    request,
    requestedAt,
    endpoint,
    resolvedFromEndpoint,
    candidates,
}: {
    request: WeatherForecastRequest;
    requestedAt: string;
    endpoint: string;
    resolvedFromEndpoint?: string;
    candidates: OpenMeteoGeocodingResult[];
}): WeatherForecastToolResult => {
    const toStableOptionId = (
        candidate: OpenMeteoGeocodingResult & {
            latitude: number;
            longitude: number;
        },
        index: number
    ): string => {
        const slugPart = (value: string | undefined): string =>
            (value ?? '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
        const lat = candidate.latitude.toFixed(4).replace('.', '_');
        const lon = candidate.longitude.toFixed(4).replace('.', '_');
        const base = [
            slugPart(candidate.name),
            slugPart(candidate.admin1),
            slugPart(candidate.country_code),
            `lat${lat}`,
            `lon${lon}`,
        ]
            .filter((part) => part.length > 0)
            .join('__');
        return base.length > 0 ? base : `option-${index}`;
    };

    const validCandidates = candidates.filter(
        (
            c
        ): c is OpenMeteoGeocodingResult & {
            latitude: number;
            longitude: number;
        } =>
            typeof c.latitude === 'number' &&
            Number.isFinite(c.latitude) &&
            typeof c.longitude === 'number' &&
            Number.isFinite(c.longitude)
    );

    if (validCandidates.length === 0) {
        return buildErrorResult({
            request,
            requestedAt,
            endpoint,
            resolvedFromEndpoint,
            code: 'invalid_response',
            message:
                'open-meteo geocoding returned no locations with valid coordinates.',
        });
    }

    const options = validCandidates.map((c, i) => ({
        id: toStableOptionId(c, i),
        label: [c.name, c.admin1, c.admin2, c.country_code]
            .filter(Boolean)
            .join(', '),
        value: {
            toolName: 'weather_forecast',
            input: {
                location: {
                    type: 'lat_lon' as const,
                    latitude: c.latitude,
                    longitude: c.longitude,
                },
            },
        },
    }));

    return {
        toolName: 'weather_forecast',
        status: 'needs_clarification',
        request,
        clarification: {
            reasonCode: 'ambiguous_location',
            question: 'Which location did you mean?',
            options,
        },
        provenance: {
            provider: 'open-meteo',
            endpoint,
            requestedAt,
            ...(resolvedFromEndpoint !== undefined && { resolvedFromEndpoint }),
        },
    };
};

const isAmbiguousLocation = ({
    query,
    countryCode,
    candidates,
}: {
    query: string;
    countryCode?: string;
    candidates: OpenMeteoGeocodingResult[];
}): boolean => {
    if (candidates.length < 2) {
        return false;
    }

    if (countryCode !== undefined) {
        return false;
    }

    const queryWords = query.trim().split(/\s+/).length;
    if (queryWords >= 3) {
        return false;
    }

    const top = candidates[0];
    const second = candidates[1];

    if (top.population !== undefined && second.population !== undefined) {
        const ratio = second.population / top.population;
        if (ratio < 0.1) {
            return false;
        }
    }

    const normalize = (value: string | undefined): string =>
        value?.trim().toLowerCase() ?? '';
    const topName = normalize(top.name);
    const secondName = normalize(second.name);
    const queryName = normalize(query);
    const sameNameFamily =
        (topName.length > 0 && topName === secondName) ||
        (queryName.length > 0 &&
            (topName === queryName || secondName === queryName));
    if (!sameNameFamily) {
        return false;
    }

    const hasDifferentContext =
        normalize(top.admin1) !== normalize(second.admin1) ||
        normalize(top.admin2) !== normalize(second.admin2) ||
        normalize(top.country_code) !== normalize(second.country_code);

    return hasDifferentContext;
};

/**
 * Creates the backend weather tool adapter used by orchestration.
 *
 * The adapter accepts either explicit coordinates or a user-facing place
 * query, resolves provider data, and always returns a serializable result
 * object so fail-open orchestration can preserve provenance.
 */
export const createOpenMeteoForecastTool = ({
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    now = () => new Date(),
}: CreateOpenMeteoForecastToolOptions = {}): WeatherForecastTool => {
    const fetchForecast = async (
        request: WeatherForecastRequest
    ): Promise<WeatherForecastToolResult> => {
        const requestedAt = now().toISOString();
        const horizonPeriods = clampHorizonPeriods(request.horizonPeriods);

        let latitude: number | undefined;
        let longitude: number | undefined;
        let locationName: string | undefined;
        let timezone: string | undefined;
        let countryCode: string | undefined;
        let admin1: string | undefined;
        let population: number | undefined;
        let resolvedFromEndpoint: string | undefined;

        if (request.location.type === 'lat_lon') {
            latitude = request.location.latitude;
            longitude = request.location.longitude;
        } else {
            // Place names are resolved deterministically in backend so planner
            // output can stay simple and user-facing.
            const geocodingUrl = new URL(OPEN_METEO_GEOCODING_URL);
            geocodingUrl.searchParams.set('name', request.location.query);
            geocodingUrl.searchParams.set('count', '5');
            geocodingUrl.searchParams.set('language', 'en');
            geocodingUrl.searchParams.set('format', 'json');
            if (request.location.countryCode) {
                geocodingUrl.searchParams.set(
                    'countryCode',
                    request.location.countryCode
                );
            }
            resolvedFromEndpoint = geocodingUrl.toString();

            const geocodingResponse =
                await fetchJson<OpenMeteoGeocodingResponse>(
                    resolvedFromEndpoint,
                    requestTimeoutMs,
                    fetchImpl
                );
            if (!geocodingResponse.ok) {
                return buildErrorResult({
                    request,
                    requestedAt,
                    endpoint: resolvedFromEndpoint,
                    code: geocodingResponse.code,
                    message: geocodingResponse.message,
                    httpStatus: geocodingResponse.httpStatus,
                });
            }

            const geocodingResults = geocodingResponse.data.results ?? [];
            if (geocodingResults.length === 0) {
                return buildErrorResult({
                    request,
                    requestedAt,
                    endpoint: resolvedFromEndpoint,
                    code: 'location_not_resolved',
                    message:
                        'open-meteo geocoding found no matching location for query.',
                });
            }

            const candidateCount = geocodingResults.length;
            const hasContext =
                request.location.type === 'place_query'
                    ? request.location.countryCode !== undefined
                    : false;
            const query =
                request.location.type === 'place_query'
                    ? request.location.query
                    : '';

            if (candidateCount >= 2 && !hasContext) {
                const ambiguous = isAmbiguousLocation({
                    query,
                    countryCode:
                        request.location.type === 'place_query'
                            ? request.location.countryCode
                            : undefined,
                    candidates: geocodingResults,
                });
                if (ambiguous) {
                    return buildClarificationResult({
                        request,
                        requestedAt,
                        endpoint: resolvedFromEndpoint,
                        resolvedFromEndpoint,
                        candidates: geocodingResults.slice(0, 5),
                    });
                }
            }

            const firstResult = geocodingResults[0];
            if (
                typeof firstResult.latitude !== 'number' ||
                typeof firstResult.longitude !== 'number'
            ) {
                return buildErrorResult({
                    request,
                    requestedAt,
                    endpoint: resolvedFromEndpoint,
                    code: 'invalid_response',
                    message:
                        'open-meteo geocoding returned a location without usable coordinates.',
                });
            }

            latitude = firstResult.latitude;
            longitude = firstResult.longitude;
            locationName =
                typeof firstResult.name === 'string'
                    ? firstResult.name
                    : undefined;
            timezone =
                typeof firstResult.timezone === 'string'
                    ? firstResult.timezone
                    : undefined;
            countryCode =
                typeof firstResult.country_code === 'string'
                    ? firstResult.country_code
                    : undefined;
            admin1 =
                typeof firstResult.admin1 === 'string'
                    ? firstResult.admin1
                    : undefined;
            population =
                typeof firstResult.population === 'number' &&
                Number.isFinite(firstResult.population)
                    ? firstResult.population
                    : undefined;
        }

        if (latitude === undefined || longitude === undefined) {
            return buildErrorResult({
                request,
                requestedAt,
                endpoint: OPEN_METEO_FORECAST_URL,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
                code: 'invalid_response',
                message: 'open-meteo did not resolve forecast coordinates.',
            });
        }

        const forecastUrl = new URL(OPEN_METEO_FORECAST_URL);
        forecastUrl.searchParams.set('latitude', String(latitude));
        forecastUrl.searchParams.set('longitude', String(longitude));
        forecastUrl.searchParams.set(
            'daily',
            'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant'
        );
        forecastUrl.searchParams.set('timezone', 'auto');
        forecastUrl.searchParams.set('forecast_days', String(horizonPeriods));

        const forecastEndpoint = forecastUrl.toString();
        const forecastResponse = await fetchJson<OpenMeteoForecastResponse>(
            forecastEndpoint,
            requestTimeoutMs,
            fetchImpl
        );
        if (!forecastResponse.ok) {
            return buildErrorResult({
                request,
                requestedAt,
                endpoint: forecastEndpoint,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
                code: forecastResponse.code,
                message: forecastResponse.message,
                httpStatus: forecastResponse.httpStatus,
            });
        }

        const daily = forecastResponse.data.daily;
        const time = daily?.time;
        const tempMax = daily?.temperature_2m_max;
        const tempMin = daily?.temperature_2m_min;
        const weatherCode = daily?.weather_code;
        const precipMax = daily?.precipitation_probability_max;
        const windSpeed = daily?.wind_speed_10m_max;
        const windDirection = daily?.wind_direction_10m_dominant;
        if (
            !Array.isArray(time) ||
            !Array.isArray(tempMax) ||
            !Array.isArray(tempMin) ||
            !Array.isArray(weatherCode) ||
            !Array.isArray(windSpeed) ||
            !Array.isArray(windDirection)
        ) {
            return buildErrorResult({
                request,
                requestedAt,
                endpoint: forecastEndpoint,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
                code: 'invalid_response',
                message:
                    'open-meteo forecast payload did not include required daily arrays.',
            });
        }

        const tempUnit =
            typeof forecastResponse.data.daily_units?.temperature_2m_max ===
            'string'
                ? forecastResponse.data.daily_units.temperature_2m_max
                : 'C';
        const windUnit =
            typeof forecastResponse.data.daily_units?.wind_speed_10m_max ===
            'string'
                ? forecastResponse.data.daily_units.wind_speed_10m_max
                : 'km/h';

        const periods: WeatherForecastPeriod[] = [];
        const usableLength = Math.min(
            horizonPeriods,
            time.length,
            tempMax.length,
            tempMin.length,
            weatherCode.length,
            windSpeed.length,
            windDirection.length
        );
        for (let index = 0; index < usableLength; index += 1) {
            const day = time[index];
            const dayMax = tempMax[index];
            const dayMin = tempMin[index];
            const dayCode = weatherCode[index];
            const dayWind = windSpeed[index];
            const dayWindDirection = windDirection[index];
            if (
                typeof day !== 'string' ||
                typeof dayMax !== 'number' ||
                !Number.isFinite(dayMax) ||
                typeof dayMin !== 'number' ||
                !Number.isFinite(dayMin) ||
                typeof dayCode !== 'number' ||
                !Number.isFinite(dayCode) ||
                typeof dayWind !== 'number' ||
                !Number.isFinite(dayWind) ||
                typeof dayWindDirection !== 'number' ||
                !Number.isFinite(dayWindDirection)
            ) {
                continue;
            }

            const label = weatherCodeToLabel(dayCode);
            // Open-Meteo daily payload does not include day/night split text,
            // so we synthesize a compact daily period summary.
            periods.push({
                name: index === 0 ? 'Today' : `Day ${index + 1}`,
                startsAt: `${day}T00:00:00`,
                endsAt: `${day}T23:59:59`,
                isDaytime: true,
                temperature: {
                    value: Number(((dayMax + dayMin) / 2).toFixed(1)),
                    unit: tempUnit,
                },
                wind: {
                    speed: `${Math.round(dayWind)} ${windUnit}`,
                    direction: toWindDirectionLabel(dayWindDirection),
                },
                shortForecast: label,
                detailedForecast: `${label}. High ${Math.round(dayMax)}${tempUnit}, low ${Math.round(dayMin)}${tempUnit}.`,
                ...(typeof precipMax?.[index] === 'number' &&
                    Number.isFinite(precipMax[index]) && {
                        precipitationProbability: Math.max(
                            0,
                            Math.min(100, Math.round(precipMax[index]))
                        ),
                    }),
            });
        }

        if (periods.length === 0) {
            return buildErrorResult({
                request,
                requestedAt,
                endpoint: forecastEndpoint,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
                code: 'invalid_response',
                message:
                    'open-meteo forecast payload did not contain usable forecast periods.',
            });
        }

        return {
            toolName: 'weather_forecast',
            status: 'ok',
            request: {
                ...request,
                horizonPeriods,
            },
            location: {
                ...(locationName !== undefined && { name: locationName }),
                ...(typeof forecastResponse.data.timezone === 'string' && {
                    timezone: forecastResponse.data.timezone,
                }),
                ...(timezone !== undefined && {
                    timezone:
                        forecastResponse.data.timezone !== undefined
                            ? forecastResponse.data.timezone
                            : timezone,
                }),
                latitude,
                longitude,
                ...(countryCode !== undefined && { countryCode }),
                ...(admin1 !== undefined && { admin1 }),
                ...(population !== undefined && { population }),
            },
            forecast: {
                generatedAt: requestedAt,
                periods,
            },
            provenance: {
                provider: 'open-meteo',
                endpoint: forecastEndpoint,
                requestedAt,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
            },
        };
    };

    return {
        fetchForecast,
    };
};
