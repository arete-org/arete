"""The dashboard's reads, on one connection and with one fitness model.

Each slice keeps its owner (the repositories, ``metrics``, ``coach_today``…):
this module only reads them on a shared connection, for the athlete's day as
the settings define it, so one request replaces the page's former burst.
Reads only: no Garmin request, no model call, no write.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from arete.dataio.db import db_connection
from arete.dataio.queries import daily_health, daily_loads
from arete.dataio.settings import get_user_settings
from arete.garmin import token_store
from arete.garmin.models import ActualSession, PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import coach_today, goals, metrics
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.coaching_repository import Briefing, BriefingRepository
from arete.services.plan_repository import PlanDecision, PlanDecisionRepository
from arete.services.settings import today_in
from arete.strength.models import StrengthSessionSummary
from arete.strength.repository import StrengthRepository

#: The bounds of the individual reads the dashboard used to make.
SESSION_LIMIT = 500
STRENGTH_LIMIT = 200
WORKLOAD_DAYS = 28
FITNESS_DAYS = 42


@dataclass(frozen=True)
class Dashboard:
    """Everything the dashboard shows for ``date``, the athlete's today."""

    date: date
    planned: list[PlannedSession]
    actual: list[ActualSession]
    strength: list[StrengthSessionSummary]
    decisions: list[PlanDecision]
    next_goal: goals.Goal | None
    player_stats: metrics.PlayerStats
    fitness: metrics.FitnessMetricsOut
    workload: metrics.WorkloadMetricsOut
    health: dict[str, Any] | None
    garmin_connected: bool
    #: Any load ever logged: the form curve has something to draw (the model's
    #: rounded numbers can read 0 after months off).
    has_load: bool
    briefing: Briefing | None
    coach: dict[str, Any]


def load() -> Dashboard:
    """Read the dashboard; the load history is read and modelled once."""
    garmin, strength = GarminRepository(), StrengthRepository()
    with db_connection() as con:
        settings = get_user_settings(user_id=resolve_athlete_id(), con=con) or {}
        today = today_in(settings.get("timezone"))
        form = metrics.read_form(con, today)
        decisions = PlanDecisionRepository().list_for_day(today, con=con)
        briefing = BriefingRepository().get_for_day(today, con=con)
        return Dashboard(
            date=today,
            planned=garmin.list_planned_sessions(
                start_date=today, end_date=today, limit=SESSION_LIMIT, connection=con
            ),
            actual=garmin.list_actual_sessions(
                start_date=today,
                end_date=today,
                limit=SESSION_LIMIT,
                include_blobs=False,
                connection=con,
            ),
            strength=strength.list_session_summaries(
                start_date=today, end_date=today, limit=STRENGTH_LIMIT, connection=con
            ),
            decisions=decisions,
            next_goal=goals.next_goal(today, con),
            player_stats=metrics.player_stats(settings, today, form),
            fitness=metrics.fitness_metrics(today, form, FITNESS_DAYS),
            workload=metrics.workload_metrics(
                daily_loads(con, today - timedelta(days=WORKLOAD_DAYS), today), today
            ),
            health=daily_health(con, today),
            garmin_connected=token_store.session_status(con)[0],
            has_load=form.model is not None,
            briefing=briefing,
            coach=coach_today.card(con, today, decisions, briefing),
        )


#: The form curve's history: twelve weeks, as the athlete reads a block.
CURVE_HISTORY_DAYS = 84
#: The goal card's next key session is the hardest planned in this window.
KEY_SESSION_DAYS = 7


def _history_points(by_date: dict[date, float], today: date) -> list[dict[str, Any]]:
    """Twelve weeks up to today from the logged load only: today's point is the
    dashboard's form, whatever today's plan."""
    since = today - timedelta(days=CURVE_HISTORY_DAYS)
    return [
        {
            "date": day.date.isoformat(),
            "ctl": round(ctl, 1),
            "atl": round(atl, 1),
            "tsb": round(ctl - atl, 1),
            "planned": False,
        }
        for day, ctl, atl in metrics.fitness_series(by_date, today)
        if day.date >= since
    ]


def form_curve() -> dict[str, Any]:
    """The dashboard's form curve, read on its own after the page (lazy).

    Twelve weeks of fitness, fatigue and form and, with a race ahead, their
    projection to race day from the planned sessions (``plan_builder.project``),
    the race-morning form, how far the plan reaches and the next key session
    for the goal card. One connection; reads only.
    """
    from arete.dataio.queries import daily_tss_by_date
    from arete.features.plan_generator import planned_tss
    from arete.services import plan_builder

    with db_connection() as con:
        settings = get_user_settings(user_id=resolve_athlete_id(), con=con) or {}
        today = today_in(settings.get("timezone"))
        goal = goals.next_goal(today, con)
        if goal is None:
            by_date = {d: t for d, t in daily_tss_by_date(con).items() if d <= today}
            return {
                "today": today.isoformat(),
                "goal_id": None,
                "series": _history_points(by_date, today),
                "race_day": None,
                "planned_sessions": 0,
                "last_planned": None,
                "key_session": None,
            }
        projected = plan_builder.project(goal, today, con, CURVE_HISTORY_DAYS)
    answer = projected.answer
    # Up to today the logged load only; after it the projection, which still
    # counts today's plan when nothing is logged yet.
    future = [p for p in answer["series"] if p["date"] > today.isoformat()]
    training = [
        s.date
        for s in projected.planned
        if not (s.session_type == SessionType.RACE and s.date == goal.race_date)
    ]
    week_end = min(today + timedelta(days=KEY_SESSION_DAYS - 1), goal.race_date)
    week = [s for s in projected.planned if s.date <= week_end]
    # The hardest of the week: the planned load weighs duration and intensity.
    key = max(
        week,
        key=lambda s: planned_tss(
            s.session_type.value, float(s.target_duration_min or 0)
        ),
        default=None,
    )
    return {
        "today": today.isoformat(),
        "goal_id": goal.id,
        "series": _history_points(projected.history, today)
        + [{k: p[k] for k in ("date", "ctl", "atl", "tsb", "planned")} for p in future],
        "race_day": answer["race_day"],
        "planned_sessions": answer["planned_sessions"],
        # The projection assumes rest after the last planned session.
        # The race itself is no training: a planned race alone reaches nothing.
        "last_planned": max(training).isoformat() if training else None,
        "key_session": None
        if key is None
        else {
            "id": key.id,
            "date": key.date.isoformat(),
            "session_type": key.session_type.value,
            "description": key.description,
            "target_duration_min": key.target_duration_min,
        },
    }
