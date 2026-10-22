"""HTTP contract for pain, body weight and the physio report.

``services/body_log.py`` owns the entries and their trend,
``services/body_report.py`` the report. Behind the consent gate like every
route outside ``/auth`` and ``/export``.
"""

from __future__ import annotations

from datetime import date as date_type
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from arete.services import body_log, body_report

router = APIRouter(prefix="/body", tags=["body"])

PainArea = Literal[tuple(body_log.PAIN_AREAS)]  # type: ignore[valid-type]
Side = Literal["left", "right", "both"]


class PainInput(BaseModel):
    date: date_type
    area: PainArea  # type: ignore[valid-type]
    side: Side | None = None
    intensity: int = Field(
        ge=0, le=10, strict=True, description="0 aucune, 10 maximale"
    )
    note: str | None = Field(default=None, max_length=body_log.MAX_NOTE_CHARS)


class PainResponse(BaseModel):
    id: int
    date: date_type
    area: str
    side: str | None
    intensity: int
    note: str | None
    label: str = Field(description="The area and side, in French")
    created_at: datetime = Field(description="UTC")
    updated_at: datetime = Field(description="UTC")


class WeightInput(BaseModel):
    weight_kg: float = Field(
        ge=body_log.MIN_WEIGHT_KG, le=body_log.MAX_WEIGHT_KG, strict=True
    )


class WeightResponse(BaseModel):
    date: date_type
    weight_kg: float
    source: str
    created_at: datetime = Field(description="UTC")
    updated_at: datetime = Field(description="UTC")


class WeightSummary(BaseModel):
    latest: WeightResponse | None
    average_7d: float | None
    change_kg: float | None = Field(
        description="The latest weight minus the earliest of the 28 days before it"
    )
    change_since: date_type | None


class AreaTrend(BaseModel):
    area: str
    side: str | None
    label: str
    last_date: date_type
    last_intensity: int
    max_intensity: int
    entries: int


class BodyTrend(BaseModel):
    start: date_type
    end: date_type
    pain: list[PainResponse] = Field(description="Newest first")
    weights: list[WeightResponse] = Field(description="Oldest first")
    weight: WeightSummary
    areas: list[AreaTrend] = Field(description="The most recently hurt first")


class ReportWeek(BaseModel):
    week_start: date_type
    week_end: date_type
    sessions: int
    duration_min: int
    distance_km: float
    tss: int
    acwr: float | None


class ReportSession(BaseModel):
    date: date_type
    kind: Literal["cardio", "strength"]
    sport: str
    name: str | None
    duration_min: int
    distance_km: float | None
    avg_hr: int | None
    rpe: int | None
    tss: int


class ReportReadiness(BaseModel):
    date: date_type
    garmin_readiness: int | None
    readiness: int | None
    sleep_score: int | None
    resting_hr: int | None
    hrv: int | None


class ReportCheckin(BaseModel):
    date: date_type
    sleep: int | None
    legs: int | None
    mood: int | None


class ReportTotals(BaseModel):
    sessions: int
    duration_min: int
    pain_entries: int
    max_pain: int | None


class BodyReport(BaseModel):
    start: date_type
    end: date_type
    weeks: list[ReportWeek]
    sessions: list[ReportSession]
    pain: list[PainResponse] = Field(description="Oldest first")
    pain_areas: list[AreaTrend]
    weights: list[WeightResponse]
    weight: WeightSummary
    readiness: list[ReportReadiness]
    checkins: list[ReportCheckin]
    totals: ReportTotals


def _refused(exc: body_log.BodyLogError) -> HTTPException:
    return HTTPException(422, str(exc))


@router.get("", response_model=BodyTrend)
def get_trend(days: int = Query(default=56, ge=1, le=body_log.MAX_WINDOW_DAYS)):
    """The window's pain and weights, the weight's trend and each area's."""
    return body_log.trend(days)


@router.post("/pain", response_model=PainResponse, status_code=201)
def add_pain(body: PainInput):
    try:
        return body_log.add_pain(
            body.date,
            area=body.area,
            side=body.side,
            intensity=body.intensity,
            note=body.note,
        ).to_dict()
    except body_log.BodyLogError as exc:
        raise _refused(exc) from exc


@router.put("/pain/{entry_id}", response_model=PainResponse)
def update_pain(entry_id: int, body: PainInput):
    try:
        return body_log.update_pain(
            entry_id,
            body.date,
            area=body.area,
            side=body.side,
            intensity=body.intensity,
            note=body.note,
        ).to_dict()
    except body_log.BodyLogError as exc:
        raise _refused(exc) from exc
    except LookupError:
        raise HTTPException(404, "Douleur introuvable.") from None


@router.delete("/pain/{entry_id}", status_code=204)
def delete_pain(entry_id: int) -> Response:
    try:
        body_log.delete_pain(entry_id)
    except LookupError:
        raise HTTPException(404, "Douleur introuvable.") from None
    return Response(status_code=204)


@router.put("/weight/{day}", response_model=WeightResponse)
def put_weight(day: date_type, body: WeightInput):
    """The day's weight; sending it again replaces it."""
    try:
        return body_log.save_weight(day, body.weight_kg).to_dict()
    except body_log.BodyLogError as exc:
        raise _refused(exc) from exc


@router.delete("/weight/{day}", status_code=204)
def delete_weight(day: date_type) -> Response:
    try:
        body_log.delete_weight(day)
    except LookupError:
        raise HTTPException(404, "Aucun poids ce jour-là.") from None
    return Response(status_code=204)


@router.get("/report", response_model=BodyReport)
def get_report():
    """Eight calendar weeks for a physio or a sports doctor, printed by the browser."""
    return body_report.report()
