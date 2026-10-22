"""Each session's best efforts, kept in ``app.best_efforts`` (migration 65).

A run's fastest time over each record distance, measured on its kept watch
streams, and a strength log's best estimated 1RM per exercise: one row per
session and distance or exercise. The rows are written in the transaction
that changes what they derive from: ``refresh_runs`` when a session's streams
are saved (Garmin sync, FIT upload, reprocess), ``refresh_lifts`` when a log
is saved or corrected, ``forget`` when either is deleted; another path that
writes activities calls ``refresh_activity_records`` after its commit. The
records are a ranking over the rows (``record_rows``), all time or within a
year, so their cost does not grow with the streams, and a deleted session's
rows drop out of every read through the live session it joins.

The SQL builders take the relations they read, so migration 65 backfills
every athlete from the base tables with the same statements.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import NamedTuple

import duckdb

from arete.dataio.db import transaction
from arete.dataio.queries import EXCLUDED_SOURCES_SQL, RUNNING_SPORTS, sql_in
from arete.features.records import EFFORT_DISTANCES_M, MAX_EFFORT_MPS
from arete.strength.progression import MAX_E1RM_REPS

RUN = "run"
LIFT = "lift"
#: ``effort_key`` of each record distance: its metres ("1000" … "42195").
RUN_KEYS: dict[float, str] = {metres: f"{metres:g}" for metres in EFFORT_DISTANCES_M}
#: ``WorkSet.e1rm`` over an ``es`` set: Epley, one rep is the load itself.
E1RM_SQL = (
    "CASE WHEN es.reps = 1 THEN es.weight_kg "
    "ELSE es.weight_kg * (1 + es.reps / 30.0) END"
)
#: The live relations a request reads: the athlete's own, deleted rows left out.
SCOPED: dict[str, str] = {
    name: f"app.visible_{name}"
    for name in (
        "actual_sessions",
        "activity_streams",
        "strength_sessions",
        "session_exercises",
        "exercise_sets",
    )
}
_SCOPE = "athlete_id = getvariable('arete_athlete_id')"


def run_efforts_sql(relations: Mapping[str, str]) -> str:
    """(athlete, 'run', session, key, seconds, date) of the runs in ``?``.

    A step of the cumulative distance faster than ``MAX_EFFORT_MPS`` counts
    for nothing (a GPS jump, or the watch left on in a car: capping it would
    still credit 6.5 m/s), nor does a negative one. Then, for each sample, a
    window over that distance finds the latest earlier sample at least the
    distance behind it: the time between them covers the distance, and the
    smallest such time is the run's best effort, at the stream's sampling
    interval (1 s, longer with smart recording). Pauses count, as on a race
    clock. A distance the run does not cover gets no row.
    """
    sessions, streams = relations["actual_sessions"], relations["activity_streams"]
    frames = ", ".join(
        f"t - MAX(t) OVER (PARTITION BY id ORDER BY d RANGE BETWEEN UNBOUNDED "
        f"PRECEDING AND {metres} PRECEDING) AS e{i}"
        for i, metres in enumerate(EFFORT_DISTANCES_M)
    )
    bests = ", ".join(f"MIN(e{i})" for i in range(len(EFFORT_DISTANCES_M)))
    keys = ", ".join(f"'{key}'" for key in RUN_KEYS.values())
    return f"""
        WITH chosen AS (
          SELECT s.id, s.user_id, s.date
          FROM {sessions} s
          JOIN {streams} st ON st.actual_session_id = s.id
          WHERE list_contains(?, s.id) AND s.sport IN ({sql_in(RUNNING_SPORTS)})
            AND COALESCE(s.source, '') NOT IN ({EXCLUDED_SOURCES_SQL})
            AND s.distance_m >= {EFFORT_DISTANCES_M[0]}
            AND st.distance_m IS NOT NULL
        ),
        samples AS (
          SELECT st.actual_session_id AS id, UNNEST(st.t_sec) AS t,
                 CAST(UNNEST(st.distance_m) AS DOUBLE) AS d
          FROM {streams} st
          WHERE st.actual_session_id IN (SELECT id FROM chosen)
        ),
        steps AS (
          SELECT id, t, d - LAG(d) OVER w AS dd, t - LAG(t) OVER w AS dt
          FROM samples
          WHERE t IS NOT NULL AND d IS NOT NULL
          WINDOW w AS (PARTITION BY id ORDER BY t)
        ),
        clean AS (
          SELECT id, t,
                 SUM(CASE WHEN dd > 0 AND dd <= {MAX_EFFORT_MPS} * dt THEN dd ELSE 0 END)
                   OVER (PARTITION BY id ORDER BY t ROWS UNBOUNDED PRECEDING) AS d
          FROM steps
        ),
        efforts AS (SELECT id, {frames} FROM clean),
        bests AS (SELECT id, [{bests}] AS seconds FROM efforts GROUP BY id)
        SELECT * FROM (
          SELECT c.user_id, '{RUN}', c.id, UNNEST([{keys}]) AS effort_key,
                 UNNEST(b.seconds) AS value, c.date
          FROM bests b JOIN chosen c USING (id)
        ) WHERE value IS NOT NULL
    """


def lift_efforts_sql(relations: Mapping[str, str]) -> str:
    """(athlete, 'lift', session, exercise, e1RM, kg, reps, date) of the logs in ``?``.

    Working sets only, as ``strength.progression`` reads them; the first set
    to reach the session's best keeps it.
    """
    return f"""
        SELECT ss.user_id, '{LIFT}', ss.id, CAST(se.exercise_id AS VARCHAR),
               {E1RM_SQL} AS value, es.weight_kg, es.reps, ss.date
        FROM {relations["strength_sessions"]} ss
        JOIN {relations["session_exercises"]} se ON se.session_id = ss.id
        JOIN {relations["exercise_sets"]} es ON es.session_exercise_id = se.id
        WHERE list_contains(?, ss.id) AND NOT COALESCE(es.is_warmup, FALSE)
          AND es.reps BETWEEN 1 AND {MAX_E1RM_REPS} AND es.weight_kg > 0
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY ss.id, se.exercise_id ORDER BY value DESC, se.id, es.set_number
        ) = 1
    """


_RUN_COLUMNS = "athlete_id, kind, session_id, effort_key, value, date"
_LIFT_COLUMNS = "athlete_id, kind, session_id, effort_key, value, weight_kg, reps, date"


def insert_sql(kind: str, relations: Mapping[str, str]) -> str:
    """The insert of ``kind``'s rows for the sessions in ``?``."""
    if kind == RUN:
        return f"INSERT INTO app.best_efforts ({_RUN_COLUMNS}) {run_efforts_sql(relations)}"
    assert kind == LIFT, kind
    return (
        f"INSERT INTO app.best_efforts ({_LIFT_COLUMNS}) {lift_efforts_sql(relations)}"
    )


def forget(
    con: duckdb.DuckDBPyConnection, kind: str, session_ids: Sequence[int]
) -> None:
    """Drop the rows of these sessions, in the caller's transaction."""
    con.execute(
        f"DELETE FROM app.best_efforts WHERE {_SCOPE} AND kind = ? "
        "AND list_contains(?, session_id) RETURNING session_id",
        [kind, list(session_ids)],
    ).fetchall()


def _refresh(
    con: duckdb.DuckDBPyConnection, kind: str, session_ids: Sequence[int]
) -> None:
    ids = list(session_ids)
    if not ids:
        return
    forget(con, kind, ids)
    con.execute(f"{insert_sql(kind, SCOPED)} RETURNING session_id", [ids]).fetchall()


def refresh_runs(con: duckdb.DuckDBPyConnection, session_ids: Sequence[int]) -> None:
    """Recompute these runs' rows from their kept streams, in the caller's transaction.

    A session that is not a Garmin or FIT run of at least 1 km with a
    distance stream is left without rows.
    """
    _refresh(con, RUN, session_ids)


def refresh_lifts(con: duckdb.DuckDBPyConnection, session_ids: Sequence[int]) -> None:
    """Recompute these logs' rows from their working sets, in the caller's transaction."""
    _refresh(con, LIFT, session_ids)


def refresh_activity_records(session_ids: Sequence[int]) -> None:
    """The hook for a path that writes or deletes activities on its own.

    Call it once after that path commits: in one transaction of its own, each
    session's run rows are recomputed from what is now stored, so a deleted
    session or one left without a distance stream loses them. Garmin sync,
    FIT upload and reprocess need not: ``GarminRepository.save_activity_streams``
    and ``delete_actual_session`` maintain the rows in their own transaction.
    """
    if not session_ids:
        return
    with transaction() as con:
        refresh_runs(con, session_ids)


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #
class EffortRecord(NamedTuple):
    kind: str
    key: str  # ``RUN_KEYS`` value, or the exercise id
    exercise: str | None  # lifts only
    session_id: int
    session_name: str | None
    date: date
    value: float  # seconds, or e1RM kg
    weight_kg: float | None
    reps: int | None
    sessions: int  # sessions holding a row for this key in the range
    previous: float | None  # the best before the range, when it has a start


class LiftEffort(NamedTuple):
    exercise_id: int
    exercise: str
    session_id: int
    date: date
    e1rm_kg: float


#: Rows whose session is live, with its name and the exercise's.
_LIVE = """
    live AS (
      SELECT b.kind, b.effort_key, b.session_id, b.date, b.value, b.weight_kg,
             b.reps, COALESCE(s.name, ss.name) AS session_name, e.name AS exercise
      FROM app.visible_best_efforts b
      LEFT JOIN app.visible_actual_sessions s
        ON b.kind = 'run' AND s.id = b.session_id
      LEFT JOIN app.visible_strength_sessions ss
        ON b.kind = 'lift' AND ss.id = b.session_id
      LEFT JOIN app.visible_exercises e
        ON b.kind = 'lift' AND e.id = TRY_CAST(b.effort_key AS INTEGER)
      WHERE s.id IS NOT NULL OR (ss.id IS NOT NULL AND e.id IS NOT NULL)
    )
"""
#: Fastest run first; heaviest lift first, two e1RMs equal to 0.1 kg being
#: the same lift. Then the earliest session keeps the record.
_RANK = "CASE WHEN kind = 'run' THEN value ELSE -ROUND(value, 1) END, date, session_id"


def record_rows(
    con: duckdb.DuckDBPyConnection, start: date | None = None, end: date | None = None
) -> list[EffortRecord]:
    """The record of each distance and exercise between two days (all time by
    default), with the best before ``start`` when one is given."""
    rows = con.execute(
        f"""
        WITH {_LIVE},
        ranked AS (
          SELECT *, COUNT(*) OVER (PARTITION BY kind, effort_key) AS sessions,
                 ROW_NUMBER() OVER (PARTITION BY kind, effort_key ORDER BY {_RANK}) AS rank
          FROM live WHERE date BETWEEN ? AND ?
        ),
        before AS (
          SELECT kind, effort_key,
                 CASE WHEN kind = 'run' THEN MIN(value) ELSE MAX(value) END AS previous
          FROM live WHERE date < ?
          GROUP BY kind, effort_key
        )
        SELECT r.kind, r.effort_key, r.exercise, r.session_id, r.session_name, r.date,
               r.value, r.weight_kg, r.reps, r.sessions, b.previous
        FROM ranked r LEFT JOIN before b USING (kind, effort_key)
        WHERE r.rank = 1
        ORDER BY r.kind, r.effort_key
        """,
        [start or date.min, end or date.max, start or date.min],
    ).fetchall()
    return [EffortRecord(*row) for row in rows]


def lift_effort_rows(
    con: duckdb.DuckDBPyConnection, start: date, end: date
) -> list[LiftEffort]:
    """Each log's best e1RM per exercise between two days, oldest first."""
    rows = con.execute(
        f"""
        WITH {_LIVE}
        SELECT CAST(effort_key AS INTEGER), exercise, session_id, date, value
        FROM live
        WHERE kind = 'lift' AND date BETWEEN ? AND ?
        ORDER BY date, session_id, effort_key
        """,
        [start, end],
    ).fetchall()
    return [LiftEffort(*row) for row in rows]
