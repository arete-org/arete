"""Garmin Connect sync endpoints: login (with MFA), status, activity sync."""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import Iterator
from dataclasses import asdict
from datetime import date

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from arete.garmin.repository import GarminRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/garmin/sync", tags=["garmin-sync"])
_repo = GarminRepository()


class SyncStatusResponse(BaseModel):
    """Sync status response."""

    garmin_authenticated: bool
    user_email: str | None = None
    last_sync: str | None = None
    activities_synced: int = 0


class SyncRequest(BaseModel):
    """Sync request parameters."""

    start_date: date | None = None
    end_date: date | None = None
    download_fit: bool = True
    max_activities: int = Field(50, ge=1, le=200)
    history_offset: int | None = Field(None, ge=0, le=20_000)
    history_anchor: int | None = Field(None, gt=0)

    @model_validator(mode="after")
    def validate_period(self) -> SyncRequest:
        if self.start_date and self.start_date > (self.end_date or date.today()):
            raise ValueError("La date de fin doit suivre ou égaler la date de début.")
        if self.history_offset is not None:
            if self.start_date or self.end_date or self.max_activities != 20:
                raise ValueError(
                    "L’historique complet utilise des lots de 20 sans dates."
                )
            if (self.history_offset > 0) != (self.history_anchor is not None):
                raise ValueError(
                    "Le lot suivant requiert la dernière activité du précédent."
                )
        elif self.history_anchor is not None:
            raise ValueError(
                "Une activité de reprise requiert un import de l’historique."
            )
        return self


class SyncResponse(BaseModel):
    """Sync result response."""

    success: bool
    activities_synced: int
    activities_merged: int = 0
    activities_matched: int = 0
    activities_skipped: int
    errors: list[str]
    last_activity_date: str | None = None
    next_history_offset: int | None = None
    history_anchor: int | None = None


class GarminLoginRequest(BaseModel):
    """Garmin login credentials (secure, not logged)."""

    email: str | None = Field(None, repr=False)
    password: str | None = Field(None, repr=False)
    mfa_code: str | None = Field(None, repr=False, description="MFA code if required")


class GarminLoginResponse(BaseModel):
    """Garmin login response."""

    success: bool
    needs_mfa: bool = False
    message: str


@router.get("/status", response_model=SyncStatusResponse)
def get_sync_status():
    """Sync status from local state: no Garmin login, no ``garminconnect``.

    ``garmin_authenticated`` means session tokens are stored; tokens Garmin
    has since expired or revoked are reported by the next real sync.
    """
    from arete.garmin import token_store

    authenticated, user_email = token_store.session_status()
    _, imported_at = _repo.last_garmin_import()
    return SyncStatusResponse(
        garmin_authenticated=authenticated,
        user_email=user_email,
        last_sync=imported_at.isoformat() if imported_at else None,
        activities_synced=_repo.count_actual_sessions(),
    )


@router.post("/login", response_model=GarminLoginResponse)
def garmin_login(request: GarminLoginRequest | None = None):
    """Authenticate with Garmin Connect.

    MFA flow: first call with email/password may return needs_mfa=True;
    call again with mfa_code to complete. Only session tokens are retained,
    under the authenticated athlete.
    """
    from arete.garmin.client import GarminAuthError, GarminClient

    client = GarminClient()

    if request and request.mfa_code:
        try:
            client.complete_mfa(request.mfa_code)
        except GarminAuthError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except Exception as e:
            logger.warning("Garmin MFA failed (%s)", type(e).__name__)
            raise HTTPException(
                status_code=400, detail="Code Garmin refusé. Recommence la connexion."
            ) from e
        return GarminLoginResponse(
            success=True, message="Successfully authenticated with Garmin Connect"
        )

    email = request.email if request else None
    password = request.password if request else None
    if not email or not password:
        raise HTTPException(
            status_code=400,
            detail="Saisis ton adresse e-mail et ton mot de passe Garmin.",
        )

    try:
        status = client.login(email, password)
    except Exception as e:
        logger.warning("Garmin login failed (%s)", type(e).__name__)
        raise HTTPException(
            status_code=400,
            detail="Connexion Garmin refusée ou indisponible. Vérifie tes identifiants et réessaie.",
        ) from e

    if status == "needs_mfa":
        return GarminLoginResponse(
            success=False,
            needs_mfa=True,
            message="MFA code required. Please provide the code sent to your device.",
        )
    return GarminLoginResponse(
        success=True, message="Successfully authenticated with Garmin Connect"
    )


@router.post("/logout")
def garmin_logout():
    """Clear Garmin Connect authentication tokens."""
    from arete.garmin.client import GarminClient

    GarminClient().logout()
    return {"success": True, "message": "Logged out from Garmin Connect"}


@router.post("/activities", response_model=SyncResponse)
def sync_activities(request: SyncRequest):
    """Sync activities from Garmin Connect.

    Requires this athlete to connect Garmin through /sync/login.
    """
    from arete.garmin.sync import GarminSyncClient

    client = GarminSyncClient(repository=_repo)

    if not client.is_authenticated():
        raise HTTPException(
            status_code=409,
            detail="Connecte Garmin dans Réglages → Connexions avant de synchroniser.",
        )

    result = client.sync_activities(
        start_date=request.start_date,
        end_date=request.end_date,
        download_fit=request.download_fit,
        max_activities=request.max_activities,
        history_offset=request.history_offset,
        history_anchor=request.history_anchor,
    )
    from arete.services.session_conditions import enrich_sessions

    enrich_sessions(result.session_ids)  # bounded, never raises

    return SyncResponse(
        success=result.success,
        activities_synced=result.activities_synced,
        activities_merged=result.activities_merged,
        activities_matched=result.activities_matched,
        activities_skipped=result.activities_skipped,
        errors=result.errors,
        last_activity_date=str(result.last_activity_date)
        if result.last_activity_date
        else None,
        next_history_offset=result.next_history_offset,
        history_anchor=result.history_anchor,
    )


@router.post("/activities/stream")
def stream_activities(request: SyncRequest) -> StreamingResponse:
    """Stream the existing sync workflow; no retries or detached worker."""
    from arete.garmin.sync import GarminSyncClient, SyncProgress, SyncResult
    from arete.services.session_conditions import enrich_sessions

    client = GarminSyncClient(repository=_repo)
    if not client.is_authenticated():
        raise HTTPException(
            status_code=409,
            detail="Connecte Garmin dans Réglages → Connexions avant de synchroniser.",
        )

    def frame(kind: str, payload: dict) -> str:
        return (
            "data: "
            + json.dumps({"type": kind, **payload}, ensure_ascii=False)
            + "\n\n"
        )

    def events() -> Iterator[str]:
        try:
            # Starlette advances this iterator in its AnyIO worker pool.
            with contextlib.closing(
                client.iter_sync_activities(**request.model_dump())
            ) as work:
                for event in work:
                    if isinstance(event, SyncResult):
                        if event.success:
                            yield frame("progress", asdict(SyncProgress("finalizing")))
                            enrich_sessions(event.session_ids)
                        payload = asdict(event)
                        payload["last_activity_date"] = (
                            str(event.last_activity_date)
                            if event.last_activity_date
                            else None
                        )
                        result = SyncResponse.model_validate(payload)
                        yield frame("done", result.model_dump(mode="json"))
                        return
                    yield frame("progress", asdict(event))
        except Exception:
            logger.exception("Garmin sync stream failed")
            yield frame(
                "error",
                {
                    "detail": "Synchronisation interrompue. Des activités peuvent déjà avoir été importées. Vérifie le résultat avant de relancer."
                },
            )

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/threshold")
def refresh_threshold_from_garmin():
    """Read the threshold Garmin last measured and store it when it is newer.

    Runs on every sync; this endpoint is the manual trigger.
    """
    from arete.garmin.sync import GarminSyncClient

    client = GarminSyncClient(repository=_repo)
    if not client.is_authenticated():
        raise HTTPException(
            status_code=409, detail="Connecte Garmin dans Réglages → Connexions."
        )
    return client.refresh_threshold()


@router.post("/recompute-zones")
def recompute_hr_zones():
    """Rewrite HR zones on every session with the athlete's current model.

    Run it after changing the threshold heart rate in the settings. Works
    offline: it reads the FIT files on disk and the stored laps.
    """
    from arete.garmin.sync import GarminSyncClient

    return GarminSyncClient(repository=_repo).recompute_zones()


@router.post("/reprocess")
def reprocess_synced_activities():
    """Backfill analytics columns (pace, laps, HR zones, names) on synced sessions.

    Reads the FIT files already on disk and asks Garmin for the activity names.
    Safe to run repeatedly.
    """
    from arete.garmin.sync import GarminSyncClient

    client = GarminSyncClient(repository=_repo)
    if not client.is_authenticated():
        raise HTTPException(
            status_code=409, detail="Connecte Garmin dans Réglages → Connexions."
        )
    return client.reprocess_existing()
