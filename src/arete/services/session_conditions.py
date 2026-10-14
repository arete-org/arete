"""A session's terrain and weather: computed once when it arrives, then stored.

Terrain (grade-adjusted pace, best climbing speeds, descent profile) comes
from the kept streams through ``features/terrain`` and lives in
``app.activity_terrain``; the start's weather comes from Open-Meteo through
``services/weather`` and lives in ``app.activity_weather`` (migration 32).
The session page, the Analytics cards and the coach's digest read the rows
instead of rescanning streams or calling the network.

``enrich_sessions`` runs after a Garmin sync and a FIT upload: bounded (the
weather requests of one call share a time budget) and it never raises, so a
slow Open-Meteo or a strange stream cannot fail what imported the session.
``backfill_terrain`` fills sessions whose streams were kept before this
existed, a bounded batch per call.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Sequence
from typing import Any

from arete.dataio.db import db_connection
from arete.dataio.ownership import require_owned
from arete.dataio.queries import FOOT_SPORTS, VAM_COLUMNS, sql_in
from arete.features import terrain as tr
from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams
from arete.services.weather import Weather, fetch_weather

logger = logging.getLogger(__name__)

_TERRAIN_COLUMNS = (
    "model_version",
    "grade_factor",
    "gap_sec_km",
    *VAM_COLUMNS.values(),
    "descent_json",
)
_WEATHER_COLUMNS = (
    "observed_at",
    "temperature_c",
    "humidity_pct",
    "wind_kmh",
    "start_altitude_m",
    "source",
)
#: Seconds the weather requests of one ``enrich_sessions`` call may take.
WEATHER_BUDGET_SEC = 20.0
#: Sessions one ``backfill_terrain`` call recomputes at most.
BACKFILL_LIMIT = 50

WeatherFetcher = Callable[..., Weather | None]


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #
def _replace(table: str, columns: Sequence[str], session_id: int, values: list) -> None:
    with db_connection() as con:
        con.execute("BEGIN TRANSACTION")
        try:
            require_owned(con, "actual_sessions", session_id)
            con.execute(
                f"DELETE FROM app.{table} WHERE athlete_id=getvariable('arete_athlete_id') AND actual_session_id = ?",
                [session_id],
            )
            con.execute(
                f"INSERT INTO app.{table} (actual_session_id, {', '.join(columns)}) "
                f"VALUES ({', '.join(['?'] * (len(columns) + 1))})",
                [session_id, *values],
            )
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise


def _select(table: str, columns: Sequence[str], session_id: int) -> tuple | None:
    with db_connection() as con:
        return con.execute(
            f"SELECT {', '.join(columns)} FROM app.visible_{table} WHERE actual_session_id = ?",
            [session_id],
        ).fetchone()


def save_terrain(session_id: int, terrain: tr.Terrain) -> None:
    _replace(
        "activity_terrain",
        _TERRAIN_COLUMNS,
        session_id,
        [
            tr.MODEL_VERSION,
            terrain.grade_factor,
            terrain.gap_sec_km,
            *(terrain.vam.get(minutes) for minutes in VAM_COLUMNS),
            json.dumps(terrain.descent) if terrain.descent else None,
        ],
    )


def get_terrain(session_id: int) -> dict[str, Any] | None:
    """The stored terrain of a session, None when it has none."""
    row = _select("activity_terrain", _TERRAIN_COLUMNS, session_id)
    if row is None:
        return None
    vam = {
        str(minutes): value
        for minutes, value in zip(
            VAM_COLUMNS, row[3 : 3 + len(VAM_COLUMNS)], strict=True
        )
        if value is not None
    }
    return {
        "grade_factor": row[1],
        "gap_sec_km": row[2],
        "vam": vam,
        "descent": json.loads(row[-1]) if row[-1] else [],
    }


def save_weather(
    session_id: int, weather: Weather, start_altitude_m: float | None
) -> None:
    _replace(
        "activity_weather",
        _WEATHER_COLUMNS,
        session_id,
        [
            weather.observed_at,
            weather.temperature_c,
            weather.humidity_pct,
            weather.wind_kmh,
            start_altitude_m,
            weather.source,
        ],
    )


def get_weather(session_id: int) -> dict[str, Any] | None:
    """The stored weather at a session's start, None when it has none."""
    row = _select("activity_weather", _WEATHER_COLUMNS, session_id)
    if row is None:
        return None
    return {
        "observed_at": row[0].isoformat(),
        "temperature_c": row[1],
        "humidity_pct": row[2],
        "wind_kmh": row[3],
        "start_altitude_m": row[4],
        "source": row[5],
    }


# --------------------------------------------------------------------------- #
# Computation
# --------------------------------------------------------------------------- #
def terrain_of(
    session: ActualSession, streams: ActivityStreams | None
) -> tr.Terrain | None:
    """The terrain of a session on foot with kept streams, else None."""
    if streams is None or session.sport not in FOOT_SPORTS:
        return None
    return tr.analyze(
        streams.t,
        streams.altitude_m,
        streams.distance_m,
        pace_sec_km=session.avg_pace_sec_km,
    )


def _first(values: list[float | None] | None) -> float | None:
    return next((v for v in values or [] if v is not None), None)


def start_point(
    session: ActualSession, streams: ActivityStreams | None
) -> tuple[float, float] | None:
    """Where the session started: the stored start, else the first GPS fix."""
    if session.start_lat is not None and session.start_lon is not None:
        return session.start_lat, session.start_lon
    if streams is None or not streams.has_route:
        return None
    for lat, lon in zip(streams.lat or [], streams.lon or [], strict=True):
        if lat is not None and lon is not None:
            return lat, lon
    return None


def weather_of(
    session: ActualSession,
    streams: ActivityStreams | None,
    fetch: WeatherFetcher | None = None,
) -> tuple[Weather, float | None] | None:
    """(weather, start altitude) of a session with a start place and time."""
    point = start_point(session, streams)
    if point is None or session.start_time is None:
        return None
    # A FIT file's timestamps are UTC; Garmin's and Strava's starts are local.
    utc = session.source == ActivitySource.FIT_FILE
    weather = (fetch or fetch_weather)(point[0], point[1], session.start_time, utc=utc)
    if weather is None:
        return None
    # The watch's barometric altitude beats the model's grid cell.
    altitude = _first(streams.altitude_m if streams else None)
    return weather, altitude if altitude is not None else weather.elevation_m


def enrich_sessions(
    session_ids: Sequence[int],
    *,
    repo: GarminRepository | None = None,
    fetch: WeatherFetcher | None = None,
    budget_sec: float = WEATHER_BUDGET_SEC,
    deadline: float | None = None,
) -> dict[str, int]:
    """Terrain and weather of sessions that just arrived. Never raises.

    The weather is fetched once per session (skipped when stored), until the
    call's time budget is spent; the remaining sessions keep their terrain.
    """
    repo = repo or GarminRepository()
    weather_deadline = min(
        time.monotonic() + budget_sec,
        deadline if deadline is not None else float("inf"),
    )
    counts = {"terrain": 0, "weather": 0}
    for session_id in session_ids:
        if deadline is not None and time.monotonic() >= deadline:
            counts["incomplete"] = 1
            break
        try:
            session = repo.get_actual_session(session_id)
            if session is None:
                continue
            streams = repo.get_activity_streams(session_id)
            terrain = terrain_of(session, streams)
            if terrain is not None:
                save_terrain(session_id, terrain)
                counts["terrain"] += 1
            if get_weather(session_id) is not None:
                continue
            if time.monotonic() >= weather_deadline:
                if deadline is not None:
                    counts["incomplete"] = 1
                continue
            if weather_deadline - time.monotonic() < 4:
                if deadline is not None:
                    counts["incomplete"] = 1
                continue
            found = weather_of(session, streams, fetch)
            if found is not None:
                save_weather(session_id, *found)
                counts["weather"] += 1
        except Exception as e:  # noqa: BLE001 - optional enrichment, never fatal
            if deadline is not None:
                counts["incomplete"] = 1
            logger.warning("Could not enrich session %s: %s", session_id, e)
    if session_ids:
        logger.info(
            "Session conditions: %d terrain, %d weather for %d sessions",
            counts["terrain"],
            counts["weather"],
            len(session_ids),
        )
    return counts


def backfill_terrain(
    limit: int = BACKFILL_LIMIT, *, repo: GarminRepository | None = None
) -> dict[str, int]:
    """Terrain of sessions on foot whose streams were kept without it.

    Also recomputes rows of an older ``MODEL_VERSION``. At most ``limit``
    sessions per call, oldest first; ``remaining`` tells whether to call again.
    No network: the weather of past sessions is not fetched here.
    """
    assert 0 < limit <= BACKFILL_LIMIT
    repo = repo or GarminRepository()
    pending = f"""
        FROM app.visible_activity_streams st
        JOIN app.visible_actual_sessions s ON s.id = st.actual_session_id
        LEFT JOIN app.visible_activity_terrain t ON t.actual_session_id = s.id
        WHERE s.sport IN ({sql_in(FOOT_SPORTS)})
          AND st.altitude_m IS NOT NULL
          AND (t.actual_session_id IS NULL OR t.model_version < ?)
    """
    with db_connection() as con:
        ids = [
            int(row[0])
            for row in con.execute(
                f"SELECT s.id {pending} ORDER BY s.date, s.id LIMIT ?",
                [tr.MODEL_VERSION, limit],
            ).fetchall()
        ]
    done = 0
    for session_id in ids:
        session = repo.get_actual_session(session_id)
        terrain = (
            None
            if session is None
            else terrain_of(session, repo.get_activity_streams(session_id))
        )
        if terrain is not None:
            save_terrain(session_id, terrain)
            done += 1
        else:  # nothing to read: mark it so the next call moves on
            save_terrain(session_id, tr.Terrain(None, None, {}, []))
    with db_connection() as con:
        row = con.execute(f"SELECT count(*) {pending}", [tr.MODEL_VERSION]).fetchone()
    remaining = int(row[0]) if row else 0
    return {"processed": len(ids), "terrain": done, "remaining": remaining}
