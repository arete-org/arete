"""Planning toolkit — create/list/update/delete planned sessions.

Write access to the planning repository, exposed to the agent as a toolkit
bound directly by the server profile. Sessions created by the agent are
stamped ``source="coach"`` so the Planning page can tell them apart.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta
from hashlib import sha256
from typing import Any, Literal, cast
from uuid import UUID, uuid4

import duckdb
from pydantic import Field, model_validator

from arete.dataio import plan_changes
from arete.dataio.db import db_connection, transaction
from arete.garmin.models import (
    PlannedSession,
    SessionStatus,
    SessionType,
    canonical_sport,
)
from arete.garmin.repository import GarminRepository
from arete.garmin.workout_structure import NotPushable, ensure_template_fits
from arete.services.prescriptions import (
    Prescription,
    Provenance,
    StrictModel,
    conversation_prescription,
    describe,
    strength_sets,
)
from arete.services.settings import athlete_today, get_settings, utc_now, zone_of

_MAX_LIST = 50
_HORIZON_DAYS = 120
_MAX_SOURCE_HINTS = 5
_STEPS_REQUIRED = (
    "Un tempo ou un fractionné décrit, en course ou à vélo, exige des étapes "
    "(échauffement, blocs ou répétitions avec récupérations, retour au calme) : "
    "sans elles, la montre recevrait un modèle générique et non la séance décrite. "
    "Fixe la prescription complète avec set_session_prescription."
)

_STRENGTH_SETS_DIFFER = (
    "Les séries doivent correspondre à celles lues dans strength_text : "
    "modifie d’abord strength_text avec update_planned_session."
)


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
    # Steps arrive in a second call, so a described tempo is saved and flagged;
    # Garmin export keeps refusing it until then.
    try:
        ensure_template_fits(planned)
        steps_required = None
    except NotPushable:
        steps_required = _STEPS_REQUIRED
    session_id = _repo().create_planned_session(planned)
    created = _repo().get_planned_session(session_id)
    result: dict[str, Any] = {
        "created": True,
        "session": _session_to_dict(created) if created else {"id": session_id},
    }
    if steps_required is not None:
        result["steps_required"] = steps_required
    return json.dumps(result, ensure_ascii=False)


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


def create_manual_session(session: PlannedSession) -> PlannedSession:
    """Persist the browser's validated steps together with the session, in one write."""
    if session.prescription is not None:
        prescription = Prescription.model_validate(session.prescription)
        session.prescription = prescription.model_dump(mode="json")
        # Structured steps own their targets; scalar hints must not contradict them.
        session.target_duration_min = None
        session.target_distance_km = None
        session.target_hr_zone = None
        session.target_intensity = None
    session_id = _repo().create_planned_session(session)
    created = _repo().get_planned_session(session_id)
    assert created is not None, "A committed session must be readable"
    return created


def _validated_changes(
    current: PlannedSession,
    changes: SessionChanges,
    *,
    require_strength_source: bool = True,
    require_steps: bool = False,
) -> tuple[dict[str, Any], dict | None]:
    """One prescription boundary for both single and grouped edits."""
    fields = changes.model_dump(
        exclude_unset=True, exclude={"prescription", "strength_text"}
    )
    if "date_str" in fields:
        fields["date"] = fields.pop("date_str")
    prescription = None
    if changes.prescription is not None or changes.strength_text is not None:
        # Typed manual fields do not need the grammar evidence required from a model.
        prescription = (
            conversation_prescription(
                changes.prescription,
                current.sport,
                changes.date_str or current.date,
                changes.strength_text or "",
            )
            if require_strength_source or changes.strength_text is not None
            else changes.prescription
        )
    targets = {
        "target_duration_min",
        "target_distance_km",
        "target_hr_zone",
        "target_intensity",
    }
    if (current.prescription or prescription) and any(fields.get(k) for k in targets):
        raise ValueError(
            "Modifie la prescription pour changer les objectifs d’une séance structurée."
        )
    # A replacement must not leave stale scalar targets contradicting its steps.
    if prescription:
        fields.update({key: None for key in targets})
    for key in targets | {"description"}:
        if key in fields and not fields[key]:
            fields[key] = None
    # Judge the session as it would be saved. A pure move or skip leaves an
    # existing plan-generator session movable until its steps are completed.
    if require_steps and set(fields) - {"date", "status"}:
        try:
            ensure_template_fits(
                replace(
                    current,
                    session_type=changes.session_type or current.session_type,
                    description=fields.get("description", current.description),
                    prescription=prescription.model_dump(mode="json")
                    if prescription
                    else current.prescription,
                )
            )
        except NotPushable:
            raise ValueError(_STEPS_REQUIRED) from None
    return fields, prescription.model_dump(mode="json") if prescription else None


def apply_session_changes(
    session_id: int,
    revision: int,
    changes: SessionChanges,
    *,
    require_strength_source: bool = True,
    require_steps: bool = False,
) -> PlannedSession:
    """Share one versioned editing boundary between HTTP and coaching tools.

    ``require_steps`` (the coach's tool) refuses to leave a described tempo or
    interval session without explicit steps; date and status moves stay allowed.
    """
    current = _repo().get_planned_session(session_id)
    if current is None:
        raise ValueError("Séance introuvable.")
    fields, prescription = _validated_changes(
        current,
        changes,
        require_strength_source=require_strength_source,
        require_steps=require_steps,
    )
    changed = _repo().update_planned_session_fields(
        session_id,
        expected_revision=revision,
        prescription=prescription,
        **fields,
        garmin_pushed_at=None,
    )
    if not changed:
        raise ValueError("La séance a changé ou n’existe plus. Recharge le planning.")
    updated = _repo().get_planned_session(session_id)
    if updated is None:
        raise ValueError("La séance a été supprimée. Recharge le planning.")
    return updated


def update_planned_session(
    session_id: int,
    revision: int,
    changes: SessionChanges,
    *,
    require_strength_source: bool = True,
) -> str:
    """Adapt domain errors and the updated workout to the coaching tool contract."""
    try:
        apply_session_changes(
            session_id,
            revision,
            changes,
            require_strength_source=require_strength_source,
            require_steps=True,
        )
        from arete.services.garmin_export import inspect_session

        return json.dumps(
            {"updated": True, **inspect_session(session_id, include_steps=False)},
            ensure_ascii=False,
        )
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)


def set_session_prescription(
    session_id: int, revision: int, prescription: Prescription
) -> str:
    """Replace a session's steps; strength keeps the sets its grammar already read."""
    current = _repo().get_planned_session(session_id)
    if current is None:
        return json.dumps({"error": "Séance introuvable."}, ensure_ascii=False)
    if current.revision != revision:
        return json.dumps(
            {"error": "La séance a changé ou n’existe plus. Recharge le planning."},
            ensure_ascii=False,
        )
    if current.sport == "strength":
        if current.prescription is None:
            return json.dumps({"error": _STRENGTH_SETS_DIFFER}, ensure_ascii=False)
        # The revision check at write time rejects a session changed since this read.
        try:
            matches = strength_sets(
                Prescription.model_validate(current.prescription)
            ) == strength_sets(prescription)
        except ValueError:  # a set without repetitions
            matches = False
        if not matches:
            return json.dumps({"error": _STRENGTH_SETS_DIFFER}, ensure_ascii=False)
    return update_planned_session(
        session_id,
        revision,
        SessionChanges(prescription=prescription),
        require_strength_source=False,
    )


def delete_planned_session(session_id: int) -> str:
    """Delete a planned session by id. Prefer update_planned_session to mark it
    skipped — deletion loses the record.

    Args:
        session_id: Id of the planned session.
    """
    if not _repo().delete_planned_session(session_id):
        return json.dumps({"error": f"Planned session {session_id} not found"})
    return json.dumps({"deleted": True, "id": session_id})


MAX_CHANGE_SET_SESSIONS = 7
CHANGE_SET_HOURS = 48
MAX_CHANGE_SET_BYTES = 128 * 1024
CHANGE_SET_SECONDS = 5.0
_COORD_OWNER = "athlete_id=getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes a WHERE a.id=athlete_id AND a.deleted_at IS NULL)"


class PlanChangeItem(StrictModel):
    session_id: int = Field(gt=0)
    revision: int = Field(gt=0)
    changes: SessionChanges


class PlanChangeSet(StrictModel):
    items: list[PlanChangeItem] = Field(
        min_length=1, max_length=MAX_CHANGE_SET_SESSIONS
    )

    @model_validator(mode="after")
    def distinct(self):
        if len({item.session_id for item in self.items}) != len(self.items):
            raise ValueError("Une séance ne peut apparaître qu’une fois.")
        return self


def _change_set_sessions(con, proposal: PlanChangeSet, today: date):
    sessions = _repo().get_planned_sessions([i.session_id for i in proposal.items], con)
    validated = []
    for item in proposal.items:
        current = sessions.get(item.session_id)
        if current is None or current.revision != item.revision:
            raise ValueError(
                "Une séance a changé ou n’est plus disponible. Recrée la proposition."
            )
        if current.status not in {SessionStatus.PENDING, SessionStatus.MODIFIED}:
            raise ValueError(
                "Une séance terminée ou abandonnée ne peut plus être ajustée ensemble."
            )
        target_day = item.changes.date_str or current.date
        if current.date < today or not today <= target_day <= today + timedelta(
            days=_HORIZON_DAYS
        ):
            raise ValueError(
                "Les séances doivent rester entre aujourd’hui et les 120 prochains jours."
            )
        if item.changes.status not in {
            None,
            SessionStatus.PENDING,
            SessionStatus.MODIFIED,
            SessionStatus.SKIPPED,
        }:
            raise ValueError("Un ajustement ne peut pas déclarer une séance terminée.")
        fields, prescription = _validated_changes(
            current, item.changes, require_steps=True
        )
        # The repository rechecks this before each write in the same transaction.
        active = con.execute(
            "SELECT state FROM app.visible_garmin_exports WHERE session_id=?",
            [item.session_id],
        ).fetchone()
        if active and active[0] in {"working", "uncertain", "conflict"}:
            raise ValueError("Réconcilie l’export Garmin avant de modifier la séance.")
        if (
            prescription
            and (current.garmin_workout_id or current.garmin_schedule_id)
            and not active
        ):
            raise ValueError(
                "Vérifie d’abord l’ancien export Garmin avant de modifier ses étapes."
            )
        after = replace(
            current,
            prescription=prescription
            if prescription is not None
            else current.prescription,
            **fields,
        )
        validated.append((item, current, after, fields, prescription))
    return validated


def _check_change_deadline(started: float) -> None:
    from time import monotonic

    if monotonic() - started > CHANGE_SET_SECONDS:
        raise TimeoutError(
            "La vérification du planning a dépassé cinq secondes. Aucun changement validé."
        )


def preview_plan_changes(proposal: PlanChangeSet) -> dict[str, Any]:
    """Persist an immutable before/after proposal without changing any workout."""
    from time import monotonic

    started = monotonic()
    now = utc_now()
    zone = zone_of(get_settings().timezone)
    today = now.astimezone(zone).date()
    encoded = proposal.model_dump_json(exclude_unset=True)
    if len(encoded.encode()) > MAX_CHANGE_SET_BYTES:
        raise ValueError("Proposition trop volumineuse : limite de 128 Kio.")
    identifier = str(uuid4())
    with transaction() as con:
        validated = _change_set_sessions(con, proposal, today)
        before = [_session_to_dict(current) for _, current, _, _, _ in validated]
        after = [_session_to_dict(changed) for _, _, changed, _, _ in validated]
        last_day = min(
            min(current.date, changed.date) for _, current, changed, _, _ in validated
        )
        expires = min(
            now + timedelta(hours=CHANGE_SET_HOURS),
            datetime.combine(last_day + timedelta(days=1), time.min, zone).astimezone(
                UTC
            ),
        )
        con.execute(
            "INSERT INTO app.plan_change_sets (id,items_json,before_json,after_json,digest,expires_at,created_at) VALUES (?,?,?,?,?,?,?)",
            [
                identifier,
                encoded,
                json.dumps(before, ensure_ascii=False),
                json.dumps(after, ensure_ascii=False),
                sha256(encoded.encode()).hexdigest(),
                expires,
                now,
            ],
        )
        _check_change_deadline(started)
    return get_plan_changes(identifier)


def get_plan_changes(identifier: str, *, connection=None) -> dict[str, Any]:
    """Read only the current athlete's proposal, including its durable outcome."""
    UUID(identifier)
    con = connection
    # Explicit ownership of the connection avoids leaking one from a read path.
    if con is None:
        with db_connection() as owned:
            return get_plan_changes(identifier, connection=owned)
    row = con.execute(
        "SELECT id,revision,before_json,after_json,expires_at,state,receipt_json FROM app.visible_plan_change_sets WHERE id=?",
        [identifier],
    ).fetchone()
    if row is None:
        raise LookupError("Proposition introuvable.")
    state = "expired" if row[5] == "pending" and row[4] <= utc_now() else row[5]
    return {
        "id": row[0],
        "revision": row[1],
        "before": json.loads(row[2]),
        "after": json.loads(row[3]),
        "expires_at": row[4].isoformat(),
        "state": state,
        "receipt": json.loads(row[6]) if row[6] else None,
        "url": f"/planning?change_set={row[0]}",
    }


def apply_plan_changes(
    identifier: str, revision: int, operation_id: str
) -> dict[str, Any]:
    """Commit all local edits and their receipt once; never replay remote effects."""
    from time import monotonic

    UUID(identifier)
    UUID(operation_id)
    started = monotonic()
    today = athlete_today()
    try:
        with transaction() as con:
            row = con.execute(
                "SELECT revision,items_json,digest,expires_at,state,operation_id,receipt_json FROM app.visible_plan_change_sets WHERE id=?",
                [identifier],
            ).fetchone()
            if row is None:
                raise LookupError("Proposition introuvable.")
            if row[0] != revision:
                raise ValueError("La proposition a changé.")
            if row[4] == "applied":
                if row[5] != operation_id:
                    raise ValueError(
                        "Cette proposition a déjà été appliquée par une autre opération."
                    )
                return cast(dict[str, Any], json.loads(row[6]))
            if row[4] != "pending" or row[3] <= utc_now():
                raise ValueError(
                    "Cette proposition n’est plus disponible. Recrée-la depuis le planning."
                )
            assert sha256(row[1].encode()).hexdigest() == row[2], (
                "Immutable proposal digest changed"
            )
            validated = _change_set_sessions(
                con, PlanChangeSet.model_validate_json(row[1]), today
            )
            updated = []
            for item, _, after, fields, prescription in validated:
                changed = _repo().update_planned_session_fields(
                    item.session_id,
                    expected_revision=item.revision,
                    connection=con,
                    prescription=prescription,
                    **fields,
                    garmin_pushed_at=None,
                )
                if not changed:
                    raise ValueError(
                        "Une séance a changé. Aucun ajustement n’a été appliqué."
                    )
                updated.append(
                    {**_session_to_dict(after), "revision": item.revision + 1}
                )
            result = {
                "applied": True,
                "id": identifier,
                "operation_id": operation_id,
                "sessions": updated,
                "remote": "Le planning Arete est enregistré. Garmin doit être vérifié ou exporté séparément ; le calendrier suit sa synchronisation habituelle.",
            }
            con.execute(
                f"UPDATE app.plan_change_sets SET state='applied',operation_id=?,receipt_json=? WHERE {_COORD_OWNER} AND id=? AND state='pending' RETURNING id",
                [operation_id, json.dumps(result, ensure_ascii=False), identifier],
            )
            _check_change_deadline(started)
    except duckdb.TransactionException as exc:
        raise ValueError(
            "Le planning a changé dans une autre fenêtre. Relis la proposition avant de continuer."
        ) from exc
    plan_changes.touch()
    return result


def dismiss_plan_changes(identifier: str, revision: int) -> dict[str, Any]:
    UUID(identifier)
    with transaction() as con:
        found = con.execute(
            f"UPDATE app.plan_change_sets SET state='dismissed' WHERE {_COORD_OWNER} AND id=? AND revision=? AND state='pending' RETURNING id",
            [identifier, revision],
        ).fetchone()
        if not found:
            raise ValueError("Cette proposition n’est plus en attente.")
    return get_plan_changes(identifier)
