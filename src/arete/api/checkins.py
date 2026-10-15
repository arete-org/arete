"""HTTP contract for the morning check-in; ``services/checkins.py`` owns it."""

from __future__ import annotations

from datetime import date as date_type
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from arete.services import checkins

router = APIRouter(prefix="/checkins", tags=["checkins"])


class CheckinAnswer(BaseModel):
    sleep: int = Field(ge=1, le=5, strict=True, description="Sommeil, 1 = très mauvais")
    legs: int = Field(ge=1, le=5, strict=True, description="Jambes, 1 = très lourdes")
    mood: int | None = Field(
        default=None, ge=1, le=5, strict=True, description="Motivation / stress"
    )
    note: str | None = Field(default=None, max_length=checkins.MAX_NOTE_CHARS)


class CheckinResponse(BaseModel):
    date: date_type
    sleep: int
    legs: int
    mood: int | None
    note: str | None
    answered_at: datetime = Field(description="The first answer, UTC")
    updated_at: datetime = Field(description="The last correction, UTC")


class CheckinSaved(CheckinResponse):
    replanned: bool = Field(
        description="A low answer after the day's run asked its decision again"
    )


@router.get("", response_model=list[CheckinResponse])
def list_checkins(days: int = Query(default=14, ge=1, le=checkins.MAX_DAYS)):
    """The answered check-ins of the last ``days`` days, newest first."""
    return [c.to_dict() for c in checkins.recent(days)]


@router.put("/{day}", response_model=CheckinSaved)
def put_checkin(day: date_type, body: CheckinAnswer):
    """The day's answer; sending it again replaces it."""
    try:
        saved = checkins.save(day, **body.model_dump())
    except checkins.CheckinError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {**saved.to_dict(), "replanned": checkins.replan(saved)}
