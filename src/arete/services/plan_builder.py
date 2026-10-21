"""A goal's periodised plan: read the athlete, generate, write, take back.

``features.plan_generator`` builds a road race's weeks and
``features.hybrid_plan`` a Hyrox race's or a hybrid block's; this module
supplies what they need (recent running volume and frequency, strength
sessions, rest days, VDOT paces, the load's ACWR and TSB) and owns the write
rules: generated sessions are ``source='plan'`` and linked to the goal;
regenerating replaces only the goal's future pending sessions the athlete
never touched (``revision = 1``: every edit goes through the repository,
which increments it); a day that already holds another planned session is
left alone.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, timedelta
from typing import Any

import duckdb

from arete.dataio.db import connect
from arete.dataio.queries import RUNNING_SPORTS, sql_in
from arete.dataio.settings import get_user_settings
from arete.features.hybrid_plan import (
    HYBRID_PLANNED_RPE,
    KEPT,
    HybridInputs,
    athlete_level,
    default_rules,
    generate_hybrid_plan,
    kept_tags,
    kind_of,
    loading_sessions,
)
from arete.features.plan_generator import (
    PLANNED_RPE,
    DraftSession,
    PlanInputs,
    WeekPlan,
    generate_plan,
    planned_tss,
)
from arete.features.running import training_paces
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import hybrid_strength
from arete.services.adaptation import ACWR_REST_AT, TSB_EASE_AT
from arete.services.goals import Goal, GoalDetails, get_goal
from arete.services.plan_summary import weekly_summary
from arete.services.prescriptions import Prescription
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
#: Settings' weekly sessions goal when unset (``services.settings``). A
#: Hyrox or hybrid plan reads it as training days: past them, sessions pair
#: on hard days rather than taking another day.
DEFAULT_WEEKLY_SESSIONS = 6
#: Interference rules; the deload starts where the daily adaptation rests or eases.
HYBRID_RULES = default_rules(acwr_above=ACWR_REST_AT, tsb_below=TSB_EASE_AT)


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


def _recent_strength(con, today: date) -> float:
    """Strength days per week over 4 weeks: the strength log and Garmin's."""
    row = con.execute(
        """
        SELECT count(DISTINCT date) FROM (
            SELECT date FROM app.visible_strength_sessions
            WHERE user_id = getvariable('arete_athlete_id') AND date >= ? AND date < ?
            UNION ALL
            SELECT date FROM app.visible_actual_sessions
            WHERE user_id = getvariable('arete_athlete_id') AND sport = 'strength'
              AND date >= ? AND date < ?
        )
        """,
        [today - timedelta(days=HISTORY_DAYS), today] * 2,
    ).fetchone()
    return int(row[0] if row else 0) / (HISTORY_DAYS / 7)


def _rest_days(settings: dict[str, Any]) -> frozenset[int]:
    return frozenset(
        _WEEKDAYS.index(d)
        for d in settings.get("rest_day_preference") or []
        if d in _WEEKDAYS
    )


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
    rest = _rest_days(settings)
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


def _kept(con, goal: Goal, start: date) -> list[PlannedSession]:
    """The goal's generated sessions from ``start`` that regeneration keeps:
    those the athlete edited (``revision > 1``) or the daily adaptation
    changed. Only a Hyrox or hybrid plan stores a session's kind; one without
    (a road plan's, a manual one) only keeps its day, as before."""
    return [
        s
        for s in GarminRepository().list_planned_sessions(
            start_date=start,
            end_date=goal.race_date,
            status=None,
            limit=500,
            ascending=True,
            connection=con,
        )
        if s.goal_id == goal.id
        and s.plan_kind is not None
        and (
            s.status == SessionStatus.MODIFIED
            or (s.status == SessionStatus.PENDING and s.revision > 1)
        )
    ]


def hybrid_inputs(goal: Goal, today: date | None = None) -> HybridInputs:
    from arete.services.coaching_rules import rule_facts
    from arete.services.metrics import current_vdot

    assert goal.goal_type in ("hyrox", "hybrid"), goal.goal_type
    today = today or athlete_today()
    start = today + timedelta(days=1)  # today belongs to the daily adaptation
    settings = get_user_settings() or {}
    con = connect()
    try:
        minutes, runs = _recent_running(con, today)
        strength = _recent_strength(con, today)
        vdot = current_vdot(con)
        kept = _kept(con, goal, start)
    finally:
        con.close()
    facts = rule_facts(today)  # the readiness rules' ACWR and TSB
    details = GoalDetails.model_validate(goal.details or {})
    level = athlete_level(runs, minutes, strength)
    return HybridInputs(
        start=start,
        race_date=goal.race_date,
        kind="hyrox" if goal.goal_type == "hyrox" else "hybrid",
        level=level,
        weekly_minutes_now=minutes,
        training_days=int(
            settings.get("weekly_training_goal") or DEFAULT_WEEKLY_SESSIONS
        ),
        rest_days=_rest_days(settings),
        paces=training_paces(vdot[0]) if vdot else None,
        race_name=goal.name,
        division=details.division,
        format=details.format,
        equipment=frozenset(details.equipment) - {"none"},
        weeks=details.weeks,
        acwr=facts.acwr,
        tsb=facts.tsb,
        kept=tuple(
            DraftSession(
                s.date,
                s.session_type.value,
                s.target_duration_min,
                s.target_hr_zone,
                s.target_intensity,
                s.description or "",
                s.target_distance_km,
                sport=s.sport,
                tags=tags,
            )
            for s in kept
            if (
                tags := kept_tags(
                    s.plan_kind or "", level, s.session_type.value, s.target_intensity
                )
            )
            is not None
        ),
    )


@dataclass(frozen=True)
class _Plan:
    start: date  # the first day it may fill
    weeks: list[WeekPlan]
    inputs: dict[str, Any]  # what the preview shows it was built from


def _generate(goal: Goal, today: date | None) -> _Plan:
    """The goal's plan, by goal type; raises ``PlanError``."""
    if goal.goal_type == "race":
        inputs = plan_inputs(goal, today)
        return _Plan(
            inputs.start,
            generate_plan(inputs),
            {
                "weekly_minutes_now": round(inputs.weekly_minutes_now),
                "sessions_per_week": inputs.sessions_per_week,
                "rest_days": sorted(inputs.rest_days),
                "vdot": round(inputs.paces.vdot, 1) if inputs.paces else None,
            },
        )
    hybrid = hybrid_inputs(goal, today)
    weeks = hybrid_strength.prescribe(
        generate_hybrid_plan(hybrid, HYBRID_RULES),
        level=hybrid.level,
        division=hybrid.division,
        category=GoalDetails.model_validate(goal.details or {}).category,
        equipment=hybrid.equipment,
        starts=hybrid_strength.starting_loads(),
    )
    return _Plan(
        hybrid.start,
        weeks,
        {
            "weekly_minutes_now": round(hybrid.weekly_minutes_now),
            # The goals panel's figure: the sessions of a loading week.
            "sessions_per_week": loading_sessions(hybrid.level),
            "training_days": hybrid.training_days,
            "rest_days": sorted(hybrid.rest_days),
            "vdot": round(hybrid.paces.vdot, 1) if hybrid.paces else None,
            "level": hybrid.level,
            "deload": bool(weeks)
            and weeks[0].recovery
            and HYBRID_RULES.deload.triggered(hybrid.acwr, hybrid.tsb),
            "kept": [
                {"date": k.date.isoformat(), "description": k.description}
                for k in hybrid.kept
            ],
        },
    )


def _weeks_to_dict(weeks: list[WeekPlan]) -> list[dict[str, Any]]:
    return [
        {
            "start": w.start.isoformat(),
            "phase": w.phase,
            "minutes": w.minutes,
            "recovery": w.recovery,
            "sessions": [
                {
                    **{k: v for k, v in asdict(s).items() if k != "stations"},
                    "date": s.date.isoformat(),
                    "tags": sorted(s.tags),
                    # What the preview names it; a road plan's sessions have no tags.
                    "kind": kind_of(s.tags) if s.tags else None,
                }
                for s in w.sessions
            ],
            "dropped": w.dropped,
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
    plan = _generate(goal, today)
    return {
        "goal": goal.to_dict(today),
        "inputs": plan.inputs,
        # A Hyrox or hybrid plan's weekly structure, one French line per phase.
        "summary": [] if goal.goal_type == "race" else weekly_summary(plan.weeks),
        "weeks": _weeks_to_dict(plan.weeks),
    }


def _delete_future(goal_id: int, start: date, *, untouched_only: bool = False) -> int:
    """Delete the goal's sessions still to do from ``start``, through the
    repository so a Garmin export follows the deletion; one it refuses (an
    export still in progress) stays. ``untouched_only`` keeps the sessions
    the athlete edited (moved, adjusted, re-statused: ``revision > 1``), an
    edit committed meanwhile included: each deletion expects revision 1, and
    a concurrent edit makes it conflict instead of being lost (ARE-150)."""
    edited = " AND revision = 1" if untouched_only else ""
    con = connect()
    try:
        ids = [
            r[0]
            for r in con.execute(
                "SELECT id FROM app.visible_planned_sessions WHERE goal_id = ? AND status = 'pending' AND date >= ?"
                + edited
                + " ORDER BY id",
                [goal_id, start],
            ).fetchall()
        ]
    finally:
        con.close()
    repo, deleted = GarminRepository(), 0
    for session_id in ids:
        try:
            deleted += bool(
                repo.delete_planned_session(
                    session_id, expected_revision=1 if untouched_only else None
                )
            )
        except (ValueError, duckdb.TransactionException):
            continue  # an export in progress, or the athlete's edit won
    return deleted


def apply(goal_id: int, today: date | None = None) -> dict[str, Any]:
    """Write the goal's plan, replacing its own future sessions still to do
    that the athlete left untouched; those they edited stay, and a Hyrox or
    hybrid plan is placed around them.

    A narrow race remains: a session edited after the plan read the kept
    sessions and before ``_delete_future`` is kept by the revision guard but
    was planned around as untouched. Its day is still taken, so no generated
    session lands on it; only the rules did not see its new content.
    """
    goal = _goal_or_raise(goal_id)
    plan = _generate(goal, today)
    replaced = _delete_future(goal.id, plan.start, untouched_only=True)
    con = connect()
    try:
        taken = {
            r[0]
            for r in con.execute(
                "SELECT DISTINCT date FROM app.visible_planned_sessions WHERE date BETWEEN ? AND ? AND status <> 'skipped'",
                [plan.start, goal.race_date],
            ).fetchall()
        }
    finally:
        con.close()
    repo = GarminRepository()
    created, skipped = 0, []
    for week in plan.weeks:
        for draft in week.sessions:
            if KEPT in draft.tags:
                continue  # already there: the athlete's edit
            if draft.date in taken:
                skipped.append(draft.date.isoformat())
                continue
            repo.create_planned_session(
                PlannedSession(
                    date=draft.date,
                    sport=draft.sport,
                    session_type=SessionType(draft.session_type),
                    target_duration_min=draft.duration_min,
                    target_distance_km=draft.distance_km,
                    target_hr_zone=draft.hr_zone,
                    target_intensity=draft.intensity,
                    description=draft.description,
                    prescription=Prescription.model_validate(
                        draft.prescription
                    ).model_dump(mode="json")
                    if draft.prescription is not None
                    else None,
                    source="plan",
                    status=SessionStatus.PENDING,
                    goal_id=goal.id,
                    plan_kind=kind_of(draft.tags) if draft.tags else None,
                )
            )
            created += 1
    return {
        "created": created,
        "replaced": replaced,
        "skipped_days": skipped,  # another planned session was already there
        "weeks": len(plan.weeks),
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
#: A Hyrox without a target time: its 8 km of running are not the race.
HYROX_FALLBACK_MIN = 90


def session_tss(session: PlannedSession, goal: Goal, minutes: float) -> float:
    """A planned session's load: a Hyrox or hybrid goal's own sessions weigh
    strength and station circuits by that plan's RPE, every other one as
    before (``PLANNED_RPE``). The table follows the goal being projected, not
    each session's own goal: another goal's sessions in the window, and
    manual ones, keep ``PLANNED_RPE`` even when that goal is a Hyrox."""
    hybrid = goal.goal_type != "race" and session.goal_id == goal.id
    table = HYBRID_PLANNED_RPE if hybrid else PLANNED_RPE
    return planned_tss(session.session_type.value, minutes, table)


def _race_minutes(goal: Goal, con=None) -> float:
    from arete.features.running import race_time_sec
    from arete.services.metrics import current_vdot

    if goal.target_time_sec:
        return goal.target_time_sec / 60
    if goal.goal_type == "hyrox":
        return HYROX_FALLBACK_MIN
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
        future[s.date] = future.get(s.date, 0.0) + session_tss(s, goal, minutes)

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
        # Today's form is the logged one, as on the dashboard and
        # /metrics/fitness; today's plan weighs from tomorrow on. The point
        # keeps its planned load: Planning still marks today as a planned day.
        logged = fitness_series(history, today)
        _, ctl, atl = logged[-1] if logged else (None, 0.0, 0.0)
        shown = [
            _point(today, ctl, atl, future[today], planned=True)
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
