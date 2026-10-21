"""Shared SQL over ``app.actual_sessions``: sport groups and training-load series.

One definition of "what is a run", one TSS formula, one gap-filled daily
series. Used by metrics, analytics, tips and the Banister fit.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import date, timedelta
from typing import NamedTuple

import duckdb

from arete.dataio.db import db_connection
from arete.features.fitness import DailyTSS
from arete.features.hr_zones import DEFAULT_MAX_HR, LTHR_FROM_MAX_HR
from arete.features.records import EFFORT_DISTANCES_M, MAX_EFFORT_MPS
from arete.features.terrain import VAM_MINUTES
from arete.features.workload import DailyLoad
from arete.services.athlete_scope import resolve_athlete_id

# Garmin sync writes "running"/"cycling"/..., Strava writes "run"/"ride"/...:
# both spellings coexist in the database, so every filter must accept both.
RUNNING_SPORTS: tuple[str, ...] = (
    "run",
    "running",
    "trail_run",
    "trail_running",
    "treadmill_running",
    "virtualrun",
    "virtual_run",
)
WALKING_SPORTS: tuple[str, ...] = ("walk", "walking", "hike", "hiking")
FOOT_SPORTS: tuple[str, ...] = RUNNING_SPORTS + WALKING_SPORTS
CYCLING_SPORTS: tuple[str, ...] = (
    "ride",
    "cycling",
    "virtual_ride",
    "indoor_cycling",
    "mountain_biking",
)
SPORT_GROUPS: dict[str, tuple[str, ...]] = {
    "running": RUNNING_SPORTS,
    "cycling": CYCLING_SPORTS,
}


def sql_in(values: Iterable[str]) -> str:
    """Render a tuple of literals for an ``IN (...)`` clause."""
    return ", ".join(f"'{v}'" for v in values)


#: Sources whose rows never reach a language model. Strava's API agreement
#: (1 June 2026) forbids using its data in AI applications, inference
#: included: sessions imported from Strava stay out of the coach's inputs and
#: out of every series built here (ARE-126).
MODEL_EXCLUDED_SOURCES: tuple[str, ...] = ("strava",)
#: ``MODEL_EXCLUDED_SOURCES`` as an SQL list, for ``NOT IN (...)``.
EXCLUDED_SOURCES_SQL = sql_in(MODEL_EXCLUDED_SOURCES)


# The athlete's threshold HR, for the HR branch of the TSS estimate: tested,
# else derived from max HR, else derived from the default max HR (single
# athlete: settings live on user 1).
THRESHOLD_HR_SQL = f"""
    COALESCE(
      (SELECT COALESCE(NULLIF(lthr, 0), ROUND(NULLIF(max_hr, 0) * {LTHR_FROM_MAX_HR}))
       FROM app.visible_user_settings WHERE user_id = getvariable('arete_athlete_id')),
      {round(DEFAULT_MAX_HR * LTHR_FROM_MAX_HR)}
    )
"""

# TSS estimate per session, best signal first:
# RPE -> hrTSS on the threshold -> flat default (RPE 5). Strava's suffer score
# is never read: Strava's API agreement forbids its data in an AI application,
# and this load feeds the coach (ARE-126).
# RPE: (duration_min * (RPE/10)^2) / 0.36, so 1 h at RPE 6 = 60, at ~7.7 = 100.
# HR: hours * (avg HR / threshold HR)^2 * 100, so 1 h at threshold = 100.
TSS_EXPR = f"""
    CASE
      WHEN rpe IS NOT NULL THEN
        (COALESCE(duration_sec, 0) / 60.0) * POWER(rpe / 10.0, 2) / 0.36
      WHEN avg_hr IS NOT NULL THEN
        (COALESCE(duration_sec, 0) / 3600.0)
        * POWER(avg_hr / CAST({THRESHOLD_HR_SQL} AS DOUBLE), 2) * 100
      ELSE
        (COALESCE(duration_sec, 0) / 60.0) * 0.25 / 0.36
    END
"""

# Every session that loads the athlete: the realised sessions, plus the logged
# strength sessions not already linked to one of them (a linked strength
# session is the Garmin activity it was recorded with: counted once). Strength
# sessions without a duration carry no load, so they cannot skew a day's RPE.
# Excluded sources are left out: every series built on this reaches the
# coach. A strength log linked to an excluded row is the athlete's own data and
# still counts.
LOAD_ROWS = f"""
    (
      SELECT id, user_id, date, sport, duration_sec, rpe, avg_hr,
             distance_m, hr_zones_json, avg_pace_sec_km, ascent_m, avg_cadence
      FROM app.visible_actual_sessions
      WHERE COALESCE(source, '') NOT IN ({EXCLUDED_SOURCES_SQL})
      UNION ALL
      SELECT -id, user_id, date, 'strength', duration_min * 60,
             CAST(ROUND(overall_rpe) AS INTEGER), NULL,
             NULL, NULL, NULL, NULL, NULL
      FROM app.visible_strength_sessions
      WHERE duration_min > 0 AND (
        actual_session_id IS NULL
        OR actual_session_id IN (
          SELECT id FROM app.visible_actual_sessions WHERE source IN ({EXCLUDED_SOURCES_SQL})
        )
      )
    ) AS sessions
"""


def _days(start: date, end: date) -> Sequence[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def daily_tss(
    con: duckdb.DuckDBPyConnection, start: date, end: date, user_id: int | None = None
) -> list[DailyTSS]:
    """Daily TSS between two dates (inclusive), zeros for days without sessions."""
    user_id = resolve_athlete_id(user_id)
    rows = con.execute(
        f"""
        SELECT date, SUM({TSS_EXPR}) AS daily_tss
        FROM {LOAD_ROWS}
        WHERE date >= ? AND date <= ? AND user_id = ?
        GROUP BY date
        """,
        [start, end, user_id],
    ).fetchall()
    by_date = {row[0]: float(row[1]) for row in rows}
    return [DailyTSS(date=d, tss=by_date.get(d, 0.0)) for d in _days(start, end)]


def daily_loads(
    con: duckdb.DuckDBPyConnection, start: date, end: date, user_id: int | None = None
) -> list[DailyLoad]:
    """Daily duration/RPE loads between two dates, zeros for days without sessions."""
    user_id = resolve_athlete_id(user_id)
    rows = con.execute(
        f"""
        SELECT date,
               SUM(COALESCE(duration_sec, 0)) / 60.0 AS total_duration,
               AVG(COALESCE(rpe, 5)) AS avg_rpe
        FROM {LOAD_ROWS}
        WHERE date >= ? AND date <= ? AND user_id = ?
        GROUP BY date
        """,
        [start, end, user_id],
    ).fetchall()
    by_date = {row[0]: (int(row[1]), float(row[2])) for row in rows}
    return [
        DailyLoad(date=d, duration_min=by_date[d][0], rpe=by_date[d][1])
        if d in by_date
        else DailyLoad(date=d, duration_min=0, rpe=0)
        for d in _days(start, end)
    ]


def daily_tss_by_date(
    con: duckdb.DuckDBPyConnection, user_id: int | None = None
) -> dict[date, float]:
    """TSS per day over the whole history, days without sessions absent."""
    user_id = resolve_athlete_id(user_id)
    rows = con.execute(
        f"""
        SELECT date, SUM({TSS_EXPR})
        FROM {LOAD_ROWS}
        WHERE user_id = ?
        GROUP BY date
        """,
        [user_id],
    ).fetchall()
    return {row[0]: float(row[1]) for row in rows}


# Convenience wrappers for callers without a connection at hand.
def tss_history(days: int, end: date | None = None) -> list[DailyTSS]:
    end = end or date.today()
    with db_connection() as con:
        return daily_tss(con, end - timedelta(days=days), end)


def training_loads(days: int, end: date) -> list[DailyLoad]:
    """``end`` is the athlete's day (``athlete_today``), which this layer cannot
    read: no default."""
    with db_connection() as con:
        return daily_loads(con, end - timedelta(days=days), end)


HEALTH_COLUMNS = (
    "date",
    "hrv_last_night",
    "hrv_weekly_avg",
    "sleep_score",
    "sleep_duration_sec",
    "body_battery_high",
    "body_battery_low",
    "stress_avg",
    "resting_hr",
    "readiness_score",
    "steps",
)


def daily_metrics_range(
    con: duckdb.DuckDBPyConnection, start: date, end: date, user_id: int | None = None
) -> list[dict]:
    """Stored Garmin health metrics between two dates, oldest first."""
    user_id = resolve_athlete_id(user_id)
    rows = con.execute(
        f"""
        SELECT {", ".join(HEALTH_COLUMNS)}
        FROM app.visible_daily_metrics
        WHERE user_id = ? AND date >= ? AND date <= ?
        ORDER BY date ASC
        """,
        [user_id, start, end],
    ).fetchall()
    return [
        {
            col: (str(value) if col == "date" else value)
            for col, value in zip(HEALTH_COLUMNS, row, strict=True)
        }
        for row in rows
    ]


#: Every stored Garmin field of one day, as ``/garmin/health/daily`` shows them.
HEALTH_DAY_COLUMNS = (
    "date",
    "hrv_weekly_avg",
    "hrv_last_night",
    "hrv_status",
    "sleep_duration_sec",
    "sleep_score",
    "sleep_deep_sec",
    "sleep_light_sec",
    "sleep_rem_sec",
    "sleep_awake_sec",
    "body_battery_charged",
    "body_battery_drained",
    "body_battery_high",
    "body_battery_low",
    "resting_hr",
    "stress_avg",
    "stress_max",
    "steps",
    "intensity_minutes",
    "readiness_score",
    "source",
    "fetched_at",
    "training_readiness_score",
    "training_readiness_level",
    "training_readiness_feedback",
    "training_status",
    "vo2max_run",
    "race_5k_sec",
    "race_10k_sec",
    "race_half_sec",
    "race_marathon_sec",
    "endurance_score",
    "hill_score",
)


def daily_health(con: duckdb.DuckDBPyConnection, day: date) -> dict | None:
    """The day's stored Garmin metrics and readiness, None before any sync."""
    row = con.execute(
        f"""
        SELECT {", ".join(HEALTH_DAY_COLUMNS)}
        FROM app.visible_daily_metrics
        WHERE user_id = getvariable('arete_athlete_id') AND date = ?
        """,
        [day],
    ).fetchone()
    return dict(zip(HEALTH_DAY_COLUMNS, row, strict=True)) if row else None


def earliest_session_date(
    con: duckdb.DuckDBPyConnection, user_id: int | None = None
) -> date | None:
    """Date of the first recorded session, used by the "all" period."""
    user_id = resolve_athlete_id(user_id)
    row = con.execute(
        "SELECT MIN(date) FROM app.visible_actual_sessions WHERE user_id = ?"
        f" AND COALESCE(source, '') NOT IN ({EXCLUDED_SOURCES_SQL})",
        [user_id],
    ).fetchone()
    return row[0] if row and row[0] else None


# --------------------------------------------------------------------------- #
# Analytics overview: one wide SELECT, the cards slice it in Python
# --------------------------------------------------------------------------- #
class OverviewRow(NamedTuple):
    date: date
    sport: str
    duration_sec: int  # 0 when unknown
    distance_m: float | None
    hr_zones_json: str | None
    avg_pace_sec_km: int | None
    avg_hr: int | None
    rpe: int | None
    ascent_m: float | None
    avg_cadence: int | None  # steps/min on runs
    tss: float
    gap_sec_km: int | None = None  # grade-adjusted pace, from the kept streams


def overview_rows(
    con: duckdb.DuckDBPyConnection, start: date, end: date, user_id: int | None = None
) -> list[OverviewRow]:
    """Every session in the range with the columns the overview cards read."""
    user_id = resolve_athlete_id(user_id)
    rows = con.execute(
        f"""
        SELECT date, sport, COALESCE(duration_sec, 0), distance_m, hr_zones_json,
               avg_pace_sec_km, avg_hr, rpe, ascent_m, avg_cadence, {TSS_EXPR},
               terrain.gap_sec_km
        FROM {LOAD_ROWS}
        LEFT JOIN app.visible_activity_terrain AS terrain
          ON terrain.actual_session_id = sessions.id
        WHERE date >= ? AND date <= ? AND user_id = ?
        ORDER BY date ASC, sessions.id ASC
        """,
        [start, end, user_id],
    ).fetchall()
    return [OverviewRow(*row) for row in rows]


def drift_rows(
    con: duckdb.DuckDBPyConnection,
    start: date,
    end: date,
    min_duration_sec: int = 2400,
    user_id: int | None = None,
) -> list[tuple]:
    """Long runs with laps, in the column order ``hr_drift.analyze_runs`` expects."""
    user_id = resolve_athlete_id(user_id)
    return con.execute(
        f"""
        SELECT id, date, name, distance_m, ascent_m,
               moving_time_sec, avg_hr, avg_pace_sec_km, laps_json
        FROM app.visible_actual_sessions
        WHERE date >= ? AND date <= ? AND user_id = ?
          AND COALESCE(source, '') NOT IN ({EXCLUDED_SOURCES_SQL})
          AND sport IN ({sql_in(RUNNING_SPORTS)})
          AND moving_time_sec >= ?
          AND laps_json IS NOT NULL
        ORDER BY date ASC
        """,
        [start, end, user_id, min_duration_sec],
    ).fetchall()


#: Column of ``app.activity_terrain`` per climbing-speed duration (minutes).
VAM_COLUMNS: dict[int, str] = {minutes: f"vam_{minutes}min" for minutes in VAM_MINUTES}


class TerrainRow(NamedTuple):
    session_id: int
    date: date
    name: str | None
    sport: str
    vam: dict[int, int | None]  # minutes -> best m/h
    descent_json: str | None


def terrain_rows(
    con: duckdb.DuckDBPyConnection, user_id: int | None = None
) -> list[TerrainRow]:
    """Every session on foot with a stored terrain, all time, oldest first.

    One row per session with kept streams: a few hundred a year, so the cards
    slice and rank them in Python, the all-time records included.
    """
    user_id = resolve_athlete_id(user_id)
    rows = con.execute(
        f"""
        SELECT s.id, s.date, s.name, s.sport,
               {", ".join(f"t.{column}" for column in VAM_COLUMNS.values())},
               t.descent_json
        FROM app.visible_activity_terrain t
        JOIN app.visible_actual_sessions s ON s.id = t.actual_session_id
        WHERE s.user_id = ? AND s.sport IN ({sql_in(FOOT_SPORTS)})
        ORDER BY s.date ASC, s.id ASC
        """,
        [user_id],
    ).fetchall()
    n = len(VAM_COLUMNS)
    return [
        TerrainRow(
            row[0],
            row[1],
            row[2],
            row[3],
            dict(zip(VAM_COLUMNS, row[4 : 4 + n], strict=True)),
            row[4 + n],
        )
        for row in rows
    ]


class StreamEffortRow(NamedTuple):
    session_id: int
    date: date
    name: str | None
    best_sec: tuple[int | None, ...]  # per ``EFFORT_DISTANCES_M``, None when shorter


def stream_effort_rows(
    con: duckdb.DuckDBPyConnection, limit: int, user_id: int | None = None
) -> list[StreamEffortRow]:
    """Fastest time over each record distance in the ``limit`` latest runs with streams.

    Computed in the database from the kept watch streams, so only one row per
    run crosses the wire. Each step of the cumulative distance is first capped
    at ``MAX_EFFORT_MPS`` (a GPS jump cannot make a record) and floored at
    zero. Then, for each sample, a window over that distance finds the latest
    earlier sample at least the distance behind it: the time between them
    covers the distance, and the smallest such time is the run's best effort,
    to the second of the 1 Hz recording. Pauses count, as on a race clock.
    """
    user_id = resolve_athlete_id(user_id)
    frames = ", ".join(
        f"t - MAX(t) OVER (PARTITION BY id ORDER BY d RANGE BETWEEN UNBOUNDED "
        f"PRECEDING AND {metres} PRECEDING) AS e{i}"
        for i, metres in enumerate(EFFORT_DISTANCES_M)
    )
    bests = ", ".join(f"MIN(e{i})" for i in range(len(EFFORT_DISTANCES_M)))
    rows = con.execute(
        f"""
        WITH recent AS (
          SELECT s.id, s.date, s.name
          FROM app.visible_actual_sessions s
          JOIN app.visible_activity_streams st ON st.actual_session_id = s.id
          WHERE s.user_id = ? AND s.sport IN ({sql_in(RUNNING_SPORTS)})
            AND COALESCE(s.source, '') NOT IN ({EXCLUDED_SOURCES_SQL})
            AND s.distance_m >= {EFFORT_DISTANCES_M[0]}
            AND st.distance_m IS NOT NULL
          ORDER BY s.date DESC, s.id DESC
          LIMIT ?
        ),
        samples AS (
          SELECT st.actual_session_id AS id, UNNEST(st.t_sec) AS t,
                 CAST(UNNEST(st.distance_m) AS DOUBLE) AS d
          FROM app.visible_activity_streams st
          WHERE st.actual_session_id IN (SELECT id FROM recent)
        ),
        steps AS (
          SELECT id, t, d - LAG(d) OVER w AS dd, t - LAG(t) OVER w AS dt
          FROM samples
          WHERE t IS NOT NULL AND d IS NOT NULL
          WINDOW w AS (PARTITION BY id ORDER BY t)
        ),
        clean AS (
          SELECT id, t,
                 SUM(COALESCE(LEAST(GREATEST(dd, 0), {MAX_EFFORT_MPS} * dt), 0))
                   OVER (PARTITION BY id ORDER BY t ROWS UNBOUNDED PRECEDING) AS d
          FROM steps
        ),
        efforts AS (SELECT id, {frames} FROM clean)
        SELECT r.id, r.date, r.name, {bests}
        FROM efforts JOIN recent r USING (id)
        GROUP BY r.id, r.date, r.name
        ORDER BY r.date DESC, r.id DESC
        """,
        [user_id, limit],
    ).fetchall()
    return [
        StreamEffortRow(
            row[0],
            row[1],
            row[2],
            tuple(None if v is None else int(v) for v in row[3:]),
        )
        for row in rows
    ]


class LiftSetRow(NamedTuple):
    exercise_id: int
    exercise: str
    session_id: int
    date: date
    reps: int
    weight_kg: float


def lift_set_rows(
    con: duckdb.DuckDBPyConnection, limit: int, user_id: int | None = None
) -> list[LiftSetRow]:
    """Loaded working sets (never warm-ups) of the ``limit`` latest strength sessions.

    Oldest first, as ``strength.progression`` reads them.
    """
    user_id = resolve_athlete_id(user_id)
    rows = con.execute(
        """
        WITH recent AS (
          SELECT id, date FROM app.visible_strength_sessions
          WHERE user_id = ?
          ORDER BY date DESC, id DESC
          LIMIT ?
        )
        SELECT e.id, e.name, r.id, r.date, es.reps, es.weight_kg
        FROM recent r
        JOIN app.visible_session_exercises se ON se.session_id = r.id
        JOIN app.visible_exercise_sets es ON es.session_exercise_id = se.id
        JOIN app.visible_exercises e ON e.id = se.exercise_id
        WHERE NOT COALESCE(es.is_warmup, FALSE) AND es.reps > 0 AND es.weight_kg > 0
        ORDER BY r.date, r.id, se.id, es.set_number
        """,
        [user_id, limit],
    ).fetchall()
    return [LiftSetRow(*row) for row in rows]


def best_effort_rows(
    con: duckdb.DuckDBPyConnection, sports: Sequence[str], user_id: int | None = None
) -> list[tuple]:
    """(best_efforts_json, date, name, id) for every session carrying best efforts."""
    user_id = resolve_athlete_id(user_id)
    return con.execute(
        f"""
        SELECT best_efforts_json, date, name, id
        FROM app.visible_actual_sessions
        WHERE user_id = ?
          AND best_efforts_json IS NOT NULL
          AND sport IN ({sql_in(sports)})
        ORDER BY date DESC
        """,
        [user_id],
    ).fetchall()
