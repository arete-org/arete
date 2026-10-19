"""Durable outbound workout state machine; remote writes are never replayed blindly."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable
from datetime import date, datetime, timedelta
from time import monotonic
from typing import Any
from uuid import uuid4

from arete.dataio.db import db_connection, transaction
from arete.garmin.workouts import canonical, convert, matches
from arete.services.documents import DocumentError
from arete.services.prescriptions import Prescription, Step, Target, describe
from arete.services.settings import utc_now

MAX_BATCH_SESSIONS = 5
MAX_BATCH_REQUESTS = 60
MAX_EXPORT_SECONDS = 120
MAX_EXPORT_REQUESTS = 12
REQUEST_TIMEOUT = 10.0
MAX_REMOTE_WORKOUTS = 500
MAX_DEVICES = 50
MAX_STATUS_ROWS = 500
MAX_INSPECT_SESSIONS = 50
WORKOUT = "/workout-service/workout"
logger = logging.getLogger(__name__)
SCHEDULE = "/workout-service/schedule"


def _schedule_date(scheduled: Any, workout_id: int) -> date:
    """Validate schedule readback before trusting it for a remote mutation.

    Schedule details can use calendarDate and a nested workout, unlike the
    monthly calendar's flat date/workoutId. Never infer a missing remote date
    from our intended date: that would hide a real conflict.
    """
    if not isinstance(scheduled, dict):
        raise DocumentError("Réponse de programmation Garmin invalide.")
    nested = scheduled.get("workout")
    identifiers = [scheduled.get("workoutId")]
    if isinstance(nested, dict):
        identifiers.append(nested.get("workoutId"))
    identifiers = [value for value in identifiers if value is not None]
    if not identifiers or any(str(value) != str(workout_id) for value in identifiers):
        raise DocumentError("La programmation Garmin ne correspond pas à cette séance.")
    values = [
        scheduled[key]
        for key in ("calendarDate", "scheduledDate", "date")
        if scheduled.get(key) is not None
    ]
    if not values or any(not isinstance(value, str) for value in values):
        raise DocumentError("Date de programmation Garmin absente ou invalide.")
    try:
        days = [date.fromisoformat(value[:10]) for value in values]
    except ValueError as exc:
        raise DocumentError("Date de programmation Garmin invalide.") from exc
    if len(set(days)) != 1:
        raise DocumentError("Dates de programmation Garmin contradictoires.")
    return days[0]


def _get(con, session_id: int) -> dict | None:
    cursor = con.execute(
        "SELECT * FROM app.visible_garmin_exports WHERE session_id=?", [session_id]
    )
    row = cursor.fetchone()
    if not row:
        return None
    result = dict(zip([c[0] for c in cursor.description], row, strict=True))
    for field in ("remote_snapshot", "intended_payload"):
        if result[field]:
            result[field] = json.loads(result[field])
    return result


def _update(session_id: int, operation_id: str, **fields) -> dict:
    allowed = {
        "state",
        "phase",
        "workout_id",
        "schedule_id",
        "fingerprint",
        "remote_snapshot",
        "intended_payload",
        "intended_date",
        "remote_date",
        "device_id",
        "error",
    }
    assert fields.keys() <= allowed
    values = [
        json.dumps(v)
        if k in {"remote_snapshot", "intended_payload"} and v is not None
        else v
        for k, v in fields.items()
    ]
    with db_connection() as con:
        changed = con.execute(
            "UPDATE app.garmin_exports SET "
            + ",".join(f"{key}=?" for key in fields)
            + ",updated_at=current_timestamp WHERE athlete_id=getvariable('arete_athlete_id') AND deleted_at IS NULL AND session_id=? AND operation_id=? RETURNING session_id",
            [*values, session_id, operation_id],
        ).fetchone()
        if not changed:
            raise DocumentError(
                "Une vérification plus récente possède cette opération. Recharge son état."
            )
        result = _get(con, session_id)
    assert result
    return result


def statuses() -> list[dict]:
    with db_connection() as con:
        rows = con.execute(
            "SELECT e.session_id, s.description, s.date FROM app.visible_garmin_exports e "
            "LEFT JOIN app.visible_planned_sessions s ON s.id=e.session_id "
            "ORDER BY e.updated_at DESC LIMIT ?",
            [MAX_STATUS_ROWS + 1],
        ).fetchall()
        if len(rows) > MAX_STATUS_ROWS:
            raise DocumentError(
                "Plus de 500 exports : réduis l’historique avant de continuer."
            )
        result = []
        for session_id, description, day in rows:
            state = _get(con, session_id)
            assert state is not None, "A listed export must be readable"
            effective_day = day or state.get("intended_date")
            result.append(
                {
                    **{
                        k: v
                        for k, v in state.items()
                        if k not in {"remote_snapshot", "intended_payload"}
                    },
                    "description": description
                    or (state.get("intended_payload") or {}).get("workoutName"),
                    "date": effective_day.isoformat() if effective_day else None,
                }
            )
        return result


def _outcome(exchange: Exchange, window: int | None) -> str:
    """``uncertain`` only when a request of the open write window was sent.

    ``window`` is the exchange's request count when the write window opened.
    Whatever the error (budget, reservation, permission), a write that never
    left leaves nothing ambiguous; one that left may have reached Garmin.
    """
    return "failed" if window is None or exchange.calls == window else "uncertain"


class Exchange:
    def __init__(
        self,
        client=None,
        *,
        deadline: float | None = None,
        max_calls: int = MAX_EXPORT_REQUESTS,
        on_progress: Callable[[dict], None] | None = None,
    ):
        if client is None:
            from arete.garmin.client import GarminClient

            client = GarminClient()
        self.client = client
        self.deadline = min(deadline or float("inf"), monotonic() + MAX_EXPORT_SECONDS)
        self.max_calls = max_calls
        self.on_progress = on_progress
        self.session: dict | None = None
        self.session_calls = 0
        self.calls = 0
        self.reservation: tuple[int, str] | None = None

    def call(self, method: str, path: str, payload: Any = None):
        remaining = self.deadline - monotonic()
        if (
            self.calls >= self.max_calls
            or self.session_calls >= MAX_EXPORT_REQUESTS
            or remaining <= 0
            # A write gets its whole timeout, or is not sent at all.
            or (method != "GET" and remaining < REQUEST_TIMEOUT)
        ):
            raise DocumentError(
                "Limite de synchronisation atteinte ; vérifie l’état avant de reprendre."
            )
        if self.reservation:
            with db_connection() as con:
                row = con.execute(
                    "SELECT operation_id,state FROM app.visible_garmin_exports WHERE session_id=?",
                    [self.reservation[0]],
                ).fetchone()
            if not row or row != (self.reservation[1], "working"):
                raise DocumentError(
                    "La réservation Garmin a changé ; aucune autre requête envoyée."
                )
        self.calls += 1
        self.session_calls += 1
        return self.client.workout_request(
            method, path, timeout=min(REQUEST_TIMEOUT, remaining), payload=payload
        )

    def update(self, session_id: int, operation_id: str, **fields) -> dict:
        result = _update(session_id, operation_id, **fields)
        if self.on_progress and self.session:
            self.on_progress({"session": self.session, "export": public_status(result)})
        return result


def devices(client=None, *, exchange: Exchange | None = None) -> list[dict]:
    exchange = exchange or Exchange(client)
    raw = exchange.call("GET", "/device-service/deviceregistration/devices")
    if not isinstance(raw, list) or len(raw) > MAX_DEVICES:
        raise DocumentError("Liste des appareils Garmin invalide ou trop grande.")
    # Only claim documented support; unknown models can still use Connect's UI.
    result = []
    for device in raw:
        name = str(
            device.get("productDisplayName")
            or device.get("displayName")
            or "Appareil Garmin"
        )
        normalized = name.lower().replace("ē", "e").replace("®", "")
        supported = (
            ["running", "cycling", "swimming", "strength"]
            if "fenix 8" in normalized or "forerunner 965" in normalized
            else []
        )
        result.append(
            {
                "id": device["deviceId"],
                "name": name,
                "sports": supported,
                "compatibility": "documented" if supported else "unknown",
                "documentation": (
                    "https://www8.garmin.com/manuals/webhelp/GUID-0221611A-992D-495E-8DED-1DD448F7A066/EN-US/GUID-92B2952D-C8D5-4F66-9FBF-5A00549F0390.html"
                    if "forerunner 965" in normalized
                    else "https://www8.garmin.com/manuals/webhelp/GUID-EECCAC99-90D6-4AB1-9A3A-EC433D3365E2/EN-US/GUID-3AA7B50B-EBE5-4A29-A15A-316849BA9BDB.html"
                )
                if supported
                else None,
            }
        )
    return result


def _paired(exchange: Exchange, device_id: int, sport: str) -> int | None:
    """The watch if still paired and documented for the sport, else None."""
    target = next((d for d in devices(exchange=exchange) if d["id"] == device_id), None)
    if target and sport in target["sports"]:
        return device_id
    logger.warning(
        "Watch %s %s: sending to Garmin Connect only",
        device_id,
        "unpaired" if target is None else f"not documented for {sport}",
    )
    return None


def public_status(state: dict | None) -> dict | None:
    if state is None:
        return None
    return {
        k: (v.isoformat() if isinstance(v, date | datetime) else v)
        for k, v in state.items()
        if k not in {"remote_snapshot", "intended_payload"}
    }


def described_prescription(session) -> Prescription | None:
    """Steps read from a described tempo or interval run (running only).

    Only where ARE-87 refuses the type's template: a description the grammar
    reads entirely counts as explicit steps; anything unread keeps that block.
    """
    from arete.garmin.workout_structure import needs_explicit_steps
    from arete.services.prescriptions import prescription_from_description

    if session.prescription or session.structure_json:
        return None
    if not needs_explicit_steps(session.sport, session.session_type.value):
        return None
    return prescription_from_description(session.description or "", session.sport)


def session_prescription(session) -> tuple[Prescription, str]:
    """The steps to show and send, and their source: explicit, parsed or derived."""
    if session.prescription:
        return Prescription.model_validate(session.prescription), "explicit"
    parsed = described_prescription(session)
    if parsed is not None:
        return parsed, "parsed"
    from arete.dataio.settings import athlete_zone_model, get_user_settings
    from arete.garmin.workout_structure import Repeat, derive

    settings = get_user_settings() or {}
    blocks = derive(
        session, athlete_zone_model(), settings.get("threshold_pace_sec_km")
    )

    def adapt(block) -> Step:
        if isinstance(block, Repeat):
            return Step(
                kind="repeat",
                repeat=block.iterations,
                steps=[adapt(s) for s in block.steps],
            )
        target = None
        if block.hr_low is not None and block.hr_high is not None:
            target = Target(kind="heart_rate_bpm", low=block.hr_low, high=block.hr_high)
        elif block.pace_fast_sec_km and block.pace_slow_sec_km:
            target = Target(
                kind="pace_sec_km",
                low=block.pace_fast_sec_km,
                high=block.pace_slow_sec_km,
            )
        return Step(
            kind="effort" if block.kind == "interval" else block.kind,
            duration_kind="meters" if block.distance_m else "seconds",
            value=block.distance_m or block.duration_sec,
            target=target,
        )

    return Prescription(steps=[adapt(b) for b in blocks]), "derived"


#: A session's export view and, when it can be built, its payload, date,
#: sport and revision: what ``export`` sends, built once.
Prepared = tuple[dict, tuple[dict, date, str, int] | None]


def inspect_session(session_id: int, *, include_steps: bool = True) -> dict:
    return _inspect(session_id, include_steps=include_steps)[0]


def prepare(session_id: int) -> Prepared:
    """The view and payload an export decides on and sends, read once."""
    return _inspect(session_id, include_steps=False)


def _inspect(session_id: int, *, include_steps: bool) -> Prepared:
    from arete.garmin.repository import GarminRepository
    from arete.garmin.workout_structure import NotPushable, ensure_template_fits
    from arete.services.planning import _session_to_dict

    session = GarminRepository().get_planned_session(session_id)
    if session is None:
        raise DocumentError("Cette séance n’existe plus.")
    result = _session_to_dict(session)
    result.update(
        prescription=None,
        derived=False,
        parsed=False,
        needs_steps=False,
        exportable=False,
        reason=None,
    )
    built = None
    try:
        prescription, source = session_prescription(session)
        result.update(
            summary=describe(prescription),
            derived=source == "derived",
            parsed=source == "parsed",
        )
        if include_steps:
            result["prescription"] = prescription.model_dump(mode="json")
        if source == "derived":
            try:
                ensure_template_fits(session)
            except NotPushable:
                # Shown as a generic estimate; every push goes through this status.
                result["needs_steps"] = True
                raise
        built = _payload(session_id)
        result["exportable"] = session.status.value in {"pending", "modified"}
        if not result["exportable"]:
            result["reason"] = "Cette séance est terminée ou sautée."
    except ValueError as exc:
        result["reason"] = str(exc)
    with db_connection() as con:
        state = _get(con, session_id)
    return {"session": result, "export": public_status(state)}, built


def inspect_sessions(session_ids: list[int]) -> dict:
    """Several cards' views in one read; a session that no longer exists is
    reported beside the others instead of failing the whole list."""
    ids = list(dict.fromkeys(session_ids))
    assert 1 <= len(ids) <= MAX_INSPECT_SESSIONS
    workouts, errors = [], {}
    for session_id in ids:
        try:
            workouts.append(inspect_session(session_id))
        except DocumentError as exc:
            errors[str(session_id)] = str(exc)
    return {"workouts": workouts, "errors": errors}


def _payload(session_id: int, *, upload: bool = True) -> tuple[dict, date, str, int]:
    """The workout Garmin should hold; ``upload=False`` only identifies a copy."""
    from arete.dataio.settings import athlete_zone_model, get_user_settings
    from arete.features.hr_zones import ZoneModel
    from arete.garmin.repository import GarminRepository
    from arete.garmin.workout_structure import (
        derive,
        describe_fr,
        ensure_template_fits,
    )
    from arete.garmin.workouts import build_payload

    session = GarminRepository().get_planned_session(session_id)
    if session is None:
        raise DocumentError("Cette séance n’existe plus.")
    settings = get_user_settings() or {}
    # A copy sent before ARE-98 was the template: identify it as such.
    prescription = (
        Prescription.model_validate(session.prescription)
        if session.prescription
        else described_prescription(session)
        if upload
        else None
    )
    if prescription is not None:
        ranges = (
            ZoneModel.from_reference(
                lthr=settings.get("lthr"), max_hr=settings.get("max_hr")
            ).ranges()
            if settings.get("lthr") or settings.get("max_hr")
            else None
        )
        payload = convert(
            session_id,
            session.description or "Séance Arete",
            session.sport,
            prescription,
            hr_ranges=ranges,
        )
    else:
        if upload:
            ensure_template_fits(session)
        blocks = derive(
            session, athlete_zone_model(), settings.get("threshold_pace_sec_km")
        )
        payload = build_payload(
            blocks,
            name=f"Arete — {session.description or describe_fr(blocks)}",
            description=f"ARETE_SESSION:{session_id}",
            sport=session.sport,
        )
    return payload, session.date, session.sport, session.revision


def _adopt_legacy(
    session_id: int, state: dict, payload: dict, exchange: Exchange
) -> dict:
    """Reserve before reading old IDs so every writer shares the same owner."""
    if state["workout_id"]:
        return state
    with db_connection() as con:
        row = con.execute(
            "SELECT garmin_workout_id,garmin_schedule_id FROM app.visible_planned_sessions WHERE id=?",
            [session_id],
        ).fetchone()
    if not row or not any(row):
        return state
    if not all(row):
        raise DocumentError(
            "Ancien export incomplet : vérifie le calendrier Garmin avant de poursuivre."
        )
    remote = exchange.call("GET", f"{WORKOUT}/{row[0]}")
    expected = {k: v for k, v in payload.items() if k != "description"}
    if not matches(expected, remote):
        raise DocumentError(
            "L’ancien export Garmin diffère de la séance ; aucune copie créée."
        )
    scheduled = exchange.call("GET", f"{SCHEDULE}/{row[1]}")
    remote_date = _schedule_date(scheduled, int(row[0]))
    return exchange.update(
        session_id,
        state["operation_id"],
        workout_id=int(row[0]),
        schedule_id=int(row[1]),
        remote_snapshot=remote,
        remote_date=remote_date,
    )


def _fingerprint(payload: dict, day: date) -> str:
    return hashlib.sha256(
        json.dumps([payload, day.isoformat()], sort_keys=True).encode()
    ).hexdigest()


def _claim(
    session_id: int, *, reconcile: bool = False, revision: int | None = None
) -> dict:
    with transaction() as con:
        if revision is not None:
            locked = con.execute(
                "UPDATE app.planned_sessions SET revision=revision WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id=? AND revision=?) RETURNING id",
                [session_id, revision],
            ).fetchone()
            if not locked:
                raise DocumentError(
                    "La séance a changé avant l’export. Recharge le planning."
                )
        old = _get(con, session_id)
        clock = con.execute("SELECT current_timestamp::TIMESTAMP").fetchone()
        assert clock is not None
        now = clock[0]
        if (
            old
            and old["state"] == "working"
            and old["updated_at"] > now - timedelta(seconds=MAX_EXPORT_SECONDS + 30)
        ):
            raise DocumentError(
                "Une synchronisation de cette séance est déjà en cours."
            )
        if (
            old
            and old["state"] in {"working", "uncertain", "conflict"}
            and not reconcile
        ):
            raise DocumentError(
                "Résultat Garmin indéterminé ou conflit : lance « Vérifier Garmin » avant de renvoyer."
            )
        if old:
            con.execute(
                "UPDATE app.garmin_exports SET state='working',operation_id=?,updated_at=current_timestamp WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (session_id=?) RETURNING session_id",
                [str(uuid4()), session_id],
            )
        else:
            if reconcile:
                raise DocumentError("Aucun export à vérifier.")
            visible = con.execute(
                "SELECT 1 FROM app.visible_planned_sessions WHERE id=?", [session_id]
            ).fetchone()
            if not visible:
                raise DocumentError("Cette séance n’existe plus.")
            con.execute(
                "INSERT INTO app.garmin_exports (session_id,operation_id,state) VALUES (?,?,'working')",
                [session_id, str(uuid4())],
            )
        result = _get(con, session_id)
    assert result
    return result


def export(
    session_id: int,
    device_id: int | None = None,
    *,
    client=None,
    exchange: Exchange | None = None,
    on_progress: Callable[[dict], None] | None = None,
    expected_revision: int | None = None,
    prepared: Prepared | None = None,
    keep_device: bool = False,
) -> dict:
    """Send the session; ``prepared`` is its view and payload when already read
    (the claim's revision lock still refuses a session changed since).

    ``keep_device`` (automatic re-exports) sends it to the watch the copy was
    last sent to, read under the claim so a newer manual choice wins; a watch
    no longer paired or compatible falls back to Garmin Connect only.
    """
    view, built = prepared or prepare(session_id)
    if built is None:
        raise DocumentError(view["session"]["reason"] or "Séance non exportable.")
    payload, day, sport, revision = built
    if expected_revision is not None and revision != expected_revision:
        raise DocumentError("La séance a changé. Recharge son contenu avant l’envoi.")
    exchange = exchange or Exchange(client, on_progress=on_progress)
    exchange.reservation = None
    exchange.session_calls = 0
    exchange.session = view["session"]
    if not view["session"]["exportable"]:
        raise DocumentError(view["session"]["reason"])
    if device_id is not None:
        target = next(
            (d for d in devices(exchange=exchange) if d["id"] == device_id), None
        )
        if not target or sport not in target["sports"]:
            raise DocumentError(
                "Compatibilité de cette montre non vérifiée pour ce sport. Choisis Garmin Connect uniquement."
            )
    state = _claim(session_id, revision=revision)
    exchange.reservation = (session_id, state["operation_id"])
    if state["deleted"]:
        exchange.update(session_id, state["operation_id"], state="pending_removal")
        raise DocumentError("Cette séance a été supprimée ; utilise le retrait Garmin.")
    writing: int | None = None  # requests sent before the open write
    try:
        if keep_device and state["device_id"] is not None:
            device_id = _paired(exchange, int(state["device_id"]), sport)
        exchange.update(
            session_id,
            state["operation_id"],
            intended_payload=payload,
            intended_date=day,
            device_id=device_id,
            error=None,
        )
        state = _adopt_legacy(session_id, state, payload, exchange)
        workout_id = state["workout_id"]
        schedule_id = state["schedule_id"]
        if workout_id:
            remote = exchange.call("GET", f"{WORKOUT}/{workout_id}")
            if state["remote_snapshot"] and canonical(remote) != canonical(
                state["remote_snapshot"]
            ):
                return exchange.update(
                    session_id,
                    state["operation_id"],
                    state="conflict",
                    error="L’entraînement a changé dans Garmin Connect. Il n’a pas été écrasé.",
                )
            if not matches(payload, remote):
                exchange.update(session_id, state["operation_id"], phase="updating")
                writing = exchange.calls
                exchange.call(
                    "PUT",
                    f"{WORKOUT}/{workout_id}",
                    {**remote, **payload, "workoutId": workout_id},
                )
                exchange.update(session_id, state["operation_id"], phase="updated")
                writing = None
        else:
            exchange.update(session_id, state["operation_id"], phase="creating")
            writing = exchange.calls
            created = exchange.call("POST", WORKOUT, payload)
            workout_id = int(created["workoutId"])
            exchange.update(
                session_id,
                state["operation_id"],
                workout_id=workout_id,
                phase="created",
            )
            writing = None
        remote = exchange.call("GET", f"{WORKOUT}/{workout_id}")
        if not matches(payload, remote):
            return exchange.update(
                session_id,
                state["operation_id"],
                state="conflict",
                error="La relecture Garmin ne correspond pas à la prescription demandée.",
            )
        exchange.update(session_id, state["operation_id"], remote_snapshot=remote)
        if schedule_id:
            scheduled = exchange.call("GET", f"{SCHEDULE}/{schedule_id}")
            remote_date = _schedule_date(scheduled, workout_id)
            if state["remote_date"] and remote_date != state["remote_date"]:
                return exchange.update(
                    session_id,
                    state["operation_id"],
                    state="conflict",
                    error="La date a changé dans Garmin Connect.",
                )
            if remote_date != day:
                exchange.update(session_id, state["operation_id"], phase="unscheduling")
                writing = exchange.calls
                exchange.call("DELETE", f"{SCHEDULE}/{schedule_id}")
                _verify_absent(exchange, f"{SCHEDULE}/{schedule_id}")
                exchange.update(
                    session_id,
                    state["operation_id"],
                    schedule_id=None,
                    remote_date=None,
                    phase="unscheduled",
                )
                writing = None
                schedule_id = None
        if not schedule_id:
            exchange.update(session_id, state["operation_id"], phase="scheduling")
            writing = exchange.calls
            scheduled = exchange.call(
                "POST", f"{SCHEDULE}/{workout_id}", {"date": day.isoformat()}
            )
            schedule_id = int(scheduled["workoutScheduleId"])
            exchange.update(
                session_id,
                state["operation_id"],
                schedule_id=schedule_id,
                phase="scheduled",
            )
            writing = None
        verified = exchange.call("GET", f"{SCHEDULE}/{schedule_id}")
        if _schedule_date(verified, workout_id) != day:
            return exchange.update(
                session_id,
                state["operation_id"],
                state="conflict",
                error="La programmation Garmin n’a pas pu être vérifiée.",
            )
        exchange.update(
            session_id,
            state["operation_id"],
            remote_date=day,
            fingerprint=_fingerprint(payload, day),
            phase="scheduled",
        )
        already_pushed = (
            state["phase"] == "pushed"
            and state["device_id"] == device_id
            and state["fingerprint"] == _fingerprint(payload, day)
        )
        if device_id is not None and not already_pushed:
            exchange.update(session_id, state["operation_id"], phase="pushing")
            writing = exchange.calls
            exchange.call(
                "POST",
                "/device-service/devicemessage/messages",
                [
                    {
                        "deviceId": device_id,
                        "messageUrl": f"workout-service/workout/FIT/{workout_id}",
                        "messageType": "workouts",
                        "groupName": None,
                        "messageName": payload["workoutName"],
                        "priority": 1,
                        "fileType": "FIT",
                        "metaDataId": workout_id,
                    }
                ],
            )
            exchange.update(session_id, state["operation_id"], phase="pushed")
            writing = None
        with db_connection() as con:
            con.execute(
                "UPDATE app.planned_sessions SET garmin_workout_id=?,garmin_schedule_id=?,garmin_pushed_at=? WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id=?) RETURNING id",
                # Every source of steps (explicit, parsed, derived) gets its
                # push time and ids, so a card reads them alike.
                # Naive UTC: DuckDB stores an aware value (and current_timestamp)
                # in its session TimeZone, which follows the process TZ.
                [
                    str(workout_id),
                    str(schedule_id),
                    utc_now().replace(tzinfo=None),
                    session_id,
                ],
            )
        return exchange.update(
            session_id,
            state["operation_id"],
            state="transfer_requested" if device_id else "scheduled",
            phase="pushed" if device_id else "scheduled",
        )
    except Exception as exc:
        return exchange.update(
            session_id,
            state["operation_id"],
            state=_outcome(exchange, writing),
            error=f"{type(exc).__name__}: {exc}. Aucun renvoi automatique.",
        )


def reconcile(session_id: int, *, client=None, deadline: float | None = None) -> dict:
    state = _claim(session_id, reconcile=True)
    exchange = Exchange(client, deadline=deadline)
    exchange.reservation = (session_id, state["operation_id"])
    try:
        workout_id = state["workout_id"]
        if not workout_id:
            candidates: list[dict] = []
            for start in range(0, MAX_REMOTE_WORKOUTS, 100):
                page = exchange.call(
                    "GET", f"/workout-service/workouts?start={start}&limit=100"
                )
                if not isinstance(page, list) or len(page) > 100:
                    raise DocumentError("Réponse Garmin inattendue.")
                candidates.extend(
                    w
                    for w in page
                    if w.get("description") == f"ARETE_SESSION:{session_id}"
                )
                if len(page) < 100:
                    break
            if len(candidates) != 1:
                raise DocumentError(
                    "Impossible d’identifier un entraînement unique. Vérifie Garmin Connect ; aucun nouvel entraînement ne sera créé automatiquement."
                )
            workout_id = int(candidates[0]["workoutId"])
        try:
            remote = exchange.call("GET", f"{WORKOUT}/{workout_id}")
        except LookupError:
            if state["deleted"] and state["phase"] == "removing":
                return _update(
                    session_id,
                    state["operation_id"],
                    state="removed",
                    workout_id=None,
                    schedule_id=None,
                    error=None,
                )
            raise
        expected = state["intended_payload"]
        if not expected or not matches(expected, remote):
            return _update(
                session_id,
                state["operation_id"],
                state="conflict",
                error="Le contenu Garmin diffère du contenu attendu.",
            )
        schedule_id = state["schedule_id"]
        remote_date = state["remote_date"]
        if state["phase"] in {"unscheduling", "removing"} and schedule_id:
            try:
                scheduled = exchange.call("GET", f"{SCHEDULE}/{schedule_id}")
                remote_date = _schedule_date(scheduled, workout_id)
            except LookupError:
                schedule_id = None
                remote_date = None
        elif state["phase"] == "scheduling":
            day = state["intended_date"] or remote_date
            calendar = exchange.call(
                "GET", f"/calendar-service/year/{day.year}/month/{day.month - 1}"
            )
            entries = calendar.get("calendarItems", [])
            if len(entries) > 1000:
                raise DocumentError("Calendrier Garmin trop volumineux.")
            found = [
                e
                for e in entries
                if int(e.get("workoutId") or 0) == workout_id
                and str(e.get("date", ""))[:10] == day.isoformat()
            ]
            if len(found) != 1:
                raise DocumentError(
                    "Programmation indéterminée ; vérification manuelle requise dans Garmin Connect."
                )
            schedule_id = int(found[0].get("workoutScheduleId") or found[0]["id"])
            remote_date = day
        elif schedule_id:
            scheduled = exchange.call("GET", f"{SCHEDULE}/{schedule_id}")
            remote_date = _schedule_date(scheduled, workout_id)
        expected_date = state["remote_date"] or state["intended_date"]
        if schedule_id and expected_date and remote_date != expected_date:
            return _update(
                session_id,
                state["operation_id"],
                state="conflict",
                error="La date distante a été modifiée.",
            )
        if state["phase"] == "pushing":
            return _update(
                session_id,
                state["operation_id"],
                state="uncertain",
                error="Le calendrier est vérifiable, mais le transfert vers la montre a un résultat inconnu. Vérifie la montre avant toute nouvelle demande.",
            )
        return _update(
            session_id,
            state["operation_id"],
            state="pending_removal" if state["deleted"] else "ready",
            workout_id=workout_id,
            schedule_id=schedule_id,
            remote_snapshot=remote,
            remote_date=remote_date,
            error=None,
        )
    except Exception as exc:
        return _update(
            session_id, state["operation_id"], state="uncertain", error=str(exc)
        )


def _verify_absent(exchange: Exchange, path: str) -> None:
    try:
        exchange.call("GET", path)
    except LookupError:
        return
    raise DocumentError("La suppression distante n’est pas confirmée par relecture.")


def remove(session_id: int, *, client=None) -> dict:
    """Take the copy off Garmin: for a session deleted or skipped in Arete only.

    A skipped one goes through ``withdraw_skipped``, which adopts a copy sent
    before the export table existed instead of forgetting it on Garmin.
    """
    if _status(session_id) == "skipped":
        return withdraw_skipped(session_id, client=client)
    return _remove(session_id, client=client)


def _remove(
    session_id: int,
    *,
    client=None,
    exchange: Exchange | None = None,
    skipped: bool = False,
) -> dict:
    state = _claim(session_id)
    if not state["deleted"] and not skipped:
        _update(session_id, state["operation_id"], state="ready")
        raise DocumentError(
            "Le retrait est réservé aux séances supprimées ou sautées dans Arete."
        )
    exchange = exchange or Exchange(client)
    exchange.session_calls = 0
    exchange.reservation = (session_id, state["operation_id"])
    writing: int | None = None  # requests sent before the open write
    try:
        workout_id = state["workout_id"]
        if workout_id:
            remote = exchange.call("GET", f"{WORKOUT}/{workout_id}")
            if (
                remote.get("description") != f"ARETE_SESSION:{session_id}"
                and not state["remote_snapshot"]
            ) or (
                state["remote_snapshot"]
                and canonical(remote) != canonical(state["remote_snapshot"])
            ):
                return _update(
                    session_id,
                    state["operation_id"],
                    state="conflict",
                    error="L’entraînement distant a changé ; retrait bloqué.",
                )
            if state["schedule_id"]:
                calendar = exchange.call("GET", f"{SCHEDULE}/{state['schedule_id']}")
                remote_date = _schedule_date(calendar, workout_id)
                if state["remote_date"] and remote_date != state["remote_date"]:
                    return _update(
                        session_id,
                        state["operation_id"],
                        state="conflict",
                        error="La programmation distante a changé ; retrait bloqué.",
                    )
            _update(session_id, state["operation_id"], phase="removing")
            writing = exchange.calls
            if state["schedule_id"]:
                exchange.call("DELETE", f"{SCHEDULE}/{state['schedule_id']}")
                _verify_absent(exchange, f"{SCHEDULE}/{state['schedule_id']}")
                _update(session_id, state["operation_id"], schedule_id=None)
                writing = exchange.calls  # its removal is verified
            exchange.call("DELETE", f"{WORKOUT}/{workout_id}")
            _verify_absent(exchange, f"{WORKOUT}/{workout_id}")
        with db_connection() as con:
            con.execute(
                "UPDATE app.planned_sessions SET garmin_workout_id=NULL,garmin_schedule_id=NULL,garmin_pushed_at=NULL WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id=?) RETURNING id",
                [session_id],
            )
        return _update(
            session_id,
            state["operation_id"],
            state="removed",
            workout_id=None,
            schedule_id=None,
            error=None,
        )
    except Exception as exc:
        return _update(
            session_id,
            state["operation_id"],
            state=_outcome(exchange, writing),
            error=str(exc),
        )


def update_session(
    session_id: int,
    revision: int,
    day: date,
    description: str,
    prescription: Prescription,
) -> None:
    # Browser and coach edits share revision/export checks in the repository.
    from arete.garmin.repository import GarminRepository

    try:
        changed = GarminRepository().update_planned_session_fields(
            session_id,
            expected_revision=revision,
            date=day,
            description=description,
            prescription=prescription.model_dump(mode="json"),
            garmin_pushed_at=None,
            target_duration_min=None,
            target_distance_km=None,
            target_hr_zone=None,
            target_intensity=None,
        )
    except ValueError as exc:
        raise DocumentError(str(exc)) from exc
    if not changed:
        raise DocumentError(
            "La séance a changé ou n’existe plus. Recharge le planning."
        )


def export_batch(
    session_ids: list[int],
    device_id: int | None = None,
    *,
    client=None,
    deadline: float | None = None,
    on_progress: Callable[[dict], None] | None = None,
    revisions: list[int] | None = None,
) -> dict:
    if (
        not 1 <= len(session_ids) <= MAX_BATCH_SESSIONS
        or len(set(session_ids)) != len(session_ids)
        or any(i <= 0 for i in session_ids)
    ):
        raise DocumentError("Sélectionne entre 1 et 5 séances distinctes.")
    if revisions is not None and len(revisions) != len(session_ids):
        raise DocumentError("Une révision est requise par séance.")
    exchange = Exchange(
        client, deadline=deadline, max_calls=MAX_BATCH_REQUESTS, on_progress=on_progress
    )
    results = []
    for index, session_id in enumerate(session_ids):
        try:
            state = export(
                session_id,
                device_id,
                exchange=exchange,
                expected_revision=revisions[index] if revisions else None,
            )
            results.append(public_status(state))
        except (ValueError, ConnectionError, TimeoutError, PermissionError) as exc:
            return {
                "results": results,
                "blocked": session_id,
                "error": str(exc),
                "not_attempted": session_ids[index + 1 :],
            }
        if state["state"] not in {"scheduled", "transfer_requested"}:
            return {
                "results": results,
                "blocked": session_id,
                "error": state["error"] or "Envoi interrompu.",
                "not_attempted": session_ids[index + 1 :],
            }
    return {"results": results, "not_attempted": []}


def _status(session_id: int) -> str | None:
    with db_connection() as con:
        row = con.execute(
            "SELECT status FROM app.visible_planned_sessions WHERE id=?", [session_id]
        ).fetchone()
    return row[0] if row else None


def export_state(session_id: int) -> dict | None:
    """The session's export row as the views show it; reads no remote state."""
    with db_connection() as con:
        return public_status(_get(con, session_id))


def on_garmin(session_id: int) -> bool:
    """Whether Garmin may hold a copy of the session; reads no remote state."""
    with db_connection() as con:
        legacy = con.execute(
            "SELECT garmin_workout_id,garmin_schedule_id FROM app.visible_planned_sessions WHERE id=?",
            [session_id],
        ).fetchone()
        state = _get(con, session_id)
    if state is not None:
        return state["state"] != "removed" and bool(
            state["workout_id"] or state["schedule_id"]
        )
    return bool(legacy and any(legacy))


def sent_as_is(prepared: Prepared) -> bool:
    """Whether the verified copy on Garmin is the session as it is now.

    Compares the fingerprint of the last confirmed export with today's payload,
    so a session already sent (by hand the evening before) costs no request.
    """
    view, built = prepared
    state = view["export"]
    if built is None or not state:
        return False
    if state["state"] not in {"scheduled", "transfer_requested"}:
        return False
    payload, day, _, _ = built
    return bool(state["fingerprint"] == _fingerprint(payload, day))


def withdraw_skipped(
    session_id: int, *, client=None, exchange: Exchange | None = None
) -> dict:
    """Take a skipped session off Garmin, whatever the source of its steps."""
    from arete.garmin.repository import GarminRepository

    session = GarminRepository().get_planned_session(session_id)
    if session is None or session.status.value != "skipped":
        raise DocumentError("Retrait réservé aux séances sautées.")
    exchange = exchange or Exchange(client)
    with db_connection() as con:
        existing = _get(con, session_id)
    if existing is None or not existing["workout_id"]:
        # Only identifies a legacy copy to remove (ids on the session, none on
        # the export row): a template sent before the described-session guard
        # must stay withdrawable.
        payload, _, _, revision = _payload(session_id, upload=False)
        state = _claim(session_id, revision=revision)
        exchange.session_calls = 0
        exchange.reservation = (session_id, state["operation_id"])
        try:
            state = _adopt_legacy(session_id, state, payload, exchange)
            # Adoption verifies content before claiming ownership of old copies.
            _update(
                session_id,
                state["operation_id"],
                intended_payload=payload,
                state="ready",
            )
        except Exception as exc:
            _update(session_id, state["operation_id"], state="conflict", error=str(exc))
            raise
    return _remove(session_id, exchange=exchange, skipped=True)
