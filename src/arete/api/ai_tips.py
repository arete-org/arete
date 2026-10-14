"""HTTP coaching cards: domain evidence plus optional model enrichment."""

import logging
from datetime import UTC, date, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from arete.services import coaching_rules as rules
from arete.services.coaching_repository import (
    Briefing,
    BriefingRepository,
    Reaction,
    SessionFeedbackRepository,
)
from arete.services.coaching_rules import PostSessionResponse
from arete.services.settings import athlete_today

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
    id: int | None = Field(default=None, description="The briefing, for a reaction")
    first_written_at: str | None = Field(
        default=None,
        description="When the day's first briefing was written, if this one replaced it",
    )
    reaction: Reaction | None = Field(default=None, description="The athlete's 👍/👎")
    reaction_comment: str | None = Field(default=None, description="Their word with it")


def _iso(at: datetime | None) -> str | None:
    """Stored timestamps are the server's naive local time: say which offset."""
    return at.astimezone().isoformat() if at else None


def _daily_tip(briefing: Briefing | None) -> DailyTipResponse:
    if briefing is None:
        return DailyTipResponse(status="pending")
    return DailyTipResponse(
        tip=briefing.text,
        priority=briefing.priority,  # type: ignore[arg-type]
        source=briefing.source,  # type: ignore[arg-type]
        generated_at=_iso(briefing.created_at) or datetime.now(UTC).isoformat(),
        updated_after_sync=briefing.revised and briefing.trigger == "scheduler",
        id=briefing.id,
        first_written_at=_iso(briefing.first_created_at) if briefing.revised else None,
        reaction=briefing.reaction,  # type: ignore[arg-type]
        reaction_comment=briefing.reaction_comment,
    )


#: A short word, not a conversation: that is the coach panel's job.
MAX_REACTION_COMMENT_CHARS = 280


class ReactionRequest(BaseModel):
    """``reaction`` None clears it; a comment always goes with a reaction."""

    reaction: Reaction | None
    comment: str | None = Field(default=None, max_length=MAX_REACTION_COMMENT_CHARS)

    @model_validator(mode="after")
    def comment_needs_a_reaction(self):
        self.comment = (self.comment or "").strip() or None
        if self.reaction is None and self.comment is not None:
            raise ValueError("Un commentaire accompagne une réaction.")
        return self


class ReactionResponse(BaseModel):
    id: int
    reaction: Reaction | None
    reaction_comment: str | None


class BriefingHistoryItem(BaseModel):
    id: int
    date: date
    tip: str
    source: Literal["agent", "rules"]
    generated_at: str | None
    reaction: Reaction | None
    reaction_comment: str | None


@router.get("/history", response_model=list[BriefingHistoryItem])
def get_briefing_history() -> list[BriefingHistoryItem]:
    """The athlete's previous days' briefings, newest first, at most seven."""
    return [
        BriefingHistoryItem(
            id=b.id,
            date=b.date,
            tip=b.text,
            source=b.source,  # type: ignore[arg-type]
            generated_at=_iso(b.created_at),
            reaction=b.reaction,  # type: ignore[arg-type]
            reaction_comment=b.reaction_comment,
        )
        for b in BriefingRepository().history(before=athlete_today())
    ]


@router.put("/briefings/{briefing_id}/reaction", response_model=ReactionResponse)
def react_to_briefing(briefing_id: int, body: ReactionRequest) -> ReactionResponse:
    """Idempotent: sending the same reaction again stores nothing new."""
    try:
        briefing = BriefingRepository().react(briefing_id, body.reaction, body.comment)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    return ReactionResponse(
        id=briefing.id,
        reaction=briefing.reaction,  # type: ignore[arg-type]
        reaction_comment=briefing.reaction_comment,
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
