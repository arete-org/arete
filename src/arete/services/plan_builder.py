"""A goal's periodised plan: read the athlete, generate, write, take back.

``features.plan_generator`` builds the weeks; this module supplies what it
needs (recent running volume and frequency, rest days, VDOT paces) and
owns the write rules: generated sessions are ``source='plan'`` and linked to
the goal; regenerating replaces only the goal's future pending sessions; a
day that already holds another planned session is left alone.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, timedelta
from typing import Any

from arete.dataio.db import connect
from arete.dataio.queries import RUNNING_SPORTS, sql_in
from arete.dataio.settings import get_user_settings
from arete.features.plan_generator import PlanInputs, WeekPlan, generate_plan
from arete.features.running import training_paces
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services.goals import Goal, get_goal
from arete.services.settings import athlete_today

_WEEKDAYS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
HISTORY_DAYS = 28
DEFAULT_RUNS_PER_WEEK = 4


def _recent_running(con, today: date) -> tuple[float, int]:
    """(running minutes per week, running sessions per week) over 4 weeks."""
    row = con.execute(
        f"""
        SELECT COALESCE(SUM(duration_sec), 0) / 60.0, COUNT(*)
        FROM app.visible_actual_sessions
        WHERE user_id = getvariable('arete_athlete_id') AND sport IN ({sql_in(RUNNING_SPORTS)})
          AND date >= ? AND date < ?
        """,
        [today - timedelta(days=HISTORY_DAYS), today],
    ).fetchone()
    minutes, count = row or (0.0, 0)
    weeks = HISTORY_DAYS / 7
    return float(minutes) / weeks, round(int(count) / weeks)


def plan_inputs(goal: Goal, today: date | None = None) -> PlanInputs:
    from arete.services.metrics import current_vdot

    today = today or athlete_today()
    settings = get_user_settings() or {}
    con = connect()
    try:
        minutes, runs = _recent_running(con, today)
        vdot = current_vdot(con)
    finally:
        con.close()
    rest = frozenset(
        _WEEKDAYS.index(d)
        for d in settings.get("rest_day_preference") or []
        if d in _WEEKDAYS
    )
    goal_sessions = int(settings.get("weekly_training_goal") or DEFAULT_RUNS_PER_WEEK)
    runs = max(3, min(runs or DEFAULT_RUNS_PER_WEEK, 6, goal_sessions))
    return PlanInputs(
        start=today + timedelta(days=1),  # today belongs to the daily adaptation
        race_date=goal.race_date,
        distance_km=goal.distance_km,
        weekly_minutes_now=minutes,
        sessions_per_week=runs,
        rest_days=rest,
        paces=training_paces(vdot[0]) if vdot else None,
        race_name=goal.name,
    )


def _weeks_to_dict(weeks: list[WeekPlan]) -> list[dict[str, Any]]:
    return [
        {
            "start": w.start.isoformat(),
            "phase": w.phase,
            "minutes": w.minutes,
            "recovery": w.recovery,
            "sessions": [{**asdict(s), "date": s.date.isoformat()} for s in w.sessions],
        }
        for w in weeks
    ]


def _goal_or_raise(goal_id: int) -> Goal:
    goal = get_goal(goal_id)
    if goal is None:
        raise LookupError(f"goal {goal_id}")
    return goal


def preview(goal_id: int, today: date | None = None) -> dict[str, Any]:
    """The plan as it would be written, without writing it."""
    goal = _goal_or_raise(goal_id)
    inputs = plan_inputs(goal, today)
    weeks = generate_plan(inputs)
    return {
        "goal": goal.to_dict(today),
        "inputs": {
            "weekly_minutes_now": round(inputs.weekly_minutes_now),
            "sessions_per_week": inputs.sessions_per_week,
            "rest_days": sorted(inputs.rest_days),
            "vdot": round(inputs.paces.vdot, 1) if inputs.paces else None,
        },
        "weeks": _weeks_to_dict(weeks),
    }


def _delete_future(goal_id: int, start: date) -> int:
    """Delete the goal's sessions still to do from ``start``, through the
    repository so a Garmin export follows the deletion; one it refuses (an
    export still in progress) stays."""
    con = connect()
    try:
        ids = [
            r[0]
            for r in con.execute(
                "SELECT id FROM app.visible_planned_sessions WHERE goal_id = ? AND status = 'pending' AND date >= ?",
                [goal_id, start],
            ).fetchall()
        ]
    finally:
        con.close()
    repo, deleted = GarminRepository(), 0
    for session_id in ids:
        try:
            deleted += bool(repo.delete_planned_session(session_id))
        except ValueError:
            continue
    return deleted


def apply(goal_id: int, today: date | None = None) -> dict[str, Any]:
    """Write the goal's plan, replacing its own future sessions still to do."""
    goal = _goal_or_raise(goal_id)
    inputs = plan_inputs(goal, today)
    weeks = generate_plan(inputs)
    replaced = _delete_future(goal.id, inputs.start)
    con = connect()
    try:
        taken = {
            r[0]
            for r in con.execute(
                "SELECT DISTINCT date FROM app.visible_planned_sessions WHERE date BETWEEN ? AND ? AND status <> 'skipped'",
                [inputs.start, goal.race_date],
            ).fetchall()
        }
    finally:
        con.close()
    repo = GarminRepository()
    created, skipped = 0, []
    for week in weeks:
        for draft in week.sessions:
            if draft.date in taken:
                skipped.append(draft.date.isoformat())
                continue
            repo.create_planned_session(
                PlannedSession(
                    date=draft.date,
                    sport="running",
                    session_type=SessionType(draft.session_type),
                    target_duration_min=draft.duration_min,
                    target_distance_km=draft.distance_km,
                    target_hr_zone=draft.hr_zone,
                    target_intensity=draft.intensity,
                    description=draft.description,
                    source="plan",
                    status=SessionStatus.PENDING,
                    goal_id=goal.id,
                )
            )
            created += 1
    return {
        "created": created,
        "replaced": replaced,
        "skipped_days": skipped,  # another planned session was already there
        "weeks": len(weeks),
    }


def remove(goal_id: int, today: date | None = None) -> int:
    """Delete the goal's generated sessions still to come; how many."""
    _goal_or_raise(goal_id)
    return _delete_future(goal_id, (today or athlete_today()) + timedelta(days=1))


# --------------------------------------------------------------------------- #
# Form on race day: the history plus what is planned
# --------------------------------------------------------------------------- #
#: Race minutes when there is neither a target time nor a VDOT: 6:00/km.
FALLBACK_RACE_PACE_SEC_KM = 360


def _race_minutes(goal: Goal, con=None) -> float:
    from arete.features.running import race_time_sec
    from arete.services.metrics import current_vdot

    if goal.target_time_sec:
        return goal.target_time_sec / 60
    vdot = current_vdot(con)
    if vdot:
        return race_time_sec(vdot[0], goal.distance_km * 1000) / 60
    return goal.distance_km * FALLBACK_RACE_PACE_SEC_KM / 60


#: The days of history a projection shows before today (Planning's chart).
PROJECTION_HISTORY_DAYS = 28


@dataclass(frozen=True)
class Projected:
    """A projection and what it was computed from, for a caller that needs more
    than ``projection``'s answer (the dashboard's curve) on its own connection."""

    answer: dict[str, Any]
    #: The sessions still to do from today to race day, today's included even
    #: when a session is already logged (the evening run of a double day).
    planned: list[PlannedSession]


def _point(
    day: date, ctl: float, atl: float, tss: float, planned: bool
) -> dict[str, Any]:
    return {
        "date": day.isoformat(),
        "ctl": round(ctl, 1),
        "atl": round(atl, 1),
        "tsb": round(ctl - atl, 1),
        "tss": round(tss, 1),
        "planned": planned,
    }


def project(
    goal: Goal, today: date, con, history_days: int = PROJECTION_HISTORY_DAYS
) -> Projected:
    """``projection`` for a goal already read, every statement on ``con``."""
    from arete.dataio.queries import daily_tss_by_date
    from arete.features.plan_generator import planned_tss
    from arete.services.metrics import fitness_series

    history = {d: t for d, t in daily_tss_by_date(con).items() if d <= today}
    # Today counts as done once a session is in; otherwise its plan still stands.
    first_planned = today + timedelta(days=1) if history.get(today) else today
    planned = [
        s
        for s in GarminRepository().list_planned_sessions(
            start_date=today,
            end_date=goal.race_date,
            status=None,
            limit=500,
            ascending=True,
            connection=con,
        )
        if s.status in (SessionStatus.PENDING, SessionStatus.MODIFIED)
    ]
    future: dict[date, float] = {}
    for s in planned:
        if s.date < first_planned:
            continue  # today's plan once a session is logged: its load is in
        if s.session_type == SessionType.RACE and s.date == goal.race_date:
            minutes = _race_minutes(goal, con)
        else:
            minutes = float(s.target_duration_min or 0)
        future[s.date] = future.get(s.date, 0.0) + planned_tss(
            s.session_type.value, minutes
        )

    loads = {**history, **future}
    loads.setdefault(goal.race_date, 0.0)
    shown: list[dict[str, Any]] = []
    for day, ctl, atl in fitness_series(loads, goal.race_date):
        if day.date < today - timedelta(days=history_days):
            continue
        shown.append(_point(day.date, ctl, atl, day.tss, planned=day.date in future))
    # Race morning: the form the day before, before the race's own load lands.
    # Read before today's point is replaced: a race tomorrow follows today's plan.
    morning = shown[-2] if len(shown) > 1 else (shown[-1] if shown else None)
    if today in future:
        # Today's point is the logged form, as on the dashboard and
        # /metrics/fitness; today's plan weighs from tomorrow on.
        logged = fitness_series(history, today)
        _, ctl, atl = logged[-1] if logged else (None, 0.0, 0.0)
        shown = [
            _point(today, ctl, atl, history.get(today, 0.0), planned=False)
            if p["date"] == today.isoformat()
            else p
            for p in shown
        ]
    ctls = [float(p["ctl"]) for p in shown]
    answer = {
        "goal": goal.to_dict(today),
        "series": shown,
        "race_day": {
            "ctl": morning["ctl"] if morning else None,
            "tsb": morning["tsb"] if morning else None,
        },
        "peak_ctl": max(ctls) if ctls else None,
        "planned_sessions": len(future),
    }
    return Projected(answer, planned)


def projection(goal_id: int, today: date | None = None) -> dict[str, Any]:
    """CTL / ATL / TSB day by day until race day, from history and plan."""
    goal = _goal_or_raise(goal_id)
    con = connect()
    try:
        return project(goal, today or athlete_today(), con).answer
    finally:
        con.close()
