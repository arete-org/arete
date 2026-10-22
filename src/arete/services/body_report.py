"""The report for a physio or a sports doctor (ARE-62): eight weeks, no model.

What a practitioner asks first, from the stored data only: the weekly load
(sessions, time, distance, the shared TSS estimate and the ACWR at each
week's end), the sessions themselves, the pain declared, the body weight, the
readiness Garmin measured and the morning check-ins. The window is eight
calendar weeks, Monday to Sunday, the current one ending today.

The browser prints it (``/sante/rapport``): no PDF library, nothing heavy at
boot. Free text stays out but for the pain notes, written for this purpose:
session and check-in notes may say anything. Strava rows count, as on the
year review: the report is the athlete's own and never reaches the coach.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from arete.dataio.db import db_connection
from arete.dataio.queries import TSS_EXPR, daily_loads
from arete.features.workload import compute_workload_metrics
from arete.services import body_log
from arete.services.settings import athlete_today

REPORT_WEEKS = 8

#: Strength logs recorded with a Garmin activity are that activity: counted once.
_SESSIONS_SQL = f"""
    SELECT id, date, sport, name, COALESCE(duration_sec, 0), distance_m, avg_hr,
           rpe, {TSS_EXPR}
    FROM (
      SELECT id, user_id, date, sport, name, duration_sec, rpe, avg_hr, distance_m
      FROM app.visible_actual_sessions
      UNION ALL
      SELECT -id, user_id, date, 'strength', name, duration_min * 60,
             CAST(ROUND(overall_rpe) AS INTEGER), NULL, NULL
      FROM app.visible_strength_sessions
      WHERE actual_session_id IS NULL
    ) AS sessions
    WHERE user_id = getvariable('arete_athlete_id') AND date >= ? AND date <= ?
    ORDER BY date ASC, id ASC
"""

_READINESS_SQL = """
    SELECT date, training_readiness_score, readiness_score, sleep_score,
           resting_hr, hrv_last_night
    FROM app.visible_daily_metrics
    WHERE user_id = getvariable('arete_athlete_id') AND date >= ? AND date <= ?
      AND (training_readiness_score IS NOT NULL OR readiness_score IS NOT NULL
           OR sleep_score IS NOT NULL OR resting_hr IS NOT NULL
           OR hrv_last_night IS NOT NULL)
    ORDER BY date
"""

#: The answers only, never the note.
_CHECKINS_SQL = """
    SELECT date, sleep, legs, mood FROM app.visible_daily_checkins
    WHERE answered_at IS NOT NULL AND date >= ? AND date <= ? ORDER BY date
"""


def window(weeks: int = REPORT_WEEKS, today: date | None = None) -> tuple[date, date]:
    """The Monday ``weeks - 1`` weeks before this one, and today."""
    assert 1 <= weeks <= 52
    end = today or athlete_today()
    start = end - timedelta(days=end.weekday()) - timedelta(weeks=weeks - 1)
    return start, end


def report(weeks: int = REPORT_WEEKS, today: date | None = None) -> dict[str, Any]:
    """Everything the report prints, read in one connection."""
    start, end = window(weeks, today)
    with db_connection() as con:
        rows = con.execute(_SESSIONS_SQL, [start, end]).fetchall()
        # 28 days before the first week end feed its ACWR.
        loads = daily_loads(con, start - timedelta(days=28), end)
        readiness = con.execute(_READINESS_SQL, [start, end]).fetchall()
        checkins = con.execute(_CHECKINS_SQL, [start, end]).fetchall()
        pain = body_log.list_pain(start, end, con)
        weights = body_log.list_weights(start, end, con)

    sessions = [
        {
            "date": row[1].isoformat(),
            "kind": "strength" if row[0] < 0 else "cardio",
            "sport": row[2],
            "name": row[3],
            "duration_min": round(row[4] / 60),
            "distance_km": round(row[5] / 1000, 1) if row[5] else None,
            "avg_hr": row[6],
            "rpe": row[7],
            "tss": round(row[8]),
        }
        for row in rows
    ]
    week_rows = []
    for index in range(weeks):
        monday = start + timedelta(weeks=index)
        last = min(monday + timedelta(days=6), end)
        inside = [
            s for s in sessions if monday.isoformat() <= s["date"] <= last.isoformat()
        ]
        chronic = [load for load in loads if load.date <= last]
        acwr = (
            compute_workload_metrics(loads, last).acwr
            if any(load.duration_min > 0 for load in chronic[-28:])
            else None
        )
        week_rows.append(
            {
                "week_start": monday.isoformat(),
                "week_end": last.isoformat(),
                "sessions": len(inside),
                "duration_min": sum(s["duration_min"] for s in inside),
                "distance_km": round(sum(s["distance_km"] or 0 for s in inside), 1),
                "tss": sum(s["tss"] for s in inside),
                "acwr": round(acwr, 2) if acwr is not None else None,
            }
        )

    pain_oldest_first = list(reversed(pain))
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "weeks": week_rows,
        "sessions": sessions,
        "pain": [p.to_dict() for p in pain_oldest_first],
        "pain_areas": body_log.pain_areas(pain),
        "weights": [w.to_dict() for w in weights],
        "weight": body_log.weight_summary(weights),
        "readiness": [
            {
                "date": r[0].isoformat(),
                "garmin_readiness": r[1],
                "readiness": r[2],
                "sleep_score": r[3],
                "resting_hr": r[4],
                "hrv": r[5],
            }
            for r in readiness
        ],
        "checkins": [
            {"date": c[0].isoformat(), "sleep": c[1], "legs": c[2], "mood": c[3]}
            for c in checkins
        ],
        "totals": {
            "sessions": len(sessions),
            "duration_min": sum(s["duration_min"] for s in sessions),
            "pain_entries": len(pain),
            "max_pain": max((p.intensity for p in pain), default=None),
        },
    }
