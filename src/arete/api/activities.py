"""Activity file import (FIT, TCX, GPX, ZIP): the path for any watch."""

from __future__ import annotations

from datetime import date as date_type
from typing import Literal

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter(prefix="/activities", tags=["activities"])

#: One upload (an activity or a ZIP of them, possibly gzip-compressed).
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


class ImportResult(BaseModel):
    """One file's outcome; ``message`` is shown as is (French)."""

    filename: str
    status: Literal["imported", "duplicate", "error"]
    message: str
    session_id: int | None = None
    duplicate_of: int | None = None
    date: date_type | None = None
    sport: str | None = None
    duration_sec: int | None = None
    distance_m: float | None = None
    planned_session_id: int | None = None


class ImportResponse(BaseModel):
    results: list[ImportResult]


def read_upload(file: UploadFile, limit: int = MAX_UPLOAD_BYTES) -> bytes:
    """The upload's bytes, refused (413) past ``limit`` without reading on."""
    content = bytearray()
    while chunk := file.file.read(64 * 1024):
        content.extend(chunk)
        if len(content) > limit:
            raise HTTPException(413, "Fichier trop volumineux (10 Mo maximum).")
    return bytes(content)


@router.post("/import", response_model=ImportResponse)
def import_activity(
    file: UploadFile = File(..., description="FIT, TCX, GPX or a ZIP of them"),
) -> ImportResponse:
    """Import one file. A plain ``def``: parsing and writes run in a worker.

    Always 200 with one result per activity file (a ZIP gives several): a
    refused or unreadable file is a result, not a failed request.
    """
    # Imported here: the parsers and the Garmin sync helpers stay off the boot path.
    from arete.services.activity_import import import_upload

    outcomes = import_upload(file.filename or "", read_upload(file))
    return ImportResponse(
        results=[ImportResult.model_validate(o, from_attributes=True) for o in outcomes]
    )
