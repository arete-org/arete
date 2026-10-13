"""Garmin pipeline API endpoints.

Endpoints for:
- Managing planned sessions
- Uploading FIT files
- Viewing session matching results
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from arete.dataio.settings import athlete_zone_model
from arete.garmin.fit_parser import FITParser, laps_to_json
from arete.garmin.matcher import SessionMatcher
from arete.garmin.models import (
    ActivitySource,
    ActualSession,
    PlannedSession,
    SessionStatus,
    SessionType,
    canonical_sport,
)
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import from_time_series
from arete.services.settings import athlete_today
from arete.strength.logging_service import link_garmin_strength

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/garmin", tags=["garmin"])

# Shared repository instance
_repo = GarminRepository()


# ─────────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────────


class PlannedSessionCreate(BaseModel):
    """Create a planned session."""

    date: date
    sport: str = "running"
    session_type: SessionType = SessionType.ENDURANCE
    target_duration_min: int | None = Field(None, ge=1, le=1440)
    target_distance_km: float | None = Field(None, gt=0, le=1000)
    target_hr_zone: str | None = Field(None, pattern=r"^Z[1-5]$")
    target_intensity: Literal["easy", "moderate", "hard"] | None = None
    description: str | None = Field(None, max_length=500)
    prescription: dict | None = None
    source: Literal["manual", "llm", "coach"] = "manual"


class PlannedSessionResponse(BaseModel):
    """Planned session response."""

    id: int
    date: date
    sport: str
    session_type: str
    target_duration_min: int | None
    target_distance_km: float | None
    target_hr_zone: str | None
    target_intensity: str | None
    description: str | None
    source: str
    status: str
    prescription: dict | None = None
    provenance: list[dict] | None = None
    revision: int = 1
    garmin_workout_id: str | None = None
    garmin_pushed_at: datetime | None = None


class ActualSessionResponse(BaseModel):
    """Actual session response (what was really done)."""

    id: int
    planned_session_id: int | None
    date: date
    start_time: datetime | None
    sport: str
    session_type: str | None
    name: str | None
    duration_sec: int
    duration_min: str  # Format: "MM:SS" (display)
    moving_time_sec: int | None
    distance_m: float | None
    distance_km: float | None  # Rounded to 2 decimals
    avg_hr: int | None
    max_hr: int | None
    avg_pace_sec_km: int | None
    avg_pace: str | None  # Format: "MM:SS" (display)
    ascent_m: float | None
    calories: int | None
    rpe: int | None
    notes: str | None
    source: str
    garmin_activity_id: str | None
    strava_activity_id: str | None
    adherence_score: float | None


class FITUploadResponse(BaseModel):
    """Response after uploading a FIT file."""

    activity_id: int
    activity: dict
    match: dict | None
    message: str


class MatchSummaryResponse(BaseModel):
    """Adherence statistics (see GarminRepository.get_matches_summary)."""

    total_planned: int
    total_actual: int
    total_matched: int
    total_unmatched: int
    adherence_rate: float
    planned_due: int = 0
    completed: int = 0
    skipped: int = 0
    window_start: str | None = None
    window_end: str | None = None


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────


def _planned_to_response(session: PlannedSession) -> PlannedSessionResponse:
    """Convert PlannedSession model to response."""
    return PlannedSessionResponse(
        id=session.id or 0,
        date=session.date,
        sport=session.sport,
        session_type=session.session_type.value
        if isinstance(session.session_type, SessionType)
        else session.session_type,
        target_duration_min=session.target_duration_min,
        target_distance_km=session.target_distance_km,
        target_hr_zone=session.target_hr_zone,
        target_intensity=session.target_intensity,
        description=session.description,
        source=session.source,
        prescription=session.prescription,
        provenance=session.provenance,
        revision=session.revision,
        status=session.status.value
        if isinstance(session.status, SessionStatus)
        else session.status,
        garmin_workout_id=session.garmin_workout_id,
        garmin_pushed_at=session.garmin_pushed_at,
    )


def _actual_to_response(session: ActualSession) -> ActualSessionResponse:
    """Convert ActualSession model to response."""
    return ActualSessionResponse(
        id=session.id or 0,
        planned_session_id=session.planned_session_id,
        date=session.date,
        start_time=session.start_time,
        sport=session.sport,
        session_type=session.session_type,
        name=session.name,
        duration_sec=session.duration_sec,
        duration_min=session.duration_min,
        moving_time_sec=session.moving_time_sec,
        distance_m=session.distance_m,
        distance_km=session.distance_km,
        avg_hr=session.avg_hr,
        max_hr=session.max_hr,
        avg_pace_sec_km=session.avg_pace_sec_km,
        avg_pace=session.avg_pace_min_km,
        ascent_m=session.ascent_m,
        calories=session.calories,
        rpe=session.rpe,
        notes=session.notes,
        source=session.source.value
        if isinstance(session.source, ActivitySource)
        else session.source,
        garmin_activity_id=session.garmin_activity_id,
        strava_activity_id=session.strava_activity_id,
        adherence_score=session.adherence_score,
    )


# ─────────────────────────────────────────────────────────────────────────
# Planned Sessions Endpoints
# ─────────────────────────────────────────────────────────────────────────


@router.post("/planned", response_model=PlannedSessionResponse, status_code=201)
def create_planned_session(session: PlannedSessionCreate):
    """Create a new planned training session.

    This represents a recommended/scheduled workout from the coach or LLM.
    """
    planned = PlannedSession(
        date=session.date,
        sport=canonical_sport(session.sport),
        session_type=session.session_type,
        target_duration_min=session.target_duration_min,
        target_distance_km=session.target_distance_km,
        target_hr_zone=session.target_hr_zone,
        target_intensity=session.target_intensity,
        description=session.description,
        source=session.source,
        prescription=session.prescription,
    )

    from arete.services.planning import create_manual_session

    try:
        created = create_manual_session(planned)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _planned_to_response(created)


@router.get("/planned", response_model=list[PlannedSessionResponse])
def list_planned_sessions(
    start_date: date | None = Query(None, description="Filter by start date"),
    end_date: date | None = Query(None, description="Filter by end date"),
    status: SessionStatus | None = Query(None, description="Filter by status"),
    limit: int = Query(500, ge=1, le=2000),
):
    """List planned training sessions.

    Returns planned sessions ordered by date descending.
    """
    sessions = _repo.list_planned_sessions(
        start_date=start_date,
        end_date=end_date,
        status=status,
        limit=limit,
    )
    return [_planned_to_response(s) for s in sessions]


class PlannedSessionUpdate(BaseModel):
    """A complete editor save requires the revision the athlete actually read."""

    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    date: date
    session_type: SessionType
    description: str = Field(min_length=1, max_length=500)
    target_duration_min: int = Field(default=0, ge=0, le=1440)
    target_distance_km: float = Field(default=0, ge=0, le=1000)
    target_hr_zone: Literal["", "Z1", "Z2", "Z3", "Z4", "Z5"] = ""
    target_intensity: Literal["", "easy", "moderate", "hard"] = ""
    prescription: dict | None = None


@router.put("/planned/{session_id}", response_model=PlannedSessionResponse)
def edit_planned_session(session_id: int, payload: PlannedSessionUpdate):
    from arete.services.planning import SessionChanges, apply_session_changes

    changes = payload.model_dump(exclude={"revision", "date", "prescription"})
    changes["date_str"] = payload.date
    if payload.prescription is not None:
        changes["prescription"] = payload.prescription
    try:
        validated = SessionChanges.model_validate(changes)
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        return _planned_to_response(
            apply_session_changes(
                session_id, payload.revision, validated, require_strength_source=False
            )
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


class PlannedStatusUpdate(BaseModel):
    """Manual status change for a planned session."""

    status: SessionStatus
    revision: int | None = Field(None, ge=1)


@router.patch("/planned/{session_id}", response_model=PlannedSessionResponse)
def update_planned_status(session_id: int, payload: PlannedStatusUpdate):
    """Mark a planned session as done, skipped or back to pending."""
    try:
        changed = _repo.update_planned_session_fields(
            session_id, status=payload.status, expected_revision=payload.revision
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not changed:
        raise HTTPException(
            409 if payload.revision else 404,
            "La séance a changé ou n’existe plus. Recharge le planning.",
        )
    session = _repo.get_planned_session(session_id)
    if session is None:  # pragma: no cover - just deleted concurrently
        raise HTTPException(status_code=404, detail="Planned session not found")
    return _planned_to_response(session)


@router.delete("/planned/{session_id}")
def delete_planned_session(session_id: int, revision: int | None = Query(None, ge=1)):
    """Delete a planned session."""
    try:
        success = _repo.delete_planned_session(session_id, expected_revision=revision)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not success:
        raise HTTPException(
            409 if revision else 404,
            "La séance a changé ou n’existe plus. Recharge le planning.",
        )
    return {"message": "Session deleted"}


# ─────────────────────────────────────────────────────────────────────────
# FIT Upload & Actual Sessions
# ─────────────────────────────────────────────────────────────────────────


@router.post("/upload-fit", response_model=FITUploadResponse)
def upload_fit_file(
    file: UploadFile = File(..., description="FIT file from Garmin device"),
    auto_match: bool = Query(
        True, description="Automatically match to planned session"
    ),
):
    """Upload a FIT file and parse the activity.

    The activity is saved to the database and optionally matched
    to a planned session based on date and activity type. A plain ``def``:
    the FIT parse and the writes run in a worker thread, not on the event
    loop every other request shares.
    """
    import io
    from pathlib import Path

    if not file.filename or not file.filename.lower().endswith(".fit"):
        raise HTTPException(status_code=400, detail="File must be a .fit file")

    # Read with size limit (10MB for typical FIT files)
    MAX_FIT_SIZE = 10 * 1024 * 1024  # 10MB
    content = bytearray()
    total_size = 0

    while chunk := file.file.read(8192):
        total_size += len(chunk)
        if total_size > MAX_FIT_SIZE:
            raise HTTPException(status_code=413, detail="FIT file too large (max 10MB)")
        content.extend(chunk)

    content_bytes = bytes(content)

    # The athlete's zones: bucketing the upload's HR and reading a planned
    # "Z2" both need them (the default 190 bpm model misreads both).
    zones = athlete_zone_model()
    try:
        parser = FITParser(zones=zones)
        # Detailed: the laps and the per-second streams are kept for the
        # session page and the coach's analysis.
        parsed = parser.parse_stream(io.BytesIO(content_bytes), detailed=True)
        # Sanitize filename to prevent path traversal
        parsed.source_file = Path(file.filename).name
    except Exception as e:
        logger.error(f"Failed to parse FIT file: {e}")
        raise HTTPException(
            status_code=400, detail=f"Failed to parse FIT file: {e}"
        ) from e

    # Convert parsed activity to ActualSession
    actual = ActualSession(
        date=parsed.start_time.date() if parsed.start_time else athlete_today(),
        sport=canonical_sport(parsed.sport or "running"),
        session_type=parsed.sub_sport or parsed.infer_session_type(),
        duration_sec=parsed.duration_sec or parsed.elapsed_time_sec or 0,
        distance_m=parsed.distance_m,
        calories=parsed.calories,
        avg_hr=parsed.avg_hr,
        max_hr=parsed.max_hr,
        hr_zones_json=parsed.hr_zones.to_json() if parsed.hr_zones else None,
        avg_speed_mps=parsed.avg_speed_mps,
        max_speed_mps=parsed.max_speed_mps,
        ascent_m=parsed.ascent_m,
        descent_m=parsed.descent_m,
        start_lat=parsed.start_lat,
        start_lon=parsed.start_lon,
        avg_cadence=parsed.avg_cadence,
        max_cadence=parsed.max_cadence,
        laps_json=laps_to_json(parsed),
        source=ActivitySource.FIT_FILE,
        source_file=file.filename,
        start_time=parsed.start_time,
    )

    # Calculate avg pace if running
    if actual.distance_m and actual.duration_sec and actual.distance_m > 0:
        pace_sec_per_km = actual.duration_sec / (actual.distance_m / 1000)
        actual.avg_pace_sec_km = int(pace_sec_per_km)

    # Auto-match to planned session
    match_result = None
    if auto_match:
        planned_sessions = _repo.get_potential_matches(actual)
        if planned_sessions:
            matcher = SessionMatcher(zones=zones)
            match = matcher.find_match(actual, planned_sessions)
            if match.is_matched and match.planned_session is not None:
                planned_id = match.planned_session.id
                actual.planned_session_id = planned_id
                actual.adherence_score = match.adherence_score
                match_result = {
                    "planned_session_id": planned_id,
                    "confidence": match.confidence.value,
                    "adherence_score": match.adherence_score,
                    "summary": match.summary(),
                }
                # Update planned session status
                if planned_id is not None:
                    _repo.update_planned_session_status(
                        planned_id, SessionStatus.COMPLETED
                    )

    # Save actual session
    activity_id = _repo.create_actual_session(actual)
    # A file without a start time is dated today: too weak to pair a Muscu log.
    if actual.sport == "strength" and parsed.start_time:
        link_garmin_strength([actual.date])
    streams = from_time_series(parsed.time_series, actual.sport)
    if streams is not None:
        try:
            _repo.save_activity_streams(activity_id, streams)
        except Exception:  # the session is saved; only its page loses the charts
            logger.warning("Could not store the upload's streams", exc_info=True)
    from arete.services.session_conditions import enrich_sessions

    enrich_sessions([activity_id])  # GAP, climbing speed, weather; never raises

    activity_dict = {
        "id": activity_id,
        "date": str(actual.date),
        "sport": actual.sport,
        "duration_min": actual.duration_min,
        "distance_km": actual.distance_km,
        "avg_hr": actual.avg_hr,
        "avg_pace": actual.avg_pace_min_km,
    }

    return FITUploadResponse(
        activity_id=activity_id,
        activity=activity_dict,
        match=match_result,
        message="Activity saved" + (" and matched" if match_result else ""),
    )


class ActualSessionCreate(BaseModel):
    """Manual cardio entry (no watch, no FIT file)."""

    date: date
    sport: str = "running"
    session_type: str | None = None
    name: str | None = None
    duration_min: int = Field(gt=0, le=1440)
    distance_km: float | None = Field(default=None, ge=0, le=1000)
    avg_hr: int | None = Field(default=None, ge=30, le=250)
    rpe: int | None = Field(default=None, ge=1, le=10)
    notes: str | None = None


@router.post("/actual", response_model=ActualSessionResponse, status_code=201)
def create_actual_session(payload: ActualSessionCreate):
    """Record a session done without a watch; matches the plan like a synced one."""
    from arete.garmin.sync import auto_match

    duration_sec = payload.duration_min * 60
    distance_m = payload.distance_km * 1000 if payload.distance_km else None
    session = ActualSession(
        date=payload.date,
        sport=canonical_sport(payload.sport),
        session_type=payload.session_type or payload.sport,
        name=payload.name,
        duration_sec=duration_sec,
        moving_time_sec=duration_sec,
        distance_m=distance_m,
        avg_hr=payload.avg_hr,
        avg_pace_sec_km=round(duration_sec / payload.distance_km)
        if payload.distance_km
        else None,
        rpe=payload.rpe,
        notes=payload.notes,
        source=ActivitySource.MANUAL,
    )
    session_id = _repo.create_actual_session(session)
    auto_match(_repo, session_id, session)
    if session.sport == "strength":
        link_garmin_strength([session.date])
    created = _repo.get_actual_session(session_id)
    if created is None:  # pragma: no cover - just inserted
        raise HTTPException(status_code=500, detail="Session could not be read back")
    return _actual_to_response(created)


@router.get("/actual", response_model=list[ActualSessionResponse])
def list_actual_sessions(
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    unmatched_only: bool = Query(False, description="Only show unmatched sessions"),
    limit: int = Query(500, ge=1, le=2000),
):
    """List actual training sessions (from FIT files/Garmin Connect)."""
    sessions = _repo.list_actual_sessions(
        start_date=start_date,
        end_date=end_date,
        unmatched_only=unmatched_only,
        limit=limit,
        include_blobs=False,
    )
    return [_actual_to_response(s) for s in sessions]


# ─────────────────────────────────────────────────────────────────────────
# Summary & Analytics
# ─────────────────────────────────────────────────────────────────────────


@router.get("/summary", response_model=MatchSummaryResponse)
def get_summary(
    start_date: date | None = Query(None, description="Window start (inclusive)"),
    end_date: date | None = Query(
        None, description="Window end (inclusive, capped at today)"
    ),
):
    """Adherence: planned sessions due in the window vs completed / skipped."""
    summary = _repo.get_matches_summary(start=start_date, end=end_date)
    return MatchSummaryResponse(**summary)
