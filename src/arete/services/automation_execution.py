"""Durable budgets and effect receipts; a started effect is never blindly retried."""

import hashlib
import json
from datetime import timedelta

from arete.dataio.db import db_connection, transaction
from arete.services.automation_schedule import (
    MAX_MODEL_REQUESTS,
    MAX_MODEL_TURNS,
    MAX_TOOL_CALLS,
    WAIT_HOURS,
)
from arete.services.automations import OWNER, Conflict, _get, rows
from arete.services.settings import utc_now


def charge(identifier: str, counter: str) -> None:
    maximum = {
        "model_turns": MAX_MODEL_TURNS,
        "model_requests": MAX_MODEL_REQUESTS,
        "tool_calls": MAX_TOOL_CALLS,
    }[counter]
    with transaction() as con:
        guard(con, identifier)
        row = con.execute(
            f"UPDATE app.automation_runs SET {counter}={counter}+1 WHERE {OWNER} AND id=? AND {counter}<? RETURNING id",
            [identifier, maximum],
        ).fetchone()
        if row is None:
            raise RuntimeError(f"Budget épuisé : {counter} ({maximum})")


def charge_tool(identifier, call):
    # Re-entering an interrupted call does not reset or spend its allowance twice.
    with transaction() as con:
        guard(con, identifier)
        created = con.execute(
            "INSERT INTO app.automation_calls (run_id,tool_call_id,name,created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING tool_call_id",
            [identifier, call["id"], call["name"], utc_now()],
        ).fetchone()
        if created:
            changed = con.execute(
                f"UPDATE app.automation_runs SET tool_calls=tool_calls+1 WHERE {OWNER} AND id=? AND tool_calls<? RETURNING id",
                [identifier, MAX_TOOL_CALLS],
            ).fetchone()
            if not changed:
                raise RuntimeError("Budget de 24 appels outils épuisé")


def review_before(con, call):
    args = call["args"]
    table = (
        "strength_sessions" if call["name"] == "update_workout" else "planned_sessions"
    )
    identifier = args.get("session_id")
    if identifier is None:
        return None
    selected = rows(
        con.execute(f"SELECT * FROM app.visible_{table} WHERE id=?", [identifier])
    )
    if not selected:
        raise Conflict("La séance concernée n’est plus disponible")
    keys = {
        "id",
        "date",
        "session_type",
        "description",
        "sport",
        "target_duration_min",
        "target_distance_km",
        "target_intensity",
        "name",
        "duration_min",
        "notes",
        "revision",
    }
    return {
        key: str(value) if hasattr(value, "isoformat") else value
        for key, value in selected[0].items()
        if key in keys and value is not None
    }


def guard(con, identifier):
    run = _get(con, "automation_runs", identifier)
    definition = _get(con, "automations", run["automation_id"])
    if (
        run["state"] != "running"
        or run["lease_until"] <= utc_now()
        or definition["state"] != "active"
        or definition["revision"] != json.loads(run["definition_json"])["revision"]
    ):
        raise Conflict("Mission suspendue, modifiée ou interrompue.")
    return run


def _snapshot(con, call):
    # Conservative precondition: any training or journal change since review
    # invalidates a queued write, including tools without a revision argument.
    digest = hashlib.sha256()
    for table in (
        "planned_sessions",
        "actual_sessions",
        "strength_sessions",
        "session_exercises",
        "exercise_sets",
        "coach_memory_files",
    ):
        args = call["args"]
        identifier = args.get("session_id")
        names = {
            "planned_sessions": {
                "update_planned_session",
                "set_session_prescription",
                "delete_planned_session",
            },
            "strength_sessions": {"update_workout"},
        }
        predicate = (
            " WHERE id=?"
            if identifier is not None and call["name"] in names.get(table, set())
            else ""
        )
        records = con.execute(
            f"SELECT * FROM app.visible_{table}{predicate} LIMIT 10001",
            [identifier] if predicate else [],
        ).fetchall()
        if len(records) > 10000:
            raise ValueError(
                "Trop de données pour valider cette écriture automatiquement."
            )
        digest.update(
            json.dumps(
                sorted(records, key=str), default=str, ensure_ascii=False
            ).encode()
        )
    return digest.hexdigest()


def propose(identifier, call):
    with transaction() as con:
        guard(con, identifier)
        old = con.execute(
            "SELECT 1 FROM app.visible_automation_effects WHERE run_id=? AND tool_call_id=?",
            [identifier, call["id"]],
        ).fetchone()
        if old is None:
            args = json.dumps(
                {
                    "call": call,
                    "baseline": _snapshot(con, call),
                    "before": review_before(con, call),
                },
                sort_keys=True,
                default=str,
            )
            con.execute(
                "INSERT INTO app.automation_effects (run_id,tool_call_id,arguments_json,state,created_at) VALUES (?,?,?,'proposed',?)",
                [identifier, call["id"], args, utc_now()],
            )


def begin_effect(identifier, call):
    with transaction() as con:
        guard(con, identifier)
        receipts = rows(
            con.execute(
                "SELECT * FROM app.visible_automation_effects WHERE run_id=? AND tool_call_id=?",
                [identifier, call["id"]],
            )
        )
        if not receipts:
            raise AssertionError("Write has no review receipt")
        receipt = receipts[0]
        original = json.loads(receipt["arguments_json"])
        if original["call"]["name"] != call["name"]:
            raise Conflict("L’outil approuvé a changé")
        if receipt["state"] == "completed":
            if original.get("executed") != call:
                raise Conflict("L’écriture déjà effectuée diffère")
            return receipt["result_json"]
        if receipt["state"] != "proposed":
            raise Conflict("Issue d’écriture incertaine ; aucun rejeu autorisé.")
        if original["baseline"] != _snapshot(con, call):
            raise Conflict(
                "Les données ont changé depuis la proposition. Cette ancienne modification ne sera pas appliquée."
            )
        original["executed"] = call
        con.execute(
            f"UPDATE app.automation_effects SET state='started',arguments_json=? WHERE {OWNER} AND run_id=? AND tool_call_id=? RETURNING tool_call_id",
            [json.dumps(original, sort_keys=True, default=str), identifier, call["id"]],
        )
    return None


def end_effect(identifier, call_id, result):
    with transaction() as con:
        changed = con.execute(
            f"UPDATE app.automation_effects SET state='completed',result_json=? WHERE {OWNER} AND run_id=? AND tool_call_id=? AND state='started' RETURNING tool_call_id",
            [result, identifier, call_id],
        ).fetchone()
        assert changed, "Missing started receipt"


def finish(identifier, *, seconds, result=None, interrupts=(), error=None):
    now = utc_now()
    with transaction() as con:
        run = _get(con, "automation_runs", identifier)
        if run["state"] != "running":
            raise Conflict("La prise de possession a expiré")
        ambiguous = con.execute(
            "SELECT count(*) FROM app.visible_automation_effects WHERE run_id=? AND state='started'",
            [identifier],
        ).fetchone()[0]
        if ambiguous:
            error = "Issue d’écriture incertaine ; mission arrêtée sans rejeu."
        state = "failed" if error else "waiting" if interrupts else "completed"
        # Each question has its own fixed expiry; a partial answer cannot extend it.
        for item in interrupts:
            receipt = con.execute(
                "SELECT arguments_json FROM app.visible_automation_effects WHERE run_id=? AND tool_call_id=?",
                [identifier, item["value"]["tool_call_id"]],
            ).fetchone()
            if receipt:
                item["value"]["before"] = json.loads(receipt[0]).get("before")
            con.execute(
                "INSERT INTO app.automation_interrupts (run_id,id,tool_call_id,payload_json,schema_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                [
                    identifier,
                    item["id"],
                    item["value"]["tool_call_id"],
                    json.dumps(item["value"], ensure_ascii=False),
                    json.dumps(item["schema"]),
                    now,
                    now + timedelta(hours=WAIT_HOURS),
                ],
            )
        expiry = (
            con.execute(
                "SELECT min(expires_at) FROM app.visible_automation_interrupts WHERE run_id=? AND decision_json IS NULL",
                [identifier],
            ).fetchone()[0]
            if interrupts
            else None
        )
        con.execute(
            f"UPDATE app.automation_runs SET state=?,result=?,error=?,finished_at=?,expires_at=?,lease_until=NULL,active_seconds=active_seconds+?,revision=revision+1 WHERE {OWNER} AND id=? RETURNING id",
            [
                state,
                result,
                error,
                now if state != "waiting" else None,
                expiry,
                seconds,
                identifier,
            ],
        )
        con.execute(
            "UPDATE app.automation_worker_slots SET run_id=NULL,lease_until=NULL WHERE run_id=? RETURNING id",
            [identifier],
        )
    from arete.services import inbox

    inbox.publish(
        f"run:{identifier}:{run['revision']}",
        "automation",
        "Chiron attend ta réponse"
        if state == "waiting"
        else "Suivi terminé"
        if state == "completed"
        else "Suivi interrompu",
        error or result or "Une question ou une validation est disponible.",
        f"/follow-up?run={identifier}",
        {"kind": "automation_run", "id": identifier},
    )


def decisions(identifier):
    with db_connection() as con:
        _get(con, "automation_runs", identifier)
        return {
            r[0]: json.loads(r[1])
            for r in con.execute(
                "SELECT id,decision_json FROM app.visible_automation_interrupts WHERE run_id=? AND decision_json IS NOT NULL LIMIT 25",
                [identifier],
            ).fetchall()
        }
