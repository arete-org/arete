"""Year in review: one calendar year in numbers, computed without a model.

The Garmin Rundown / Strava Year in Sport equivalent. Everything is read from
the stored sessions and derived deterministically: totals and sports, month by
month, the year's standout sessions, best efforts against the years before,
consistency, the fitness (CTL) curve and strength volume. The fitness series is
the one every other surface draws (``services.metrics.fitness_series``) and the
load per session is the shared TSS estimate, so the numbers agree with Analytics.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any, NamedTuple

from arete.dataio.db import db_connection
from arete.dataio.queries import (
    RUNNING_SPORTS,
    TSS_EXPR,
    best_effort_rows,
    daily_tss_by_date,
)
from arete.services.analytics import EFFORT_NAMES, best_efforts
from arete.services.metrics import fitness_series
from arete.services.settings import athlete_today

#: Oldest year the page accepts; anything earlier is a typo, not a history.
FIRST_YEAR = 2000

#: Strength sessions recorded with a Garmin activity are that activity: counted
#: once, as in ``queries.LOAD_ROWS``. Unlike the load series, a strength session
#: without a duration still counts as a session here (it carries no load).
#: Strava rows count: the year review is the athlete's own page and never
#: reaches the coach, unlike the load series (ARE-126).
_SESSIONS_SQL = f"""
    SELECT id, date, sport, name, COALESCE(duration_sec, 0), distance_m, ascent_m,
           {TSS_EXPR}
    FROM (
      SELECT id, user_id, date, sport, name, duration_sec, rpe,
             avg_hr, distance_m, ascent_m
      FROM app.visible_actual_sessions
      UNION ALL
      SELECT -id, user_id, date, 'strength', name, duration_min * 60,
             CAST(ROUND(overall_rpe) AS INTEGER), NULL, NULL, NULL
      FROM app.visible_strength_sessions
      WHERE actual_session_id IS NULL
    ) AS sessions
    WHERE user_id = getvariable('arete_athlete_id') AND date >= ? AND date <= ?
    ORDER BY date ASC, id ASC
"""

#: Working sets only, as every other volume figure (``SessionExercise.total_volume``).
_STRENGTH_MONTHS_SQL = """
    SELECT month(ss.date), COUNT(DISTINCT ss.id), COUNT(es.id),
           COALESCE(SUM(es.reps * COALESCE(es.weight_kg, 0)), 0)
    FROM app.visible_strength_sessions ss
    LEFT JOIN app.visible_session_exercises se ON se.session_id = ss.id
    LEFT JOIN app.visible_exercise_sets es
      ON es.session_exercise_id = se.id AND NOT COALESCE(es.is_warmup, FALSE)
    WHERE ss.user_id = getvariable('arete_athlete_id') AND ss.date >= ? AND ss.date <= ?
    GROUP BY 1
"""

_TOP_EXERCISES_SQL = """
    SELECT e.name, SUM(es.reps * COALESCE(es.weight_kg, 0)) AS volume,
           COUNT(*), MAX(es.weight_kg)
    FROM app.visible_strength_sessions ss
    JOIN app.visible_session_exercises se ON se.session_id = ss.id
    JOIN app.visible_exercise_sets es ON es.session_exercise_id = se.id
    JOIN app.visible_exercises e ON e.id = se.exercise_id
    WHERE ss.user_id = getvariable('arete_athlete_id') AND ss.date >= ? AND ss.date <= ?
      AND NOT COALESCE(es.is_warmup, FALSE)
    GROUP BY e.name
    ORDER BY volume DESC, e.name ASC
    LIMIT ?
"""

_YEARS_SQL = """
    SELECT DISTINCT year(date) AS y FROM app.visible_actual_sessions WHERE user_id = getvariable('arete_athlete_id')
    UNION
    SELECT DISTINCT year(date) FROM app.visible_strength_sessions WHERE user_id = getvariable('arete_athlete_id')
"""

TOP_EXERCISES = 3


class _Session(NamedTuple):
    id: int
    date: date
    sport: str
    name: str | None
    duration_sec: int
    distance_m: float | None
    ascent_m: float | None
    tss: float


def _period(year: int, today: date) -> tuple[date, date]:
    if not FIRST_YEAR <= year <= today.year:
        raise ValueError(f"Année hors limites : {year}")
    end = date(year, 12, 31)
    return date(year, 1, 1), min(end, today)


def _session_dict(s: _Session | None) -> dict[str, Any] | None:
    if s is None:
        return None
    return {
        # Negative ids are strength sessions logged without a Garmin activity.
        "id": s.id if s.id > 0 else None,
        "date": s.date.isoformat(),
        "sport": s.sport,
        "name": s.name,
        "duration_sec": s.duration_sec,
        "distance_m": round(s.distance_m) if s.distance_m else None,
        "ascent_m": round(s.ascent_m) if s.ascent_m else None,
        "tss": round(s.tss),
    }


def _top(sessions: Sequence[_Session], key) -> _Session | None:
    """The session with the largest positive ``key``; the earliest on a tie."""
    best: _Session | None = None
    for s in sessions:
        value = key(s) or 0
        if value > 0 and (best is None or value > (key(best) or 0)):
            best = s
    return best


def _sports(sessions: Sequence[_Session]) -> list[dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = {}
    for s in sessions:
        t = totals.setdefault(
            s.sport,
            {"sport": s.sport, "sessions": 0, "duration_sec": 0, "distance_m": 0.0},
        )
        t["sessions"] += 1
        t["duration_sec"] += s.duration_sec
        t["distance_m"] += s.distance_m or 0
    all_time = sum(t["duration_sec"] for t in totals.values())
    ranked = sorted(
        totals.values(), key=lambda t: (t["duration_sec"], t["sessions"]), reverse=True
    )
    for t in ranked:
        t["distance_m"] = round(t["distance_m"])
        t["pct_time"] = round(100 * t["duration_sec"] / all_time, 1) if all_time else 0
    return ranked


def _months(
    sessions: Sequence[_Session], strength: dict[int, tuple[int, int, float]]
) -> list[dict[str, Any]]:
    months = [
        {
            "month": m,
            "sessions": 0,
            "duration_sec": 0,
            "distance_m": 0.0,
            "ascent_m": 0.0,
            "tss": 0.0,
            "strength_volume_kg": round(strength.get(m, (0, 0, 0.0))[2], 1),
        }
        for m in range(1, 13)
    ]
    for s in sessions:
        month = months[s.date.month - 1]
        month["sessions"] += 1
        month["duration_sec"] += s.duration_sec
        month["distance_m"] += s.distance_m or 0
        month["ascent_m"] += s.ascent_m or 0
        month["tss"] += s.tss
    for month in months:
        for key in ("distance_m", "ascent_m", "tss"):
            month[key] = round(month[key])
    return months


def _longest_run(flags: Sequence[bool]) -> int:
    best = current = 0
    for flag in flags:
        current = current + 1 if flag else 0
        best = max(best, current)
    return best


def consistency(active: set[date], start: date, end: date) -> dict[str, int]:
    """Active days and weeks over ``start``..``end``, and the longest streaks.

    A week runs Monday to Sunday; the weeks counted are those the period
    touches, so the first and last may be partial.
    """
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    first_monday = start - timedelta(days=start.weekday())
    mondays = [
        first_monday + timedelta(weeks=i)
        for i in range((end - first_monday).days // 7 + 1)
    ]
    active_weeks = [
        any(monday + timedelta(days=d) in active for d in range(7))
        for monday in mondays
    ]
    return {
        "active_days": sum(1 for d in days if d in active),
        "days": len(days),
        "active_weeks": sum(active_weeks),
        "weeks": len(mondays),
        "longest_day_streak": _longest_run([d in active for d in days]),
        "longest_week_streak": _longest_run(active_weeks),
    }


def _fitness(by_date: dict[date, float], start: date, end: date) -> dict[str, Any]:
    """The CTL curve over the year, one point a week (Sundays and the last day)."""
    year = [
        (day.date, ctl)
        for day, ctl, _ in fitness_series(by_date, end)
        if day.date >= start
    ]
    if not year:
        return {"series": [], "peak": None, "start_ctl": None, "end_ctl": None}
    series = [
        {"date": d.isoformat(), "ctl": round(ctl, 1)}
        for i, (d, ctl) in enumerate(year)
        if d.weekday() == 6 or i == len(year) - 1
    ]
    peak_date, peak = max(year, key=lambda point: point[1])
    return {
        "series": series,
        "peak": {"date": peak_date.isoformat(), "ctl": round(peak, 1)},
        "start_ctl": round(year[0][1], 1),
        "end_ctl": round(year[-1][1], 1),
    }


def _efforts(rows: Sequence[tuple], start: date, end: date) -> list[dict[str, Any]]:
    """The year's best effort per distance, and whether it beat every earlier year."""
    this_year = best_efforts([r for r in rows if start <= r[1] <= end])
    before = best_efforts([r for r in rows if r[1] < start])
    efforts = []
    for name in EFFORT_NAMES:
        if name not in this_year:
            continue
        effort = this_year[name]
        previous = before.get(name, {}).get("time_sec")
        efforts.append(
            {
                **effort,
                "previous_best_sec": previous,
                "is_pr": previous is None or effort["time_sec"] < previous,
            }
        )
    return efforts


def year_review(year: int, today: date | None = None) -> dict[str, Any]:
    """Every number of the year-in-review page; ValueError outside 2000..this year."""
    today = today or athlete_today()
    start, end = _period(year, today)
    with db_connection() as con:
        sessions = [
            _Session(*row)
            for row in con.execute(_SESSIONS_SQL, [start, end]).fetchall()
        ]
        strength = {
            int(m): (int(n), int(sets), float(volume))
            for m, n, sets, volume in con.execute(
                _STRENGTH_MONTHS_SQL, [start, end]
            ).fetchall()
        }
        top_exercises = con.execute(
            _TOP_EXERCISES_SQL, [start, end, TOP_EXERCISES]
        ).fetchall()
        by_date = daily_tss_by_date(con)
        effort_rows = best_effort_rows(con, RUNNING_SPORTS)
        years = {int(r[0]) for r in con.execute(_YEARS_SQL).fetchall()}

    years.add(today.year)
    efforts = _efforts(effort_rows, start, end)
    return {
        "year": year,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "complete": end == date(year, 12, 31),
        "years": sorted((y for y in years if y >= FIRST_YEAR), reverse=True),
        "totals": {
            "sessions": len(sessions),
            "duration_sec": sum(s.duration_sec for s in sessions),
            "distance_m": round(sum(s.distance_m or 0 for s in sessions)),
            "ascent_m": round(sum(s.ascent_m or 0 for s in sessions)),
            "tss": round(sum(s.tss for s in sessions)),
        },
        "sports": _sports(sessions),
        "months": _months(sessions, strength),
        "consistency": consistency({s.date for s in sessions}, start, end),
        "highlights": {
            "longest_distance": _session_dict(_top(sessions, lambda s: s.distance_m)),
            "longest_duration": _session_dict(_top(sessions, lambda s: s.duration_sec)),
            "hardest": _session_dict(_top(sessions, lambda s: s.tss)),
            "biggest_climb": _session_dict(_top(sessions, lambda s: s.ascent_m)),
        },
        "best_efforts": efforts,
        "pr_count": sum(1 for e in efforts if e["is_pr"]),
        "fitness": _fitness(by_date, start, end),
        "strength": {
            "sessions": sum(n for n, _, _ in strength.values()),
            "working_sets": sum(sets for _, sets, _ in strength.values()),
            "volume_kg": round(sum(v for _, _, v in strength.values()), 1),
            "top_exercises": [
                {
                    "name": name,
                    "volume_kg": round(float(volume or 0), 1),
                    "sets": int(sets),
                    "max_weight_kg": max_weight,
                }
                for name, volume, sets, max_weight in top_exercises
            ],
        },
    }
