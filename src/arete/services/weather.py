"""The weather at a session's start, from Open-Meteo (free, no key).

Recent days come from the forecast API, which keeps its past hours; older
ones from the historical archive (ERA5 reanalysis), which lags by about five
days. One request per session, a short timeout, and never an exception: a
session without weather is a session, a sync that failed on the weather is
not a sync.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import httpx

from arete.services.settings import athlete_today

logger = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
HOURLY = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m")
#: The archive's lag: newer days are read from the forecast API.
ARCHIVE_LAG_DAYS = 5
#: Seconds for the whole request (connect included).
TIMEOUT_SEC = 4.0


@dataclass(frozen=True)
class Weather:
    #: The hour read, on the same clock as the session's start.
    observed_at: datetime
    temperature_c: float | None
    humidity_pct: float | None
    wind_kmh: float | None
    #: Elevation of the model's grid cell, the fallback start altitude.
    elevation_m: float | None
    source: str


def _hour(start: datetime) -> datetime:
    """The hour nearest to the start."""
    return (start + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def _number(values: Any, index: int) -> float | None:
    if not isinstance(values, list) or index >= len(values):
        return None
    value = values[index]
    return float(value) if isinstance(value, int | float) else None


def parse(payload: Any, hour: datetime, source: str) -> Weather | None:
    """The hour's values from an Open-Meteo answer, None when it is not there."""
    if not isinstance(payload, dict) or not isinstance(payload.get("hourly"), dict):
        return None
    hourly = payload["hourly"]
    times = hourly.get("time")
    key = hour.strftime("%Y-%m-%dT%H:%M")
    if not isinstance(times, list) or key not in times:
        return None
    index = times.index(key)
    weather = Weather(
        observed_at=hour,
        temperature_c=_number(hourly.get("temperature_2m"), index),
        humidity_pct=_number(hourly.get("relative_humidity_2m"), index),
        wind_kmh=_number(hourly.get("wind_speed_10m"), index),
        elevation_m=payload.get("elevation")
        if isinstance(payload.get("elevation"), int | float)
        else None,
        source=source,
    )
    if weather.temperature_c is None and weather.humidity_pct is None:
        return None  # an hour the model has no data for yet
    return weather


def fetch_weather(
    lat: float,
    lon: float,
    start: datetime,
    *,
    utc: bool,
    today: date | None = None,
    client: httpx.Client | None = None,
) -> Weather | None:
    """The weather at ``start`` (naive, local time unless ``utc``), or None.

    Never raises: a timeout, an HTTP error or an unexpected answer is logged
    and returns None.
    """
    hour = _hour(start)
    today = today or athlete_today()
    recent = hour.date() >= today - timedelta(days=ARCHIVE_LAG_DAYS)
    url, source = (
        (FORECAST_URL, "open-meteo-forecast")
        if recent
        else (ARCHIVE_URL, "open-meteo-archive")
    )
    params: dict[str, str | float] = {
        "latitude": round(lat, 4),
        "longitude": round(lon, 4),
        "hourly": ",".join(HOURLY),
        "start_date": hour.date().isoformat(),
        "end_date": hour.date().isoformat(),
        # The session's clock: Garmin's local start, or a FIT file's UTC.
        "timezone": "GMT" if utc else "auto",
    }
    try:
        if client is None:
            import httpx  # here, not at module level: the API boot skips httpx

            with httpx.Client(timeout=TIMEOUT_SEC) as own:
                response = own.get(url, params=params)
        else:
            response = client.get(url, params=params, timeout=TIMEOUT_SEC)
        response.raise_for_status()
        return parse(response.json(), hour, source)
    except Exception as e:  # noqa: BLE001 - weather is optional, the sync is not
        logger.warning("Open-Meteo request failed for %s: %s", hour, e)
        return None
