"""HTTP coaching cards: domain evidence plus optional model enrichment."""

import logging
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from arete.services import coaching_rules as rules
from arete.services.coaching_repository import (
    Briefing,
    BriefingRepository,
    SessionFeedbackRepository,
)
from arete.services.coaching_rules import PostSessionResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tips", tags=["tips"])


class DailyTipResponse(BaseModel):
    """Daily tip response: the day's briefing, or that it is being written.

    ``pending`` carries no tip; ``ready`` keeps every field older clients read.
    """

    status: Literal["ready", "pending"] = Field(
        default="ready", description="Whether the day's briefing is written yet"
    )
    tip: str | None = Field(
        default=None, description="Contextual training tip in French"
    )
    priority: Literal["info", "warning", "alert"] | None = Field(
        default=None, description="Tip priority level"
    )
    source: Literal["agent", "rules"] | None = Field(
        default=None,
        description="Whether the coaching agent wrote it, or the rule engine did",
    )
    generated_at: str | None = Field(
        default=None, description="ISO 8601 generation timestamp"
    )
    updated_after_sync: bool = Field(
        default=False,
        description="The daily sync rewrote a briefing written before its data",
    )


def _daily_tip(briefing: Briefing | None) -> DailyTipResponse:
    if briefing is None:
        return DailyTipResponse(status="pending")
    return DailyTipResponse(
        tip=briefing.text,
        priority=briefing.priority,  # type: ignore[arg-type]
        source=briefing.source,  # type: ignore[arg-type]
        generated_at=(briefing.created_at or datetime.now(UTC)).isoformat(),
        updated_after_sync=briefing.revised and briefing.trigger == "scheduler",
    )


class PostSessionRequest(BaseModel):
    """Request body for post-session feedback."""

    session_type: Literal["strength", "cardio"]
    session_id: int


@router.get("/daily", response_model=DailyTipResponse)
def get_daily_tip() -> DailyTipResponse:
    """The stored briefing, or ``pending``: reading never runs the model."""
    return _daily_tip(BriefingRepository().get_for_day())


@router.post("/daily", response_model=DailyTipResponse)
def write_daily_tip() -> DailyTipResponse:
    """Write the day's briefing if it has none, once per athlete and day.

    The dashboard sends this long request without waiting on it and polls the
    GET. ``pending`` when another request or instance is writing it. Importing
    the agent stack (``arete.coaching``) costs a second on a cold instance,
    hence the stored briefing first.
    """
    briefing = BriefingRepository().get_for_day()
    if briefing is None:
        from arete import coaching

        briefing = coaching.get_or_create_briefing(trigger="api")
    return _daily_tip(briefing)


@router.post("/post-session", response_model=PostSessionResponse)
def post_session_feedback(body: PostSessionRequest) -> PostSessionResponse:
    try:
        result, evidence = (
            rules._generate_strength_feedback(body.session_id)
            if body.session_type == "strength"
            else rules._generate_cardio_feedback(body.session_id)
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    from arete import coaching

    feedback, source = coaching.enrich_session_feedback(
        result.feedback, result.highlights, evidence
    )
    if body.session_type == "cardio":
        # Kept for the session page; the card under the upload shows it now.
        try:
            SessionFeedbackRepository().save(
                body.session_id, text=feedback, source=source, trigger="api"
            )
        except Exception:
            logger.warning("Could not store the session feedback", exc_info=True)
    return PostSessionResponse(
        feedback=feedback, highlights=result.highlights, source=source
    )
