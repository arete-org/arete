/**
 * @description: Backend-owned thin adapter for weather.gov forecast retrieval with normalized, serializable output.
 * Keeps provider specifics (points/gridpoints endpoints and payload guards) inside one fail-open tool boundary.
 * @footnote-scope: core
 * @footnote-module: WeatherGovForecastTool
 * @footnote-risk: medium - Parsing or transport regressions can degrade weather retrieval quality, but blast radius is isolated to one optional tool path.
 * @footnote-ethics: medium - Forecast errors can impact user decisions, so the adapter preserves provenance and explicit uncertainty.
 */
import type { ChatGenerationWeatherRequest } from './chatGenerationTypes.js';

const WEATHER_GOV_BASE_URL = 'https://api.weather.gov';
const WEATHER_GOV_USER_AGENT =
    'footnote-weather-pilot/0.1 (https://github.com/footnote-ai/footnote)';
const DEFAULT_REQUEST_TIMEOUT_MS = 6_000;
const DEFAULT_HORIZON_PERIODS = 5;
const MIN_HORIZON_PERIODS = 1;
const MAX_HORIZON_PERIODS = 12;

type FetchLike = typeof fetch;

type WeatherGovPointResponse = {
    properties?: {
        forecast?: string;
        forecastHourly?: string;
        relativeLocation?: {
            properties?: {
                city?: string;
                state?: string;
            };
        };
        gridId?: string;
        gridX?: number;
        gridY?: number;
        timeZone?: string;
    };
};

type WeatherGovForecastResponse = {
    properties?: {
        generatedAt?: string;
        updateTime?: string;
        periods?: unknown[];
    };
};

type WeatherGovForecastPeriod = {
    name?: string;
    startTime?: string;
    endTime?: string;
    isDaytime?: boolean;
    temperature?: number;
    temperatureUnit?: string;
    windSpeed?: string;
    windDirection?: string;
    shortForecast?: string;
    detailedForecast?: string;
    probabilityOfPrecipitation?: {
        value?: number | null;
    };
};

type WeatherToolErrorCode =
    | 'timeout'
    | 'http_error'
    | 'network_error'
    | 'invalid_response';

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
    provider: 'weather.gov';
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
              office?: string;
              gridX?: number;
              gridY?: number;
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
              code:
                  | 'timeout'
                  | 'http_error'
                  | 'network_error'
                  | 'invalid_response';
              message: string;
              httpStatus?: number;
          };
          provenance: WeatherToolProvenance;
      };

export type WeatherForecastTool = {
    fetchForecast: (
        request: WeatherForecastRequest
    ) => Promise<WeatherForecastToolResult>;
};

export type CreateWeatherGovForecastToolOptions = {
    requestTimeoutMs?: number;
    fetchImpl?: FetchLike;
    now?: () => Date;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const toAbsoluteWeatherGovUrl = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    try {
        const parsed = new URL(trimmed, WEATHER_GOV_BASE_URL);
        return parsed.toString();
    } catch {
        return null;
    }
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

const formatLatLon = (value: number): string =>
    value.toFixed(4).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');

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
                Accept: 'application/geo+json, application/json',
                'User-Agent': WEATHER_GOV_USER_AGENT,
            },
            signal: abortContext.signal,
        });

        if (!response.ok) {
            return {
                ok: false,
                code: 'http_error',
                message: `weather.gov responded with HTTP ${response.status}`,
                httpStatus: response.status,
            };
        }

        const payload = (await response.json()) as unknown;
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
                    ? `weather.gov request timed out after ${timeoutMs}ms`
                    : 'weather.gov request aborted',
            };
        }

        return {
            ok: false,
            code: 'network_error',
            message:
                error instanceof Error
                    ? error.message
                    : 'weather.gov request failed',
        };
    } finally {
        abortContext.cleanup();
    }
};

const normalizeForecastPeriod = (
    value: unknown
): WeatherForecastPeriod | null => {
    if (!isObjectRecord(value)) {
        return null;
    }

    const rawPeriod = value as WeatherGovForecastPeriod;
    if (
        typeof rawPeriod.name !== 'string' ||
        typeof rawPeriod.startTime !== 'string' ||
        typeof rawPeriod.endTime !== 'string' ||
        typeof rawPeriod.isDaytime !== 'boolean' ||
        typeof rawPeriod.temperature !== 'number' ||
        typeof rawPeriod.temperatureUnit !== 'string' ||
        typeof rawPeriod.windSpeed !== 'string' ||
        typeof rawPeriod.windDirection !== 'string' ||
        typeof rawPeriod.shortForecast !== 'string' ||
        typeof rawPeriod.detailedForecast !== 'string'
    ) {
        return null;
    }

    const normalized: WeatherForecastPeriod = {
        name: rawPeriod.name,
        startsAt: rawPeriod.startTime,
        endsAt: rawPeriod.endTime,
        isDaytime: rawPeriod.isDaytime,
        temperature: {
            value: rawPeriod.temperature,
            unit: rawPeriod.temperatureUnit,
        },
        wind: {
            speed: rawPeriod.windSpeed,
            direction: rawPeriod.windDirection,
        },
        shortForecast: rawPeriod.shortForecast,
        detailedForecast: rawPeriod.detailedForecast,
    };

    if (
        typeof rawPeriod.probabilityOfPrecipitation?.value === 'number' &&
        Number.isFinite(rawPeriod.probabilityOfPrecipitation.value)
    ) {
        normalized.precipitationProbability = Math.max(
            0,
            Math.min(
                100,
                Math.round(rawPeriod.probabilityOfPrecipitation.value)
            )
        );
    }

    return normalized;
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
        provider: 'weather.gov',
        endpoint,
        requestedAt,
        ...(resolvedFromEndpoint !== undefined && { resolvedFromEndpoint }),
    },
});

export const createWeatherGovForecastTool = ({
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    now = () => new Date(),
}: CreateWeatherGovForecastToolOptions = {}): WeatherForecastTool => {
    const fetchForecast = async (
        request: WeatherForecastRequest
    ): Promise<WeatherForecastToolResult> => {
        const requestedAt = now().toISOString();
        const horizonPeriods = clampHorizonPeriods(request.horizonPeriods);

        let forecastEndpoint: string | null = null;
        let resolvedFromEndpoint: string | undefined;
        let locationName: string | undefined;
        let timezone: string | undefined;
        let office: string | undefined;
        let gridX: number | undefined;
        let gridY: number | undefined;
        let latitude: number | undefined;
        let longitude: number | undefined;

        if (request.location.type === 'lat_lon') {
            latitude = request.location.latitude;
            longitude = request.location.longitude;
            resolvedFromEndpoint = `${WEATHER_GOV_BASE_URL}/points/${formatLatLon(latitude)},${formatLatLon(longitude)}`;

            const pointsResponse = await fetchJson<WeatherGovPointResponse>(
                resolvedFromEndpoint,
                requestTimeoutMs,
                fetchImpl
            );
            if (!pointsResponse.ok) {
                return buildErrorResult({
                    request,
                    requestedAt,
                    endpoint: resolvedFromEndpoint,
                    code: pointsResponse.code,
                    message: pointsResponse.message,
                    httpStatus: pointsResponse.httpStatus,
                });
            }

            const pointProperties = pointsResponse.data.properties;
            const forecastUrlRaw =
                typeof pointProperties?.forecast === 'string'
                    ? pointProperties.forecast
                    : typeof pointProperties?.forecastHourly === 'string'
                      ? pointProperties.forecastHourly
                      : undefined;
            forecastEndpoint = forecastUrlRaw
                ? toAbsoluteWeatherGovUrl(forecastUrlRaw)
                : null;
            office =
                typeof pointProperties?.gridId === 'string'
                    ? pointProperties.gridId
                    : undefined;
            gridX =
                typeof pointProperties?.gridX === 'number'
                    ? pointProperties.gridX
                    : undefined;
            gridY =
                typeof pointProperties?.gridY === 'number'
                    ? pointProperties.gridY
                    : undefined;
            timezone =
                typeof pointProperties?.timeZone === 'string'
                    ? pointProperties.timeZone
                    : undefined;
            const city = pointProperties?.relativeLocation?.properties?.city;
            const state = pointProperties?.relativeLocation?.properties?.state;
            if (
                typeof city === 'string' &&
                city.trim() &&
                typeof state === 'string' &&
                state.trim()
            ) {
                locationName = `${city.trim()}, ${state.trim()}`;
            }
        } else {
            office = request.location.office.trim().toUpperCase();
            gridX = request.location.gridX;
            gridY = request.location.gridY;
            forecastEndpoint = `${WEATHER_GOV_BASE_URL}/gridpoints/${office}/${gridX},${gridY}/forecast`;
        }

        if (!forecastEndpoint) {
            const endpointFallback =
                resolvedFromEndpoint ?? `${WEATHER_GOV_BASE_URL}/forecast`;
            return buildErrorResult({
                request,
                requestedAt,
                endpoint: endpointFallback,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
                code: 'invalid_response',
                message:
                    'weather.gov response did not include a valid forecast endpoint.',
            });
        }

        const forecastResponse = await fetchJson<WeatherGovForecastResponse>(
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

        const periodsRaw = forecastResponse.data.properties?.periods;
        if (!Array.isArray(periodsRaw)) {
            return buildErrorResult({
                request,
                requestedAt,
                endpoint: forecastEndpoint,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
                code: 'invalid_response',
                message:
                    'weather.gov forecast payload did not include a periods array.',
            });
        }

        const normalizedPeriods = periodsRaw
            .map((period) => normalizeForecastPeriod(period))
            .filter(
                (period): period is WeatherForecastPeriod => period !== null
            )
            .slice(0, horizonPeriods);
        if (normalizedPeriods.length === 0) {
            return buildErrorResult({
                request,
                requestedAt,
                endpoint: forecastEndpoint,
                ...(resolvedFromEndpoint !== undefined && {
                    resolvedFromEndpoint,
                }),
                code: 'invalid_response',
                message:
                    'weather.gov forecast payload did not contain usable forecast periods.',
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
                ...(timezone !== undefined && { timezone }),
                ...(latitude !== undefined && { latitude }),
                ...(longitude !== undefined && { longitude }),
                ...(office !== undefined && { office }),
                ...(gridX !== undefined && { gridX }),
                ...(gridY !== undefined && { gridY }),
            },
            forecast: {
                ...(typeof forecastResponse.data.properties?.generatedAt ===
                    'string' && {
                    generatedAt: forecastResponse.data.properties.generatedAt,
                }),
                ...(typeof forecastResponse.data.properties?.updateTime ===
                    'string' && {
                    updatedAt: forecastResponse.data.properties.updateTime,
                }),
                periods: normalizedPeriods,
            },
            provenance: {
                provider: 'weather.gov',
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
