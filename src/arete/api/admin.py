"""Accounts and rollout flags for administrators; roles for the owner alone.

Reads and writes shared account and rollout tables, never an athlete's private
data. The rules live in ``services.users`` and ``services.feature_flags``.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, StrictBool, model_validator

from arete import scheduler
from arete.api.auth import forget_accounts, require_admin, require_owner
from arete.services import users
from arete.services.feature_flags import (
    FeatureFlags,
    get_feature_flags,
    glm_flash_available,
    set_feature_flags,
)
from arete.services.users import AccountError, AppUser

router = APIRouter(
    prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)]
)


class AccountOut(BaseModel):
    athlete_id: int
    user_id: int | None
    email: str | None
    name: str | None
    role: str
    is_owner: bool
    last_seen_at: datetime | None
    last_sync_at: datetime | None
    sync_lease_until: datetime | None
    lease_stuck: bool
    deactivated_at: datetime | None


class RoleUpdate(BaseModel):
    role: Literal["athlete", "admin"]


class FeatureFlagsOut(FeatureFlags):
    glm_flash_available: bool


class FeatureFlagsUpdate(FeatureFlags):
    @model_validator(mode="after")
    def specified(self):
        if not self.model_fields_set:
            raise ValueError("Indique une option à modifier.")
        return self


@router.get("/feature-flags", response_model=FeatureFlagsOut)
def read_feature_flags() -> FeatureFlagsOut:
    return FeatureFlagsOut(
        **get_feature_flags().model_dump(), glm_flash_available=glm_flash_available()
    )


@router.put("/feature-flags", response_model=FeatureFlagsOut)
def update_feature_flags(body: FeatureFlagsUpdate) -> FeatureFlagsOut:
    try:
        flags = set_feature_flags(body)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return FeatureFlagsOut(
        **flags.model_dump(), glm_flash_available=glm_flash_available()
    )


@contextmanager
def _rules() -> Iterator[None]:
    try:
        yield
    except AccountError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from None


@router.get("/accounts", response_model=list[AccountOut])
def list_accounts() -> list[dict[str, Any]]:
    """Every athlete with its logins, roles, last activity and daily sync."""
    return [account.to_dict() for account in users.list_accounts()]


@router.post("/accounts/{user_id}/role", dependencies=[Depends(require_owner)])
def set_role(user_id: int, body: RoleUpdate) -> dict[str, Any]:
    with _rules():
        updated = users.set_role(user_id, body.role)
    forget_accounts()  # other instances follow within ACCOUNT_TTL_SECONDS
    return updated.to_dict()


@router.post("/athletes/{athlete_id}/deactivate", status_code=204)
def deactivate(athlete_id: int, actor: AppUser = Depends(require_admin)) -> Response:
    with _rules():
        users.deactivate_athlete(athlete_id, actor=actor)
    forget_accounts()
    return Response(status_code=204)


@router.post("/athletes/{athlete_id}/reactivate", status_code=204)
def reactivate(athlete_id: int) -> Response:
    with _rules():
        users.reactivate_athlete(athlete_id)
    forget_accounts()
    return Response(status_code=204)


@router.post("/athletes/{athlete_id}/release-lease")
def release_lease(athlete_id: int) -> dict[str, bool]:
    """After a failed or stopped daily sync, let the next window run it again."""
    return {"released": scheduler.release_sync_lease(athlete_id)}


class GarminReconciliation(BaseModel):
    operation_id: str
    workers_stopped: StrictBool


@router.post("/athletes/{athlete_id}/garmin/reconcile")
def reconcile_garmin(athlete_id: int, body: GarminReconciliation) -> dict:
    """Recover an expired import only after the administrator stopped old workers."""
    from arete.services.athlete_scope import athlete_scope
    from arete.services.garmin_sync import reconcile_abandoned

    if not users.athlete_is_active(athlete_id):
        raise HTTPException(status_code=404, detail="Athlète introuvable.")
    try:
        with athlete_scope(athlete_id):
            return reconcile_abandoned(
                body.operation_id, workers_stopped=body.workers_stopped
            )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
