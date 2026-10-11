"""Coaching cards: authoritative reads and revision-checked athlete responses."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from arete.services import coach_followup, coach_today, plan_adaptation

router = APIRouter(prefix="/coach", tags=["coach"])


class ProposalResponse(BaseModel):
    revision: int = Field(ge=1)
    action: Literal["apply", "keep", "snooze"]


class FollowupResponse(BaseModel):
    revision: int = Field(ge=1)
    action: Literal["answer", "skip", "snooze"]
    rpe: int | None = Field(default=None, ge=1, le=10, strict=True)
    notes: str | None = Field(default=None, max_length=coach_followup.MAX_NOTE_CHARS)


def _call(operation):
    try:
        return operation()
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/today")
def today():
    return coach_today.today()


@router.post("/prepare")
def prepare():
    coach_today.prepare()
    return coach_today.today()


@router.post("/proposals/{decision_id}/response")
def proposal_response(decision_id: int, body: ProposalResponse):
    return _call(
        lambda: plan_adaptation.respond(
            decision_id, body.revision, body.action
        ).to_dict()
    )


@router.get("/followups/{followup_id}")
def get_followup(followup_id: int):
    result = coach_followup.get(followup_id)
    if result is None:
        raise HTTPException(404, "Suivi introuvable")
    return result


@router.post("/followups/{followup_id}/response")
def followup_response(followup_id: int, body: FollowupResponse):
    return _call(lambda: coach_followup.respond(followup_id, **body.model_dump()))
