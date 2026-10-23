"""Coaching cards: authoritative reads and revision-checked athlete responses."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from arete.services import (
    coach_followup,
    coach_today,
    evening_message,
    plan_adaptation,
    planning,
)

router = APIRouter(prefix="/coach", tags=["coach"])


class SeenRevision(BaseModel):
    id: int = Field(ge=1)
    revision: int = Field(ge=1)


class ProposalResponse(BaseModel):
    revision: int = Field(ge=1)
    action: Literal["apply", "keep", "snooze"]
    #: The day's other proposals, answered together with this one.
    group: list[SeenRevision] = Field(default_factory=list, max_length=10)


class FollowupResponse(BaseModel):
    revision: int = Field(ge=1)
    action: Literal["answer", "skip", "snooze"]
    rpe: int | None = Field(default=None, ge=1, le=10, strict=True)
    notes: str | None = Field(default=None, max_length=coach_followup.MAX_NOTE_CHARS)


class EveningAnswer(BaseModel):
    text: str = Field(min_length=1, max_length=evening_message.MAX_ANSWER_CHARS)


class ChangeSetResponse(BaseModel):
    revision: int = Field(ge=1)
    operation_id: UUID


@router.post("/plan-changes")
def preview_changes(body: planning.PlanChangeSet):
    return _call(lambda: planning.preview_plan_changes(body))


@router.get("/plan-changes/{identifier}")
def read_changes(identifier: UUID):
    return _call(lambda: planning.get_plan_changes(str(identifier)))


@router.post("/plan-changes/{identifier}/apply")
def apply_changes(identifier: UUID, body: ChangeSetResponse):
    return _call(
        lambda: planning.apply_plan_changes(
            str(identifier), body.revision, str(body.operation_id)
        )
    )


@router.post("/plan-changes/{identifier}/dismiss")
def dismiss_changes(identifier: UUID, body: ChangeSetResponse):
    return _call(lambda: planning.dismiss_plan_changes(str(identifier), body.revision))


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


@router.get("/attention")
def attention():
    from arete.services import coaching_attention

    return _call(coaching_attention.projection)


@router.post("/prepare")
def prepare():
    coach_today.prepare()
    return coach_today.today()


@router.post("/proposals/{decision_id}/response")
def proposal_response(decision_id: int, body: ProposalResponse):
    """The day's proposals answered together; ``garmin`` is what Garmin did
    for this proposal's session after an applied answer, reported apart."""

    def answer():
        decision, garmin = plan_adaptation.respond_reporting(
            decision_id,
            body.revision,
            body.action,
            {seen.id: seen.revision for seen in body.group},
        )
        return {**decision.to_dict(), "garmin": garmin}

    return _call(answer)


@router.get("/followups/{followup_id}")
def get_followup(followup_id: int):
    result = coach_followup.get(followup_id)
    if result is None:
        raise HTTPException(404, "Suivi introuvable")
    return result


@router.post("/followups/{followup_id}/response")
def followup_response(followup_id: int, body: FollowupResponse):
    return _call(lambda: coach_followup.respond(followup_id, **body.model_dump()))


@router.get("/evening/{message_id}")
def get_evening(message_id: int):
    """The coach's evening message, read without any model request."""
    # A failed filing of the answer is retried here, once (``read``).
    message = evening_message.read(message_id)
    if message is None:
        raise HTTPException(404, "Message du soir introuvable")
    return evening_message.present(message)


@router.post("/evening/{message_id}/answer")
def answer_evening(message_id: int, body: EveningAnswer):
    """The athlete's answer, kept once and filed once in the journal; no model
    request. ``journal`` reports the filing apart from the saved answer."""
    return _call(lambda: evening_message.answer(message_id, body.text))
