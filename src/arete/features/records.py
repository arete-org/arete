"""Personal records of the Analyses page and the year review, all time.

Running: the fastest time over each standard distance, measured on the watch
streams of every run. Strength: the best estimated 1RM per exercise of every
logged session, read with the rules of ``strength.progression`` (working sets
only, Epley up to 12 reps). Each session's bests are kept in
``app.best_efforts`` (``dataio/best_efforts.py``), which ranks them; no
Strava value, Strava being retired as a data source. Pure: the services hand
the rows over.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import TYPE_CHECKING, Any, TypedDict

from arete.features.periods import PeriodWindow

if TYPE_CHECKING:
    from arete.dataio.best_efforts import EffortRecord, LiftEffort

#: Distances of the running records, in metres (half and marathon included).
EFFORT_DISTANCES_M: tuple[float, ...] = (1000.0, 5000.0, 10000.0, 21097.5, 42195.0)
#: A stream step faster than this is a GPS jump or a vehicle, not running: it
#: counts for no distance (the 1 km world record is run at 6.3 m/s).
MAX_EFFORT_MPS = 6.5

#: How the record tables name each distance.
EFFORT_LABELS: dict[float, str] = {
    1000.0: "1 km",
    5000.0: "5 km",
    10000.0: "10 km",
    21097.5: "Semi-marathon",
    42195.0: "Marathon",
}
#: Exercises the record tables list: the most practised.
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
    exercise_id: int
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


def _metres(key: str) -> float | None:
    """The record distance a ``best_efforts`` key names, None for another."""
    try:
        metres = float(key)
    except ValueError:
        return None
    return metres if metres in EFFORT_LABELS else None


def run_records(rows: Sequence[EffortRecord]) -> list[RunRecord]:
    """The fastest run per distance, shortest distance first."""
    records: list[tuple[float, RunRecord]] = []
    for row in rows:
        metres = _metres(row.key) if row.kind == "run" else None
        if metres is None:
            continue
        seconds = int(row.value)
        records.append(
            (
                metres,
                {
                    "name": EFFORT_LABELS[metres],
                    "distance_m": metres,
                    "time_sec": seconds,
                    "time_display": _hms(seconds),
                    "pace_display": _pace(seconds, metres),
                    "date": row.date.isoformat(),
                    "session_id": row.session_id,
                    "session_name": row.session_name,
                },
            )
        )
    return [record for _, record in sorted(records, key=lambda item: item[0])]


def lift_records(rows: Sequence[EffortRecord]) -> list[LiftRecord]:
    """Best e1RM of the most practised exercises."""
    lifts = sorted(
        (row for row in rows if row.kind == "lift" and row.exercise is not None),
        key=lambda row: (-row.sessions, row.exercise),
    )
    return [
        {
            "exercise_id": int(row.key),
            "exercise": row.exercise or "",
            "e1rm_kg": round(row.value, 1),
            "weight_kg": row.weight_kg or 0.0,
            "reps": row.reps or 0,
            "date": row.date.isoformat(),
            "session_id": row.session_id,
            "sessions": row.sessions,
        }
        for row in lifts[:LIFTS_SHOWN]
    ]


def is_record(row: EffortRecord) -> bool:
    """Whether a range's best beats every earlier one (or is the first)."""
    if row.previous is None:
        return True
    if row.kind == "run":
        return row.value < row.previous
    return round(row.value, 1) > round(row.previous, 1)


def lift_trend(
    rows: Sequence[LiftEffort], window: PeriodWindow
) -> tuple[str, float, float] | None:
    """(exercise, previous window's best e1RM, this window's) for the most
    practised exercise of the window that the previous window also has.

    ``rows`` hold every log's best per exercise from the previous window on.
    """
    if window.prev_start is None or window.prev_end is None:
        return None

    def bests(start: date, end: date) -> dict[int, tuple[str, float, set[int]]]:
        out: dict[int, tuple[str, float, set[int]]] = {}
        for row in rows:
            if not start <= row.date <= end:
                continue
            name, top, seen = out.get(row.exercise_id, (row.exercise, 0.0, set()))
            out[row.exercise_id] = (
                name,
                max(top, row.e1rm_kg),
                seen | {row.session_id},
            )
        return out

    current = bests(window.start, window.end)
    previous = bests(window.prev_start, window.prev_end)
    shared = [key for key in current if key in previous]
    if not shared:
        return None
    key = max(shared, key=lambda k: (len(current[k][2]), current[k][1]))
    name, best, _ = current[key]
    return name, round(previous[key][1], 1), round(best, 1)


def records_payload(rows: Sequence[EffortRecord]) -> dict[str, Any]:
    """The Records card: both all-time tables."""
    return {"runs": run_records(rows), "lifts": lift_records(rows)}
