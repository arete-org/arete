"""Onboarding writes require the authenticated athlete scope, never a body id."""

from fastapi import APIRouter, HTTPException

from arete.services import onboarding
from arete.services.memory import MemoryConflict

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


@router.get("")
def progress() -> dict:
    return onboarding.get_progress()


@router.get("/context")
def context() -> dict:
    return onboarding.confirmed_context()


@router.post("")
def save(body: onboarding.ConfirmOnboarding) -> dict:
    try:
        return onboarding.confirm(body)
    except ValueError as exc:
        raise HTTPException(
            409 if isinstance(exc, MemoryConflict) else 422, str(exc)
        ) from exc
