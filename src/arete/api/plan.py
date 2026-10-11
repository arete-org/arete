"""HTTP contract for the day's plan decisions; services own the rules."""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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
    day = athlete_today()
    return _today(service.adapt_today(day, respect_setting=False), day)


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
    """Last week's review, if it was written."""
    from arete.services.weekly_review import get_review, last_monday

    review = get_review(last_monday(athlete_today()))
    return review.to_dict() if review else None


@router.post("/review")
def write_review(refresh: bool = False) -> dict[str, Any]:
    """Write last week's review (once; ``refresh`` writes it again)."""
    from arete import coaching

    return coaching.generate_weekly_review(refresh=refresh).to_dict()


@router.post("/review/{review_id}/apply")
def apply_review(review_id: int, body: ReviewApply) -> dict[str, Any]:
    """Apply the chosen proposals; ones whose session changed come back stale."""
    from arete.services.weekly_review import apply_review

    try:
        return apply_review(review_id, body.indices)
    except LookupError:
        raise HTTPException(status_code=404, detail="Bilan introuvable") from None
