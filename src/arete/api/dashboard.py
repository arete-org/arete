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
        briefing=_daily_tip(board.briefing),
        coach=board.coach,
    )
