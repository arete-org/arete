"""Athlete-owned automation definitions and durable occurrence lifecycle."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo

import duckdb
from pydantic import Field

from arete.dataio.db import db_connection, transaction
from arete.dataio.settings import get_user_settings
from arete.services.automation_schedule import (
    MAX_ACTIVE_AUTOMATIONS,
    MAX_ACTIVE_SECONDS,
    MAX_DAILY_RUNS,
    MAX_RESUMES,
    MAX_SCAN,
    MAX_SCHEDULE_DAYS,
    SEGMENT_SECONDS,
    AfterSession,
    AutomationInput,
    Once,
    StrictModel,
    next_due,
)
from arete.services.settings import utc_now

OWNER = "athlete_id=getvariable('arete_athlete_id') AND deleted_at IS NULL"
TERMINAL = frozenset(
    {"completed", "failed", "interrupted", "expired", "cancelled", "missed"}
)
MAX_PAGE = 50


class Conflict(ValueError):
    """A stale or ambiguous operation must be reloaded, never replayed."""


class Update(AutomationInput):
    revision: int = Field(ge=1)


class StateChange(StrictModel):
    revision: int = Field(ge=1)
    state: Literal["active", "paused"]


def rows(result) -> list[dict[str, Any]]:
    keys = [c[0] for c in result.description]
    return [dict(zip(keys, row, strict=True)) for row in result.fetchall()]


def public(record: dict) -> dict:
    result = {}
    for key, value in record.items():
        if key in {"athlete_id", "deleted_at"}:
            continue
        if key.endswith("_json"):
            result[key.removesuffix("_json")] = json.loads(value) if value else None
        else:
            result[key] = value.isoformat() if isinstance(value, datetime) else value
    return result


def _get(con, table: str, identifier: str) -> dict:
    assert table in {"automations", "automation_runs"}
    found = rows(
        con.execute(f"SELECT * FROM app.visible_{table} WHERE id=?", [identifier])
    )
    if not found:
        raise LookupError("Suivi introuvable")
    return found[0]


def definition(record: dict) -> AutomationInput:
    return AutomationInput(
        title=record["title"],
        mission=record["mission"],
        timezone=record["timezone"],
        trigger=json.loads(record["trigger_json"]),
    )


def _validate_session(con, spec: AutomationInput) -> None:
    trigger = spec.trigger
    if not isinstance(trigger, AfterSession) or not trigger.session_key:
        return
    _require_session(con, trigger.session_key)


def _require_session(con, session_key: str) -> None:
    kind, identifier = session_key.split(":")
    table = {
        "actual": "actual_sessions",
        "strength": "strength_sessions",
        "planned": "planned_sessions",
    }[kind]
    if not con.execute(
        f"SELECT 1 FROM app.visible_{table} WHERE id=?", [int(identifier)]
    ).fetchone():
        raise ValueError("La séance n’existe pas ou n’est plus disponible.")


def _capacity(con, excluding: str = "") -> None:
    count = con.execute(
        "SELECT count(*) FROM app.visible_automations WHERE state='active' AND id<>?",
        [excluding],
    ).fetchone()[0]
    if count >= MAX_ACTIVE_AUTOMATIONS:
        raise ValueError(
            f"Limite de {MAX_ACTIVE_AUTOMATIONS} automatisations actives atteinte."
        )


def create(
    spec: AutomationInput, *, activate: bool = False, now: datetime | None = None
) -> dict:
    now = now or utc_now()
    due = next_due(spec, now)
    if isinstance(spec.trigger, Once) and (
        due is None or due > now + timedelta(days=MAX_SCHEDULE_DAYS)
    ):
        raise ValueError("Choisissez une échéance future dans les 366 prochains jours.")
    identifier = str(uuid4())
    with transaction() as con:
        _validate_session(con, spec)
        # Lock a shared owner row so concurrent activations cannot exceed the cap.
        con.execute(
            "UPDATE app.athletes SET id=id WHERE id=getvariable('arete_athlete_id') RETURNING id"
        )
        if activate:
            _capacity(con)
        con.execute(
            "INSERT INTO app.automations (id,title,mission,trigger_json,timezone,state,created_at,activated_at,next_due_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
                identifier,
                spec.title,
                spec.mission,
                spec.trigger.model_dump_json(),
                spec.timezone,
                "active" if activate else "proposed",
                now,
                now if activate else None,
                due if activate else None,
                now,
            ],
        )
        result = public(_get(con, "automations", identifier))
    return result


def get(identifier: str) -> dict:
    with db_connection() as con:
        result = public(_get(con, "automations", identifier))
        latest = rows(
            con.execute(
                "SELECT id,state,due_at,finished_at,error FROM app.visible_automation_runs WHERE automation_id=? ORDER BY due_at DESC LIMIT 1",
                [identifier],
            )
        )
        result["last_run"] = public(latest[0]) if latest else None
        return result


def listing(*, offset: int = 0) -> dict:
    if not 0 <= offset <= 10000:
        raise ValueError("Pagination invalide")
    with db_connection() as con:
        records = rows(
            con.execute(
                "SELECT * FROM app.visible_automations ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
                [MAX_PAGE + 1, offset],
            )
        )
        return {
            "items": [public(r) for r in records[:MAX_PAGE]],
            "next_offset": offset + MAX_PAGE if len(records) > MAX_PAGE else None,
        }


def _cancel_pending(con, identifier: str, now: datetime) -> None:
    con.execute(
        f"UPDATE app.automation_runs SET state='cancelled',finished_at=?,revision=revision+1 WHERE {OWNER} AND automation_id=? AND state IN ('queued','waiting','ready') RETURNING id",
        [now, identifier],
    )


def update(identifier: str, change: Update) -> dict:
    now = utc_now()
    with transaction() as con:
        old = _get(con, "automations", identifier)
        if old["revision"] != change.revision:
            raise Conflict("Ce suivi a changé. Rechargez-le.")
        _validate_session(con, change)
        due = next_due(change, now)
        if isinstance(change.trigger, Once) and (
            due is None or due > now + timedelta(days=MAX_SCHEDULE_DAYS)
        ):
            raise ValueError("Échéance passée ou au-delà de 366 jours")
        con.execute(
            f"UPDATE app.automations SET title=?,mission=?,trigger_json=?,timezone=?,next_due_at=?,activated_at=?,updated_at=?,revision=revision+1 WHERE {OWNER} AND id=? AND revision=? RETURNING id",
            [
                change.title,
                change.mission,
                change.trigger.model_dump_json(),
                change.timezone,
                due if old["state"] == "active" else None,
                now,
                now,
                identifier,
                change.revision,
            ],
        )
        _cancel_pending(con, identifier, now)
        return public(_get(con, "automations", identifier))


def set_state(identifier: str, revision: int, state: str) -> dict:
    assert state in {"active", "paused"}
    now = utc_now()
    with transaction() as con:
        con.execute(
            "UPDATE app.athletes SET id=id WHERE id=getvariable('arete_athlete_id') RETURNING id"
        )
        old = _get(con, "automations", identifier)
        if old["revision"] != revision:
            raise Conflict("Ce suivi a changé. Rechargez-le.")
        spec = definition(old)
        due = next_due(spec, now)
        if state == "active":
            _capacity(con, identifier)
            _validate_session(con, spec)
            if isinstance(spec.trigger, Once) and due is None:
                raise ValueError("Modifiez l’échéance passée avant de réactiver.")
        con.execute(
            f"UPDATE app.automations SET state=?,revision=revision+1,activated_at=?,next_due_at=?,updated_at=? WHERE {OWNER} AND id=? AND revision=? RETURNING id",
            [state, now, due if state == "active" else None, now, identifier, revision],
        )
        _cancel_pending(con, identifier, now)
        return public(_get(con, "automations", identifier))


def delete(identifier: str, revision: int) -> None:
    now = utc_now()
    with transaction() as con:
        old = _get(con, "automations", identifier)
        if old["revision"] != revision:
            raise Conflict("Ce suivi a changé. Rechargez-le.")
        _cancel_pending(con, identifier, now)
        con.execute(
            f"UPDATE app.automations SET deleted_at=now(),state='deleted',revision=revision+1 WHERE {OWNER} AND id=? RETURNING id",
            [identifier],
        )


def _insert_run(
    con,
    record: dict,
    due: datetime,
    key: str,
    now: datetime,
    *,
    state: str = "queued",
    session_key: str | None = None,
) -> None:
    try:
        stored = definition(record).model_dump(mode="json")
    except ValueError:
        if state != "failed":
            raise
        # The failed run of a definition that no longer validates keeps it as stored.
        stored = {
            "title": record["title"],
            "mission": record["mission"],
            "timezone": record["timezone"],
            "trigger": record["trigger_json"],
        }
    snapshot = {**stored, "revision": record["revision"]}
    con.execute(
        "INSERT INTO app.automation_runs (id,automation_id,occurrence_key,definition_json,session_key,due_at,state,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        [
            str(uuid4()),
            record["id"],
            key,
            json.dumps(snapshot, ensure_ascii=False),
            session_key,
            due,
            state,
            now,
            now if state in TERMINAL else None,
        ],
    )


def _disable_invalid(con, record: dict, now: datetime, exc: ValueError) -> None:
    """A stored automation that no longer validates: one failed run says why,
    and it is paused; the others go on."""
    _insert_run(
        con,
        record,
        now,
        f"invalid:{record['revision']}",
        now,
        state="failed",
    )
    con.execute(
        f"UPDATE app.automation_runs SET error=? WHERE {OWNER} AND automation_id=? AND occurrence_key=? RETURNING id",
        [str(exc), record["id"], f"invalid:{record['revision']}"],
    )
    con.execute(
        f"UPDATE app.automations SET state='paused',revision=revision+1 WHERE {OWNER} AND id=? RETURNING id",
        [record["id"]],
    )


def _sessions(con, record: dict, now: datetime, since: datetime | None = None) -> None:
    spec = definition(record)
    trigger = spec.trigger
    assert isinstance(trigger, AfterSession)
    _validate_session(con, spec)
    # game_events records every committed activity even when gamification is off.
    # Strength links resolve directly: the RPG projection may be disabled or
    # intentionally keep separate historical rewards for the same activity.
    events = rows(
        con.execute(
            """
        WITH linked_events AS (
        SELECT e.source_key,coalesce(linked.canonical_key,e.canonical_key) AS canonical_key,
               e.created_at,coalesce(a.sport,linked_actual.sport,'strength') AS sport,
               coalesce(a.session_type,linked_actual.session_type) AS session_type,
               coalesce(a.planned_session_id,linked_actual.planned_session_id) AS planned_session_id
        FROM app.visible_game_events e
        LEFT JOIN app.visible_actual_sessions a ON e.source_key='actual:'||a.id
        LEFT JOIN app.visible_strength_sessions s ON e.source_key='strength:'||s.id
        LEFT JOIN app.visible_actual_sessions linked_actual ON linked_actual.id=s.actual_session_id
        LEFT JOIN app.visible_game_events linked ON linked.source_key='actual:'||linked_actual.id
        WHERE a.id IS NOT NULL OR s.id IS NOT NULL
        ), events AS (
        SELECT *, min(created_at) OVER (PARTITION BY canonical_key) AS registered_at
        FROM linked_events
        )
        SELECT e.* FROM events e
        WHERE e.registered_at>=? AND e.created_at<=?
          AND NOT EXISTS (SELECT 1 FROM app.visible_automation_runs r WHERE r.automation_id=? AND (r.occurrence_key='session:'||e.canonical_key OR r.session_key=e.source_key OR EXISTS (SELECT 1 FROM events prior WHERE prior.source_key=r.session_key AND prior.canonical_key=e.canonical_key)))
        ORDER BY e.created_at,e.source_key LIMIT ?
        """,
            [
                record["activated_at"]
                if since is None
                else max(record["activated_at"], since),
                now,
                record["id"],
                MAX_SCAN + 1,
            ],
        )
    )
    if len(events) > MAX_SCAN:
        raise ValueError("Trop de séances à examiner ; précisez le filtre du suivi.")
    for event in events:
        if trigger.sport and trigger.sport != event["sport"]:
            continue
        if trigger.session_type and trigger.session_type != event["session_type"]:
            continue
        if trigger.session_key and trigger.session_key not in {
            event["source_key"],
            f"planned:{event['planned_session_id']}",
        }:
            continue
        due = event["registered_at"] + timedelta(minutes=trigger.delay_minutes)
        _insert_run(
            con,
            record,
            due,
            "session:" + event["canonical_key"],
            now,
            session_key=event["source_key"],
        )


def skip_due(reason: str, now: datetime | None = None) -> int:
    """Record as missed, with ``reason``, what comes due while it may not run.

    For an athlete without consent: each scheduled occurrence that comes due
    is recorded missed and the schedule moves past now, and runs already due
    are closed missed, so nothing piles up and nothing fires late once the
    athlete consents again. Pure bookkeeping on the automation tables: no
    session or health data is read. Returns how many runs were closed.
    """
    now = now or utc_now()
    # Most athletes without consent have nothing due: one read, no write.
    with db_connection() as con:
        pending = con.execute(
            "SELECT EXISTS (SELECT 1 FROM app.visible_automation_runs WHERE state IN ('queued','ready') AND due_at<=?) "
            "OR EXISTS (SELECT 1 FROM app.visible_automations WHERE state='active' AND next_due_at<=?)",
            [now, now],
        ).fetchone()
    if not (pending and pending[0]):
        return 0
    with transaction() as con:
        closed = con.execute(
            f"UPDATE app.automation_runs SET state='missed',error=?,finished_at=?,revision=revision+1 WHERE {OWNER} AND state IN ('queued','ready') AND due_at<=? RETURNING id",
            [reason, now, now],
        ).fetchall()
        due = rows(
            con.execute(
                "SELECT * FROM app.visible_automations WHERE state='active' AND next_due_at<=? ORDER BY next_due_at,id LIMIT ?",
                [now, MAX_ACTIVE_AUTOMATIONS],
            )
        )
        for record in due:
            try:
                spec = definition(record)
                at: datetime | None = record["next_due_at"]
                # Bounded per pass; a longer backlog continues at the next one.
                for _ in range(MAX_SCHEDULE_DAYS):
                    if at is None or at > now:
                        break
                    _insert_run(con, record, at, at.isoformat(), now, state="missed")
                    con.execute(
                        f"UPDATE app.automation_runs SET error=? WHERE {OWNER} AND automation_id=? AND occurrence_key=? AND state='missed' RETURNING id",
                        [reason, record["id"], at.isoformat()],
                    )
                    at = next_due(spec, at)
                con.execute(
                    f"UPDATE app.automations SET next_due_at=? WHERE {OWNER} AND id=? AND revision=? RETURNING id",
                    [at, record["id"], record["revision"]],
                )
            except ValueError as exc:
                _disable_invalid(con, record, now, exc)
    return len(closed)


def prepare(
    now: datetime | None = None, *, sessions_since: datetime | None = None
) -> dict:
    """Queue what is due. ``sessions_since`` (aware) is when the athlete's
    consent in force was given: an activity registered before it, while
    consent was missing, never triggers a session automation."""
    now = now or utc_now()
    with transaction() as con:
        active = rows(
            con.execute(
                "SELECT * FROM app.visible_automations WHERE state='active' ORDER BY updated_at,id LIMIT ?",
                [MAX_ACTIVE_AUTOMATIONS + 1],
            )
        )
        assert len(active) <= MAX_ACTIVE_AUTOMATIONS
        for record in active:
            spec = definition(record)
            try:
                if isinstance(spec.trigger, AfterSession):
                    _sessions(con, record, now, sessions_since)
                    continue
                due = record["next_due_at"]
                if due is None or due > now:
                    continue
                occurrences = []
                for _ in range(MAX_SCHEDULE_DAYS):
                    occurrences.append(due)
                    following = next_due(spec, due)
                    if following is None or following > now:
                        break
                    due = following
                else:
                    raise ValueError(
                        "Plus de 366 échéances manquées ; modifiez puis réactivez ce suivi."
                    )
                con.execute(
                    f"UPDATE app.automation_runs SET state='missed',finished_at=? WHERE {OWNER} AND automation_id=? AND state='queued' AND due_at<? RETURNING id",
                    [now, record["id"], occurrences[-1]],
                )
                for index, at in enumerate(occurrences):
                    _insert_run(
                        con,
                        record,
                        at,
                        at.isoformat(),
                        now,
                        state="queued" if index == len(occurrences) - 1 else "missed",
                    )
                con.execute(
                    f"UPDATE app.automations SET next_due_at=? WHERE {OWNER} AND id=? AND revision=? RETURNING id",
                    [following, record["id"], record["revision"]],
                )
            except ValueError as exc:
                _disable_invalid(con, record, now, exc)
        con.execute(
            f"UPDATE app.automation_runs SET state='interrupted',error='Exécution interrompue ; aucune écriture ne sera rejouée.',finished_at=?,revision=revision+1 WHERE {OWNER} AND state='running' AND lease_until<=? RETURNING id",
            [now, now],
        )
        con.execute(
            f"UPDATE app.automation_runs SET state='expired',finished_at=?,revision=revision+1 WHERE {OWNER} AND state IN ('waiting','ready') AND expires_at<=? RETURNING id",
            [now, now],
        )
        # Delete an entire terminated checkpoint chain, never prune an ancestor
        # still needed by a live run (including future DeltaChannel users).
        for table in ("automation_checkpoint_writes", "automation_checkpoints"):
            con.execute(
                f"DELETE FROM app.{table} WHERE {OWNER} AND thread_id IN (SELECT id FROM app.visible_automation_runs WHERE finished_at<?)",
                [now - timedelta(days=30)],
            )
    return {"prepared": len(active)}


def claim(identifier: str, now: datetime | None = None) -> dict | None:
    now = now or utc_now()
    try:
        with transaction() as con:
            run = _get(con, "automation_runs", identifier)
            if (
                run["state"] not in {"queued", "ready"}
                or run["due_at"] > now
                or (run["expires_at"] is not None and run["expires_at"] <= now)
            ):
                return None
            owner = _get(con, "automations", run["automation_id"])
            if (
                owner["state"] != "active"
                or owner["revision"] != json.loads(run["definition_json"])["revision"]
            ):
                return None
            if run["session_key"] is not None:
                try:
                    _require_session(con, run["session_key"])
                except ValueError as exc:
                    con.execute(
                        f"UPDATE app.automation_runs SET state='failed',error=?,finished_at=?,revision=revision+1 WHERE {OWNER} AND id=? RETURNING id",
                        [str(exc), now, identifier],
                    )
                    return None
            con.execute(
                "UPDATE app.athletes SET id=id WHERE id=getvariable('arete_athlete_id') RETURNING id"
            )
            zone = ZoneInfo(
                (get_user_settings() or {}).get("timezone") or "Europe/Paris"
            )
            local_day = now.astimezone(zone).date()
            start = datetime.combine(local_day, datetime.min.time(), zone).astimezone(
                UTC
            )
            end = datetime.combine(
                local_day + timedelta(days=1),
                datetime.min.time(),
                zone,
            ).astimezone(UTC)
            if run["started_at"] is None:
                count_row = con.execute(
                    "SELECT count(*) FROM app.visible_automation_runs WHERE started_at>=? AND started_at<?",
                    [start, end],
                ).fetchone()
                assert count_row is not None
                count = count_row[0]
                if count >= MAX_DAILY_RUNS:
                    return None
            if run["active_seconds"] >= MAX_ACTIVE_SECONDS or (
                run["state"] == "ready" and run["resumes"] >= MAX_RESUMES
            ):
                con.execute(
                    f"UPDATE app.automation_runs SET state='failed',error='Budget de reprise épuisé',finished_at=? WHERE {OWNER} AND id=? RETURNING id",
                    [now, identifier],
                )
                return None
            slot = con.execute(
                "SELECT id FROM app.automation_worker_slots WHERE lease_until IS NULL OR lease_until<=? ORDER BY id LIMIT 1",
                [now],
            ).fetchone()
            if slot is None:
                return None
            con.execute(
                "UPDATE app.automation_worker_slots SET run_id=?,lease_until=? WHERE id=? RETURNING id",
                [identifier, now + timedelta(seconds=SEGMENT_SECONDS + 60), slot[0]],
            )
            changed = con.execute(
                f"UPDATE app.automation_runs SET state='running',lease_until=?,started_at=coalesce(started_at,?),resumes=resumes+?,revision=revision+1 WHERE {OWNER} AND id=? AND revision=? RETURNING id",
                [
                    now + timedelta(seconds=SEGMENT_SECONDS + 60),
                    now,
                    int(run["state"] == "ready"),
                    identifier,
                    run["revision"],
                ],
            ).fetchone()
            return _get(con, "automation_runs", identifier) if changed else None
    except duckdb.TransactionException:
        return None


def runs(identifier: str, *, offset: int = 0) -> dict:
    if not 0 <= offset <= 10000:
        raise ValueError("Pagination invalide")
    with db_connection() as con:
        _get(con, "automations", identifier)
        found = rows(
            con.execute(
                "SELECT * FROM app.visible_automation_runs WHERE automation_id=? ORDER BY due_at DESC,id LIMIT ? OFFSET ?",
                [identifier, MAX_PAGE + 1, offset],
            )
        )
        return {
            "items": [public(r) for r in found[:MAX_PAGE]],
            "next_offset": offset + MAX_PAGE if len(found) > MAX_PAGE else None,
        }


def run_detail(identifier: str) -> dict:
    with db_connection() as con:
        result = public(_get(con, "automation_runs", identifier))
        result["interrupts"] = [
            public(r)
            for r in rows(
                con.execute(
                    "SELECT * FROM app.visible_automation_interrupts WHERE run_id=? ORDER BY created_at,id LIMIT 25",
                    [identifier],
                )
            )
        ]
        result["effects"] = [
            public(r)
            for r in rows(
                con.execute(
                    "SELECT * FROM app.visible_automation_effects WHERE run_id=? ORDER BY created_at,tool_call_id LIMIT 25",
                    [identifier],
                )
            )
        ]
        return result


def decide(run_id: str, interrupt_id: str, revision: int, decision: dict) -> dict:
    from jsonschema import Draft202012Validator

    now = utc_now()
    with transaction() as con:
        run = _get(con, "automation_runs", run_id)
        pending = rows(
            con.execute(
                "SELECT * FROM app.visible_automation_interrupts WHERE run_id=? AND id=?",
                [run_id, interrupt_id],
            )
        )
        if not pending:
            raise LookupError("Validation introuvable")
        item = pending[0]
        encoded = json.dumps(decision, ensure_ascii=False, sort_keys=True)
        if item["decision_json"] is not None:
            if json.loads(item["decision_json"]) == decision:
                return run_detail(run_id)
            raise Conflict("Une décision différente est déjà enregistrée.")
        if (
            run["state"] not in {"waiting", "ready"}
            or item["revision"] != revision
            or item["expires_at"] <= now
        ):
            raise Conflict("Cette demande a changé ou expiré.")
        if len(encoded) > 16000:
            raise ValueError("Réponse trop longue")
        validator = Draft202012Validator(json.loads(item["schema_json"]))
        error = next(validator.iter_errors(decision), None)
        if error is not None:
            raise ValueError(f"Réponse invalide : {error.message}")
        payload = json.loads(item["payload_json"])
        if (
            decision.get("type") == "edit"
            and decision.get("edited_action", {}).get("name") != payload["name"]
        ):
            raise ValueError("Une modification ne peut pas changer d’outil.")
        con.execute(
            f"UPDATE app.automation_interrupts SET decision_json=?,revision=revision+1 WHERE {OWNER} AND run_id=? AND id=? AND revision=? RETURNING id",
            [encoded, run_id, interrupt_id, revision],
        )
        con.execute(
            f"UPDATE app.automation_runs SET state='ready',revision=revision+1 WHERE {OWNER} AND id=? RETURNING id",
            [run_id],
        )
    return run_detail(run_id)
