"""HTTP contract for goal races; services own validation and storage."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from arete.services import goals as service
from arete.services.settings import athlete_today

router = APIRouter(prefix="/goals", tags=["goals"])


class GoalCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    race_date: date  # a hybrid block's last day
    #: Required for a race; Hyrox is 8 km, a hybrid block has none.
    distance_km: float | None = Field(default=None, ge=1, le=250)
    target_time_sec: int | None = Field(default=None, gt=0)
    priority: Literal["A", "B", "C"] = "A"
    goal_type: Literal["race", "hyrox", "hybrid"] = "race"
    #: Hyrox/hybrid: division, format, category, equipment, weeks
    #: (``services.goals.GoalDetails``, validated there in French).
    details: dict[str, Any] | None = None


class GoalUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    race_date: date | None = None
    distance_km: float | None = Field(default=None, ge=1, le=250)
    target_time_sec: int | None = Field(default=None, gt=0)
    priority: Literal["A", "B", "C"] | None = None
    status: Literal["active", "done", "cancelled"] | None = None
    details: dict[str, Any] | None = None


def _found(goal: service.Goal | None) -> dict[str, Any]:
    if goal is None:
        raise HTTPException(status_code=404, detail="Objectif introuvable")
    return goal.to_dict()


@router.get("")
def list_goals(include_past: bool = False) -> list[dict[str, Any]]:
    # The athlete's settings once, not once per goal.
    today = athlete_today()
    goals = service.list_goals(include_past=include_past, today=today)
    return [g.to_dict(today) for g in goals]


@router.get("/next")
def next_goal() -> dict[str, Any] | None:
    today = athlete_today()
    goal = service.next_goal(today)
    return goal.to_dict(today) if goal else None


@router.post("", status_code=201)
def create_goal(body: GoalCreate) -> dict[str, Any]:
    today = athlete_today()
    if body.race_date < today:
        raise HTTPException(
            status_code=422,
            detail="La fin du bloc est passée"
            if body.goal_type == "hybrid"
            else "La date de course est passée",
        )
    try:
        return service.create_goal(**body.model_dump(), today=today).to_dict(today)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.patch("/{goal_id}")
def update_goal(goal_id: int, body: GoalUpdate) -> dict[str, Any]:
    try:
        goal = service.update_goal(goal_id, **body.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    return _found(goal)


@router.delete("/{goal_id}")
def delete_goal(goal_id: int) -> dict[str, int]:
    """``kept``: its future sessions already changed, which stay."""
    kept = service.delete_goal(goal_id)
    if kept is None:
        raise HTTPException(status_code=404, detail="Objectif introuvable")
    return {"kept": kept}


@router.post("/{goal_id}/plan/preview")
def preview_plan(goal_id: int) -> dict[str, Any]:
    """The weeks the plan would hold, without writing anything."""
    from arete.features.plan_generator import PlanError
    from arete.services import plan_builder

    try:
        return plan_builder.preview(goal_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Objectif introuvable") from None
    except PlanError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.post("/{goal_id}/plan")
def write_plan(goal_id: int) -> dict[str, Any]:
    """Write the plan; replaces only this goal's future sessions still to do
    that the athlete left untouched."""
    from arete.features.plan_generator import PlanError
    from arete.services import plan_builder

    try:
        return plan_builder.apply(goal_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Objectif introuvable") from None
    except PlanError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.delete("/{goal_id}/plan")
def remove_plan(goal_id: int) -> dict[str, Any]:
    from arete.services import plan_builder

    try:
        # The future sessions already changed stay: ``kept`` counts them.
        return plan_builder.remove(goal_id)._asdict()
    except LookupError:
        raise HTTPException(status_code=404, detail="Objectif introuvable") from None


@router.get("/{goal_id}/projection")
def get_projection(goal_id: int) -> dict[str, Any]:
    """CTL / ATL / TSB until race day, from the history and the planned sessions."""
    from arete.services import plan_builder

    try:
        return plan_builder.projection(goal_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Objectif introuvable") from None
