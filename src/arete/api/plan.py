"""HTTP contract for the day's plan decisions; services own the rules."""

from __future__ import annotations

from datetime import date
from datetime import date as date_type
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from arete.services import plan_adaptation as service
from arete.services.plan_repository import PlanDecisionRepository
from arete.services.settings import athlete_today

router = APIRouter(prefix="/plan", tags=["plan"])


def _today(decisions: list, day: date) -> dict[str, Any]:
    return {
        "date": day.isoformat(),
        "decisions": [d.to_dict() for d in decisions],
    }


@router.get("/today")
def get_today() -> dict[str, Any]:
    """What this morning's readiness did to today's plan."""
    day = athlete_today()
    return _today(PlanDecisionRepository().list_for_day(day), day)


@router.post("/today/adapt")
def adapt_today() -> dict[str, Any]:
    """Decide now for today's sessions without a decision (ignores the switch)."""
    raise HTTPException(
        409,
        "L’adaptation nécessite maintenant une proposition à valider. Recharge l’application.",
    )


@router.post("/decisions/{decision_id}/revert")
def revert_decision(decision_id: int) -> dict[str, Any]:
    """Restore the planned session as it was before the decision."""
    try:
        return service.revert(decision_id).to_dict()
    except LookupError:
        raise HTTPException(status_code=404, detail="Décision introuvable") from None
    except service.NothingToRevert:
        raise HTTPException(
            status_code=409, detail="Rien à rétablir pour cette décision"
        ) from None


class ReviewApply(BaseModel):
    indices: list[int]


@router.get("/review")
def get_review() -> dict[str, Any] | None:
    """The current review, if it was written (on Sunday, the week ending)."""
    from arete.services.weekly_review import current_review

    review = current_review(athlete_today())
    return review.to_dict() if review else None


@router.get("/review/week")
def get_review_week() -> dict[str, Any]:
    """« Ma semaine »: the current review and its week in numbers, read now."""
    from arete.services.weekly_review import current_review, recap

    today = athlete_today()
    review = current_review(today)
    return {
        "today": today.isoformat(),
        "review": review.to_dict() if review else None,
        "recap": recap(review, today) if review else None,
    }


@router.post("/review")
def write_review(refresh: bool = False) -> dict[str, Any]:
    """Write the week's review (once; ``refresh`` writes it again)."""
    from arete import coaching
    from arete.services.weekly_review import ReviewInProgress

    try:
        return coaching.generate_weekly_review(refresh=refresh).to_dict()
    except ReviewInProgress:
        raise HTTPException(
            status_code=409,
            detail="Le coach écrit déjà ce bilan : réessaie dans quelques minutes.",
        ) from None


@router.post("/review/{review_id}/apply")
def apply_review(review_id: int, body: ReviewApply) -> dict[str, Any]:
    """Apply the chosen proposals; ones whose session changed come back stale."""
    from arete.services.weekly_review import apply_review

    try:
        return apply_review(review_id, body.indices)
    except LookupError:
        raise HTTPException(status_code=404, detail="Bilan introuvable") from None


class GarminWeekSession(BaseModel):
    planned_session_id: int
    date: date_type
    session_type: str
    outcome: Literal["sent", "already", "withdrawn", "skipped", "failed", "not_started"]


class GarminWeekPush(BaseModel):
    state: Literal["done", "disabled", "disconnected", "failed"] = Field(
        description="Whether the push ran; each session's outcome otherwise"
    )
    sessions: list[GarminWeekSession]


class ReviewAccepted(BaseModel):
    applied: list[int]
    stale: list[int] = Field(description="Proposals whose session changed since")
    garmin: GarminWeekPush
    calendar: str = Field(
        description="Training plan calendar sync: synced, partial, busy, failed, disabled"
    )


@router.post("/review/{review_id}/accept", response_model=ReviewAccepted)
def accept_review(review_id: int, body: ReviewApply) -> dict[str, Any]:
    """« Accepter »: the chosen proposals, then the week's key sessions on
    Garmin and the plan's calendar, each outcome reported. The plan stays
    written whatever the watch or the calendar answer."""
    from arete.calendar import sync_training_plan
    from arete.services.calendar_plan import AFTER_PLAN_WRITE
    from arete.services.weekly_review import accept

    try:
        return accept(
            review_id,
            body.indices,
            follow_calendar=lambda: sync_training_plan(AFTER_PLAN_WRITE),
        )
    except LookupError:
        raise HTTPException(status_code=404, detail="Bilan introuvable") from None
