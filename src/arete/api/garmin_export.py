"""Explicit human actions for outbound workouts; no model invocation."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from arete.services import garmin_export
from arete.services.prescriptions import Prescription

router = APIRouter(prefix="/garmin", tags=["workout export"])


@router.get("/workout-devices")
def devices():
    return garmin_export.devices()


@router.get("/exports")
def statuses():
    return garmin_export.statuses()


class ExportIn(BaseModel):
    device_id: int | None = Field(default=None, gt=0)


@router.post("/planned/{session_id}/export")
def export(session_id: int, body: ExportIn):
    return garmin_export.export(session_id, body.device_id)


@router.post("/exports/{session_id}/reconcile")
def reconcile(session_id: int):
    return garmin_export.reconcile(session_id)


@router.post("/exports/{session_id}/remove")
def remove(session_id: int):
    return garmin_export.remove(session_id)


class PrescriptionUpdate(BaseModel):
    revision: int = Field(ge=1)
    date: date
    description: str = Field(min_length=1, max_length=500)
    prescription: Prescription


@router.put("/planned/{session_id}/prescription")
def update(session_id: int, body: PrescriptionUpdate):
    garmin_export.update_session(
        session_id, body.revision, body.date, body.description, body.prescription
    )
    return {"updated": True}


@router.get("/workout-exercises")
def exercises():
    from garminconnect.exercises import EXERCISES

    assert len(EXERCISES) <= 2000
    return EXERCISES


@router.get("/planned/{session_id}/workout")
def inspect_workout(session_id: int):
    return garmin_export.inspect_session(session_id)


@router.get("/workouts")
def inspect_workouts(
    ids: Annotated[
        list[Annotated[int, Field(gt=0)]],
        Query(min_length=1, max_length=garmin_export.MAX_INSPECT_SESSIONS),
    ],
):
    """The cards of a conversation or a week in one request (`?ids=1&ids=2`)."""
    return garmin_export.inspect_sessions(ids)


class BatchExportIn(BaseModel):
    session_ids: list[int] = Field(min_length=1, max_length=5)
    revisions: list[int] = Field(min_length=1, max_length=5)
    device_id: int | None = Field(default=None, gt=0)


@router.post("/exports/batch")
def export_batch(body: BatchExportIn):
    return garmin_export.export_batch(
        body.session_ids, body.device_id, revisions=body.revisions
    )
