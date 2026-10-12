"""Planning toolkit — create/list/update/delete planned sessions.

Write access to the planning repository, exposed to the agent as a toolkit
bound directly by the server profile. Sessions created by the agent are
stamped ``source="coach"`` so the Planning page can tell them apart.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any, Literal

from pydantic import Field, model_validator

from arete.garmin.models import (
    PlannedSession,
    SessionStatus,
    SessionType,
    canonical_sport,
)
from arete.garmin.repository import GarminRepository
from arete.services.prescriptions import (
    Prescription,
    Provenance,
    StrictModel,
    conversation_prescription,
    describe,
)
from arete.services.settings import athlete_today

_MAX_LIST = 50
_HORIZON_DAYS = 120
_MAX_SOURCE_HINTS = 5


def _repo() -> GarminRepository:
    return GarminRepository()


def _session_to_dict(s: PlannedSession) -> dict[str, Any]:
    return {
        "id": s.id,
        "date": s.date.isoformat(),
        "sport": s.sport,
        "session_type": s.session_type.value,
        "target_duration_min": s.target_duration_min,
        "target_distance_km": s.target_distance_km,
        "target_hr_zone": s.target_hr_zone,
        "target_intensity": s.target_intensity,
        "description": s.description,
        "source": s.source,
        "status": s.status.value,
        "revision": s.revision,
        "structured": s.prescription is not None,
        "summary": describe(Prescription.model_validate(s.prescription))
        if s.prescription
        else s.description,
    }


def _parse_iso(value: str, field: str) -> date | str:
    """The date, or a tool error the model can read and correct."""
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return json.dumps(
            {"error": f"{field} doit être une date ISO (YYYY-MM-DD), reçu « {value} »"},
            ensure_ascii=False,
        )


def list_planned(
    start_date: str = "",
    end_date: str = "",
) -> str:
    """List upcoming planned training sessions, earliest first.

    Args:
        start_date: Optional ISO date (YYYY-MM-DD) filter start, empty = today - 7.
        end_date: Optional ISO date (YYYY-MM-DD) filter end, empty = today + 120.
    """
    start = (
        _parse_iso(start_date, "start_date")
        if start_date
        else athlete_today() - timedelta(days=7)
    )
    if isinstance(start, str):
        return start
    end = (
        _parse_iso(end_date, "end_date")
        if end_date
        else athlete_today() + timedelta(days=_HORIZON_DAYS)
    )
    if isinstance(end, str):
        return end
    # Earliest first, one past the cap: a dense plan keeps this week, and the
    # model learns where to resume instead of silently missing sessions.
    sessions = _repo().list_planned_sessions(
        start_date=start, end_date=end, status=None, limit=_MAX_LIST + 1, ascending=True
    )
    truncated = len(sessions) > _MAX_LIST
    shown = sessions[:_MAX_LIST]
    return json.dumps(
        {
            "count": len(shown),
            "truncated": truncated,
            "next_start_date": sessions[_MAX_LIST].date.isoformat()
            if truncated
            else None,
            "sessions": [_session_to_dict(s) for s in shown],
        },
        ensure_ascii=False,
    )


def create_planned_session(
    date_str: str,
    session_type: str,
    description: str = "",
    sport: str = "running",
    target_duration_min: int = 0,
    target_distance_km: float = 0.0,
    target_intensity: str = "",
    prescription: Prescription | None = None,
    strength_text: str = "",
    provenance: list[Provenance] | None = None,
    thread_id: str | None = None,
) -> str:
    """Create a planned training session (source stamped 'coach').

    Args:
        date_str: ISO date (YYYY-MM-DD) of the session.
        session_type: One of recovery, endurance, tempo, intervals, long_run,
            strength, hypertrophy, power, deload, cross_training, race, other.
        description: What the session should be (shown on the Planning page).
        sport: running, cycling, swimming, strength… (default running).
        target_duration_min: Target duration in minutes (0 = unset).
        target_distance_km: Target distance in km (0 = unset).
        target_intensity: easy, moderate or hard (empty = unset).
    """
    try:
        st = SessionType(session_type)
    except ValueError:
        return json.dumps(
            {
                "error": f"Unknown session_type '{session_type}'. Valid: {[t.value for t in SessionType]}"
            }
        )
    intensity = target_intensity.strip().lower() or None
    if intensity is not None and intensity not in ("easy", "moderate", "hard"):
        return json.dumps({"error": "target_intensity must be easy|moderate|hard"})

    day = _parse_iso(date_str, "date_str")
    if isinstance(day, str):
        return day
    try:
        prescription = (
            conversation_prescription(
                prescription, canonical_sport(sport), day, strength_text
            )
            if prescription or strength_text or canonical_sport(sport) == "strength"
            else None
        )
        # Source evidence belongs to this conversation, never a model-selected thread.
        sources = []
        if provenance:
            from arete.services.documents import extraction_for

            if not thread_id:
                raise ValueError("Un fil est requis pour citer une pièce jointe.")
            if len(provenance) > 20:
                raise ValueError("Maximum 20 références par séance.")
            for source in provenance:
                extraction = extraction_for(thread_id, str(source.document_id))
                if not any(
                    b.locator == source.locator and source.quote in b.text
                    for b in extraction.blocks
                ):
                    # A recoverable validation error must name the real locator,
                    # not make the model guess it again. Never repair a write silently.
                    matches = [
                        b.locator for b in extraction.blocks if source.quote in b.text
                    ]
                    hint = (
                        f" Cet extrait existe dans {len(matches)} bloc(s) ; "
                        f"localisateurs exacts (au plus {_MAX_SOURCE_HINTS}) : "
                        + ", ".join(matches[:_MAX_SOURCE_HINTS])
                        + ". Corrige locator avant de réessayer."
                        if matches
                        else " Relis la source : quote doit être un extrait exact du bloc, "
                        "sans les numéros de ligne ajoutés par read_file."
                    )
                    raise ValueError(
                        f"La source {source.locator} ne contient pas l’extrait cité."
                        + hint
                    )
                sources.append(source.model_dump(mode="json"))
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)
    planned = PlannedSession(
        date=day,
        sport=canonical_sport(sport),
        session_type=st,
        target_duration_min=target_duration_min or None,
        target_distance_km=target_distance_km or None,
        target_intensity=intensity,
        description=description or None,
        source="coach",
        prescription=prescription.model_dump(mode="json") if prescription else None,
        provenance=sources or None,
    )
    session_id = _repo().create_planned_session(planned)
    created = _repo().get_planned_session(session_id)
    return json.dumps(
        {
            "created": True,
            "session": _session_to_dict(created) if created else {"id": session_id},
        },
        ensure_ascii=False,
    )


class SessionChanges(StrictModel):
    """Omission preserves a field; explicit zero/empty clears optional targets."""

    date_str: date | None = None
    session_type: SessionType | None = None
    status: SessionStatus | None = None
    description: str | None = Field(default=None, max_length=500)
    target_duration_min: int | None = Field(default=None, ge=0, le=1440)
    target_distance_km: float | None = Field(default=None, ge=0, le=1000)
    target_hr_zone: Literal["", "Z1", "Z2", "Z3", "Z4", "Z5"] | None = None
    target_intensity: Literal["", "easy", "moderate", "hard"] | None = None
    prescription: Prescription | None = None
    strength_text: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def meaningful(self):
        if not self.model_fields_set:
            raise ValueError("Indique au moins un champ à modifier.")
        if any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError(
                "Omet les champs inchangés ; utilise zéro ou une chaîne vide pour effacer une cible."
            )
        return self


def update_planned_session(
    session_id: int, revision: int, changes: SessionChanges
) -> str:
    """Apply one versioned patch; repository checks export reservations atomically."""
    try:
        current = _repo().get_planned_session(session_id)
        if current is None:
            raise ValueError("Séance introuvable.")
        fields = changes.model_dump(
            exclude_unset=True, exclude={"prescription", "strength_text"}
        )
        if "date_str" in fields:
            fields["date"] = fields.pop("date_str")
        prescription = None
        if changes.prescription is not None or changes.strength_text is not None:
            prescription = conversation_prescription(
                changes.prescription,
                current.sport,
                changes.date_str or current.date,
                changes.strength_text or "",
            )
        targets = {
            "target_duration_min",
            "target_distance_km",
            "target_hr_zone",
            "target_intensity",
        }
        if (current.prescription or prescription) and any(
            fields.get(k) for k in targets
        ):
            raise ValueError(
                "Modifie la prescription pour changer les objectifs d’une séance structurée."
            )
        # A replacement must not leave stale scalar targets contradicting its steps.
        if prescription:
            fields.update({key: None for key in targets})
        for key in targets | {"description"}:
            if key in fields and not fields[key]:
                fields[key] = None
        changed = _repo().update_planned_session_fields(
            session_id,
            expected_revision=revision,
            prescription=prescription.model_dump(mode="json") if prescription else None,
            **fields,
            garmin_pushed_at=None,
        )
        if not changed:
            raise ValueError(
                "La séance a changé ou n’existe plus. Recharge le planning."
            )
        from arete.services.garmin_export import inspect_session

        # Include the new export state so an existing UI card cannot remain "scheduled".
        return json.dumps(
            {"updated": True, **inspect_session(session_id, include_steps=False)},
            ensure_ascii=False,
        )
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)


def delete_planned_session(session_id: int) -> str:
    """Delete a planned session by id. Prefer update_planned_session to mark it
    skipped — deletion loses the record.

    Args:
        session_id: Id of the planned session.
    """
    if not _repo().delete_planned_session(session_id):
        return json.dumps({"error": f"Planned session {session_id} not found"})
    return json.dumps({"deleted": True, "id": session_id})
