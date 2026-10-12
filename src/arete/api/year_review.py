"""HTTP contract for the year in review; the service computes every number."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from arete.services import year_review as service
from arete.services.settings import athlete_today

router = APIRouter(prefix="/year-review", tags=["year-review"])


@router.get("")
def get_year_review(year: int | None = None) -> dict[str, Any]:
    """Deterministic stats of one calendar year (default: the current one)."""
    try:
        return service.year_review(year or athlete_today().year)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
