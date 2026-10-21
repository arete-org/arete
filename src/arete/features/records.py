"""Personal records of the Analyses page, from the athlete's own data.

Running: the fastest time over each standard distance, which
``queries.stream_effort_rows`` measures on the watch streams of the latest
runs. Strength: the best estimated 1RM per exercise of the latest logged
sessions, read with the rules of ``strength.progression`` (working sets only,
Epley up to 12 reps). No Strava value: Strava is retired as a data source.
Pure: the service hands the rows over.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import TYPE_CHECKING, Any, TypedDict

from arete.features.periods import PeriodWindow
from arete.strength.progression import E1RM_EPSILON, WorkSet

if TYPE_CHECKING:
    from arete.dataio.queries import LiftSetRow, LiftSets, StreamEffortRow

#: Distances of the running records, in metres (half and marathon included).
EFFORT_DISTANCES_M: tuple[float, ...] = (1000.0, 5000.0, 10000.0, 21097.5, 42195.0)
#: A stream step faster than this is a GPS jump or a vehicle, not running: it
#: counts for no distance (the 1 km world record is run at 6.3 m/s).
MAX_EFFORT_MPS = 6.5
#: Runs and strength sessions the records read: the latest ones, so the
#: overview's cost does not grow with the history.
RECORD_RUNS = 100
RECORD_STRENGTH_SESSIONS = 100

#: How the record table names each distance.
EFFORT_LABELS: dict[float, str] = {
    1000.0: "1 km",
    5000.0: "5 km",
    10000.0: "10 km",
    21097.5: "Semi-marathon",
    42195.0: "Marathon",
}
#: Exercises the record table lists: the most practised.
LIFTS_SHOWN = 5


class RunRecord(TypedDict):
    name: str
    distance_m: float
    time_sec: int
    time_display: str
    pace_display: str
    date: str
    session_id: int
    session_name: str | None


class LiftRecord(TypedDict):
    exercise: str
    e1rm_kg: float
    weight_kg: float
    reps: int
    date: str
    session_id: int
    sessions: int


def _hms(seconds: int) -> str:
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _pace(seconds: int, metres: float) -> str:
    minutes, secs = divmod(int(round(seconds / metres * 1000)), 60)
    return f"{minutes}:{secs:02d} /km"


def run_records(rows: Sequence[StreamEffortRow]) -> list[RunRecord]:
    """The fastest run per distance, shortest distance first; the earliest on a tie."""
    best: dict[int, StreamEffortRow] = {}
    for row in rows:
        for i, seconds in enumerate(row.best_sec):
            if seconds is None:
                continue
            held = best.get(i)
            if (
                held is None
                or seconds < (held.best_sec[i] or 0)
                or (seconds == held.best_sec[i] and row.date < held.date)
            ):
                best[i] = row
    records: list[RunRecord] = []
    for i, metres in enumerate(EFFORT_DISTANCES_M):
        holder = best.get(i)
        if holder is None:
            continue
        seconds = holder.best_sec[i]
        assert seconds is not None
        records.append(
            {
                "name": EFFORT_LABELS[metres],
                "distance_m": metres,
                "time_sec": seconds,
                "time_display": _hms(seconds),
                "pace_display": _pace(seconds, metres),
                "date": holder.date.isoformat(),
                "session_id": holder.session_id,
                "session_name": holder.name,
            }
        )
    return records


def _e1rm(row: LiftSetRow) -> float | None:
    return WorkSet(reps=row.reps, weight_kg=row.weight_kg).e1rm


def lift_records(rows: Sequence[LiftSetRow]) -> list[LiftRecord]:
    """Best e1RM of the most practised exercises; the first set to reach it keeps it."""
    best: dict[int, LiftSetRow] = {}
    sessions: dict[int, set[int]] = {}
    for row in rows:  # oldest first
        sessions.setdefault(row.exercise_id, set()).add(row.session_id)
        e1rm = _e1rm(row)
        held = best.get(row.exercise_id)
        if e1rm is not None and (
            held is None or e1rm > (_e1rm(held) or 0) + E1RM_EPSILON
        ):
            best[row.exercise_id] = row
    ranked = sorted(
        best.values(), key=lambda r: (-len(sessions[r.exercise_id]), r.exercise)
    )
    return [
        {
            "exercise": row.exercise,
            "e1rm_kg": round(_e1rm(row) or 0.0, 1),
            "weight_kg": row.weight_kg,
            "reps": row.reps,
            "date": row.date.isoformat(),
            "session_id": row.session_id,
            "sessions": len(sessions[row.exercise_id]),
        }
        for row in ranked[:LIFTS_SHOWN]
    ]


def lift_trend(
    lifts: LiftSets, window: PeriodWindow
) -> tuple[str, float, float] | None:
    """(exercise, previous window's best e1RM, this window's) for the most
    practised exercise of the window that the previous window also has.

    None when the session bound cut into the previous window: its best would
    be read from part of it only.
    """
    if window.prev_start is None or window.prev_end is None:
        return None
    if lifts.complete_from is not None and window.prev_start < lifts.complete_from:
        return None
    rows = lifts.rows

    def bests(start: date, end: date) -> dict[int, tuple[str, float, set[int]]]:
        out: dict[int, tuple[str, float, set[int]]] = {}
        for row in rows:
            e1rm = _e1rm(row)
            if not start <= row.date <= end or e1rm is None:
                continue
            name, top, seen = out.get(row.exercise_id, (row.exercise, 0.0, set()))
            out[row.exercise_id] = (name, max(top, e1rm), seen | {row.session_id})
        return out

    current = bests(window.start, window.end)
    previous = bests(window.prev_start, window.prev_end)
    shared = [key for key in current if key in previous]
    if not shared:
        return None
    key = max(shared, key=lambda k: (len(current[k][2]), current[k][1]))
    name, best, _ = current[key]
    return name, round(previous[key][1], 1), round(best, 1)


def records_payload(
    efforts: Sequence[StreamEffortRow],
    lifts: LiftSets,
    runs_limit: int,
    sessions_limit: int,
) -> dict[str, Any]:
    """The Records card: both tables and the bounds they were read within."""
    return {
        "runs": run_records(efforts),
        "lifts": lift_records(lifts.rows),
        "runs_scanned": len(efforts),
        "runs_limit": runs_limit,
        "sessions_scanned": lifts.sessions,
        "sessions_limit": sessions_limit,
    }
