"""HTTP adapter for the dashboard: one read, each slice in its endpoint's shape.

Every field answers what its former endpoint answers for the athlete's day
(named in its description), so the browser can seed those queries from it.
"""

from __future__ import annotations

from datetime import date as date_type
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from arete.api.ai_tips import DailyTipResponse, _daily_tip
from arete.api.garmin import (
    ActualSessionResponse,
    PlannedSessionResponse,
    _actual_to_response,
    _planned_to_response,
)
from arete.api.garmin_health import DailyMetricsResponse, daily_metrics_response
from arete.api.plan import _today as plan_today
from arete.api.strength import StrengthSessionResponse, summary_to_response
from arete.services import dashboard as service
from arete.services.metrics import FitnessMetricsOut, PlayerStats, WorkloadMetricsOut

router = APIRouter(tags=["dashboard"])


class DashboardResponse(BaseModel):
    date: date_type = Field(description="The athlete's today, which every slice reads")
    planned: list[PlannedSessionResponse] = Field(description="/garmin/planned")
    actual: list[ActualSessionResponse] = Field(description="/garmin/actual")
    strength: list[StrengthSessionResponse] = Field(
        description="/strength/sessions, today's rows"
    )
    plan_today: dict[str, Any] = Field(description="/plan/today")
    next_goal: dict[str, Any] | None = Field(description="/goals/next")
    player_stats: PlayerStats = Field(description="/metrics/player-stats")
    fitness: FitnessMetricsOut = Field(description="/metrics/fitness")
    workload: WorkloadMetricsOut = Field(description="/metrics/workload")
    health: DailyMetricsResponse | None = Field(
        description="/garmin/health/daily; null where it answers 404"
    )
    garmin_connected: bool = Field(
        description="/garmin/sync/status garmin_authenticated"
    )
    has_load: bool = Field(description="Any load ever logged (the form curve's data)")
    briefing: DailyTipResponse = Field(description="GET /tips/daily")
    coach: dict[str, Any] = Field(description="/coach/today")


@router.get("/dashboard", response_model=DashboardResponse)
def get_dashboard() -> DashboardResponse:
    board = service.load()
    return DashboardResponse(
        date=board.date,
        planned=[_planned_to_response(s) for s in board.planned],
        actual=[_actual_to_response(s) for s in board.actual],
        strength=[summary_to_response(s) for s in board.strength],
        plan_today=plan_today(board.decisions, board.date),
        next_goal=board.next_goal.to_dict(board.date) if board.next_goal else None,
        player_stats=board.player_stats,
        fitness=board.fitness,
        workload=board.workload,
        health=daily_metrics_response(board.health) if board.health else None,
        garmin_connected=board.garmin_connected,
        has_load=board.has_load,
        briefing=_daily_tip(board.briefing),
        coach=board.coach,
    )


class CurvePoint(BaseModel):
    date: date_type
    ctl: float = Field(description="Forme de fond")
    atl: float = Field(description="Fatigue")
    tsb: float = Field(description="Forme")
    planned: bool = Field(description="The day's load comes from the plan")


class KeySession(BaseModel):
    id: int
    date: date_type
    session_type: str
    description: str | None
    target_duration_min: int | None


class FormCurveResponse(BaseModel):
    today: date_type
    goal_id: int | None = Field(description="The race the projection runs to")
    series: list[CurvePoint] = Field(
        description="Twelve weeks of history, then the projection to race day"
    )
    race_day: dict[str, float | None] | None = Field(
        description="Race-morning ctl and tsb, without a goal null"
    )
    planned_sessions: int = Field(description="Planned days the projection reads")
    last_planned: date_type | None = Field(
        description="The last planned session's day: the projection assumes rest after it"
    )
    key_session: KeySession | None = Field(
        description="The hardest session planned in the next seven days"
    )


@router.get("/dashboard/form-curve", response_model=FormCurveResponse)
def get_form_curve() -> dict[str, Any]:
    """The dashboard's form curve: its own request, read after the page."""
    return service.form_curve()
