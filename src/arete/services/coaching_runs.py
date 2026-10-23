"""Owned execution receipts and observations; reading never schedules work."""

import json
import logging
import time
from datetime import timedelta
from functools import wraps
from uuid import uuid4

import duckdb
from jsonschema import Draft202012Validator

from arete.dataio.db import db_connection, transaction
from arete.services.automations import OWNER, Conflict, rows
from arete.services.settings import utc_now

MAX_WAITING_RUNS = 8
MAX_RESUMES = 4
MAX_ACTIVE_SECONDS = 300
MAX_MODEL_TURNS = 24
MAX_TOOL_CALLS = 96
MAX_PROJECTION_BYTES = 2_000_000
WAIT_HOURS = 48
RETAIN_HOURS = 24
TERMINAL = frozenset({"completed", "failed", "cancelled", "expired", "interrupted"})


METADATA_ATTEMPTS = 3
METADATA_RETRY_SECONDS = 0.02
logger = logging.getLogger(__name__)


def retry_metadata(operation):
    """Only retry aborted metadata transactions, never a tool or a whole run."""

    @wraps(operation)
    def wrapped(*args, **kwargs):
        for attempt in range(METADATA_ATTEMPTS):
            try:
                return operation(*args, **kwargs)
            except (duckdb.TransactionException, duckdb.ConstraintException) as exc:
                if attempt == METADATA_ATTEMPTS - 1:
                    raise Conflict(
                        "Une opération concurrente a modifié l’exécution ; relis son état."
                    ) from exc
                logger.info(
                    "Execution metadata conflict, retry %d/%d",
                    attempt + 1,
                    METADATA_ATTEMPTS,
                )
                time.sleep(METADATA_RETRY_SECONDS * (attempt + 1))
        raise AssertionError("unreachable")

    return wrapped


def encode(value):
    text = json.dumps(value, ensure_ascii=False, default=str)
    if len(text.encode()) > MAX_PROJECTION_BYTES:
        raise ValueError("L’activité dépasse sa limite de taille.")
    return text


def _get(con, identifier):
    found = rows(
        con.execute("SELECT * FROM app.visible_chat_runs WHERE id=?", [identifier])
    )
    if not found:
        raise LookupError("Exécution introuvable")
    return found[0]


def cleanup():
    now = utc_now()
    with transaction() as con:
        con.execute(
            f"UPDATE app.chat_runs SET state='interrupted',revision=revision+1,slot=NULL,active_thread=NULL,expires_at=now()+INTERVAL 24 HOUR WHERE {OWNER} AND state='running' AND lease_until<=? RETURNING id",
            [now],
        )
        con.execute(
            f"UPDATE app.chat_runs SET state='expired',revision=revision+1,slot=NULL,active_thread=NULL,expires_at=now()+INTERVAL 24 HOUR WHERE {OWNER} AND state IN ('waiting','ready') AND expires_at<=? RETURNING id",
            [now],
        )
        con.execute(
            "UPDATE app.coaching_run_activity SET state=r.state,revision=coaching_run_activity.revision+1,expires_at=r.expires_at FROM app.visible_chat_runs r WHERE coaching_run_activity.id=r.id AND coaching_run_activity.athlete_id=getvariable('arete_athlete_id') AND coaching_run_activity.state<>r.state AND r.state IN ('completed','failed','cancelled','expired','interrupted') RETURNING id"
        )
        # Purge execution context, including tool history, after closure.
        for table in ("chat_checkpoint_writes", "chat_checkpoints"):
            con.execute(
                f"DELETE FROM app.{table} WHERE {OWNER} AND thread_id IN (SELECT id FROM app.visible_chat_runs WHERE state IN ('completed','failed','cancelled','expired','interrupted') AND (lease_until IS NULL OR lease_until<=now()))"
            )
        con.execute(
            f"UPDATE app.chat_runs SET context_json='{{}}' WHERE {OWNER} AND context_json<>'{{}}' AND state IN ('completed','failed','cancelled','expired','interrupted') RETURNING id"
        )
        con.execute(
            f"DELETE FROM app.coaching_run_activity WHERE {OWNER} AND expires_at<=?",
            [now],
        )
        for table in ("chat_interrupts", "chat_effects"):
            con.execute(
                f"DELETE FROM app.{table} WHERE {OWNER} AND run_id IN (SELECT id FROM app.visible_chat_runs WHERE expires_at<=? AND state IN ('completed','failed','cancelled','expired','interrupted'))",
                [now],
            )
        con.execute(
            f"DELETE FROM app.chat_runs WHERE {OWNER} AND expires_at<=? AND state IN ('completed','failed','cancelled','expired','interrupted')",
            [now],
        )


@retry_metadata
def create(thread_id, context):
    cleanup()
    now, identifier = utc_now(), str(uuid4())
    with transaction() as con:
        active = rows(
            con.execute(
                "SELECT id,thread_id,slot FROM app.visible_chat_runs WHERE state IN ('running','waiting','ready') LIMIT ?",
                [MAX_WAITING_RUNS + 1],
            )
        )
        if len(active) >= MAX_WAITING_RUNS or any(
            r["thread_id"] == thread_id for r in active
        ):
            raise Conflict(
                "Termine ou annule l’exécution en attente avant de poursuivre ce fil."
            )
        con.execute(
            "INSERT INTO app.chat_runs (id,thread_id,active_thread,slot,state,context_json,created_at,expires_at,lease_until) VALUES (?,?,?,?,'running',?,?,?,?)",
            [
                identifier,
                thread_id,
                thread_id,
                next(
                    slot
                    for slot in range(MAX_WAITING_RUNS)
                    if slot not in {r["slot"] for r in active}
                ),
                encode(context),
                now,
                now + timedelta(hours=WAIT_HOURS),
                now + timedelta(seconds=MAX_ACTIVE_SECONDS),
            ],
        )
    return identifier


def get(identifier, *, internal=False):
    with db_connection() as con:
        run = _get(con, identifier)
        interrupts = rows(
            con.execute(
                "SELECT * FROM app.visible_chat_interrupts WHERE run_id=? ORDER BY created_at,id LIMIT 97",
                [identifier],
            )
        )
    if len(interrupts) > MAX_TOOL_CALLS:
        raise ValueError("Trop d’interruptions")
    run["interrupts"] = [
        {
            "id": i["id"],
            "revision": i["revision"],
            "payload": json.loads(i["payload_json"]),
            "schema": json.loads(i["schema_json"]),
            "decision": json.loads(i["decision_json"]) if i["decision_json"] else None,
            "expires_at": i["expires_at"].isoformat(),
        }
        for i in interrupts
    ]
    if not internal:
        for key in ("context_json", "policy", "athlete_id", "deleted_at"):
            run.pop(key, None)
    return run


def bind_policy(identifier, policy):
    with transaction() as con:
        run = _get(con, identifier)
        if run["policy"] is not None and run["policy"] != policy:
            raise Conflict(
                "La configuration du coach a changé ; annule cette exécution."
            )
        con.execute(
            f"UPDATE app.chat_runs SET policy=? WHERE {OWNER} AND id=? RETURNING id",
            [policy, identifier],
        )


def guard(con, identifier):
    run = _get(con, identifier)
    if run["state"] != "running" or run["lease_until"] <= utc_now():
        raise Conflict("L’exécution est arrêtée ou son bail a expiré.")
    return run


@retry_metadata
def charge_model(identifier):
    with transaction() as con:
        guard(con, identifier)
        changed = con.execute(
            f"UPDATE app.chat_runs SET model_turns=model_turns+1 WHERE {OWNER} AND id=? AND model_turns<? RETURNING id",
            [identifier, MAX_MODEL_TURNS],
        ).fetchone()
        if not changed:
            raise ValueError("Limite de 24 tours atteinte, reprises comprises.")


def _chat_snapshot(con, call):
    from arete.services.automation_execution import _snapshot

    baseline = [_snapshot(con, call)]
    for table in ("athlete_facts", "automations"):
        selected = con.execute(
            f"SELECT * FROM app.visible_{table} ORDER BY id LIMIT 10001"
        ).fetchall()
        if len(selected) > 10000:
            raise ValueError("Trop de données pour valider cette proposition.")
        baseline.append(encode(selected))
    return baseline


@retry_metadata
def prepare_call(identifier, call, *, write):
    with transaction() as con:
        guard(con, identifier)
        found = con.execute(
            "SELECT arguments_json FROM app.visible_chat_effects WHERE run_id=? AND tool_call_id=?",
            [identifier, call["id"]],
        ).fetchone()
        if found:
            return json.loads(found[0])
        charged = con.execute(
            f"UPDATE app.chat_runs SET tool_calls=tool_calls+1 WHERE {OWNER} AND id=? AND tool_calls<? RETURNING id",
            [identifier, MAX_TOOL_CALLS],
        ).fetchone()
        if not charged:
            raise ValueError("Limite de 96 outils atteinte, reprises comprises.")
        receipt = {
            "call": call,
            "write": write,
            "review": bool(call["args"].get("requires_review")),
            "baseline": _chat_snapshot(con, call)
            if write and call["args"].get("requires_review")
            else None,
        }
        con.execute(
            "INSERT INTO app.chat_effects (run_id,tool_call_id,arguments_json,state,created_at) VALUES (?,?,?,'proposed',?)",
            [identifier, call["id"], encode(receipt), utc_now()],
        )
        return receipt


@retry_metadata
def begin_effect(identifier, call):
    with transaction() as con:
        guard(con, identifier)
        receipt = rows(
            con.execute(
                "SELECT * FROM app.visible_chat_effects WHERE run_id=? AND tool_call_id=?",
                [identifier, call["id"]],
            )
        )[0]
        original = json.loads(receipt["arguments_json"])
        if original["call"]["name"] != call["name"]:
            raise Conflict("L’outil approuvé a changé.")
        if receipt["state"] == "completed":
            if original.get("executed") != call:
                raise Conflict("Les arguments d’une action terminée ont changé.")
            return receipt["result_json"]
        if receipt["state"] != "proposed":
            raise Conflict("Résultat incertain : aucun rejeu autorisé.")
        if original["baseline"] is not None and original["baseline"] != _chat_snapshot(
            con, call
        ):
            raise Conflict("Les données ont changé depuis la proposition.")
        original["executed"] = call
        con.execute(
            f"UPDATE app.chat_effects SET state='started',arguments_json=? WHERE {OWNER} AND run_id=? AND tool_call_id=? RETURNING tool_call_id",
            [encode(original), identifier, call["id"]],
        )


@retry_metadata
def end_effect(identifier, call_id, result):
    with transaction() as con:
        con.execute(
            f"UPDATE app.chat_effects SET state='completed',result_json=? WHERE {OWNER} AND run_id=? AND tool_call_id=? AND state='started' RETURNING tool_call_id",
            [result, identifier, call_id],
        )


def finish(identifier, seconds, interrupts=(), *, failed=False):
    now = utc_now()
    with transaction() as con:
        run = _get(con, identifier)
        unknown = con.execute(
            "SELECT 1 FROM app.visible_chat_effects WHERE run_id=? AND state='started' LIMIT 1",
            [identifier],
        ).fetchone()
        state = (
            "cancelled"
            if run["state"] == "cancelled"
            else "failed"
            if failed or unknown
            else "waiting"
            if interrupts
            else "completed"
        )
        if state in TERMINAL:
            interrupts = ()
        for item in interrupts:
            con.execute(
                "INSERT INTO app.chat_interrupts (run_id,id,tool_call_id,payload_json,schema_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                [
                    identifier,
                    item["id"],
                    item["value"]["tool_call_id"],
                    encode(item["value"]),
                    encode(item["schema"]),
                    now,
                    min(run["expires_at"], now + timedelta(hours=WAIT_HOURS)),
                ],
            )
        con.execute(
            f"UPDATE app.chat_runs SET state=?,active_seconds=active_seconds+?,revision=revision+1,lease_until=NULL,expires_at=? WHERE {OWNER} AND id=? RETURNING id",
            [
                state,
                seconds,
                run["expires_at"]
                if state == "waiting"
                else now + timedelta(hours=RETAIN_HOURS),
                identifier,
            ],
        )
    if state in TERMINAL:
        with transaction() as con:
            con.execute(
                f"UPDATE app.chat_runs SET slot=NULL,active_thread=NULL WHERE {OWNER} AND id=? RETURNING id",
                [identifier],
            )
        cleanup()
    return state


@retry_metadata
def decide(identifier, interrupt_id, revision, decision):
    with transaction() as con:
        run = _get(con, identifier)
        found = rows(
            con.execute(
                "SELECT * FROM app.visible_chat_interrupts WHERE run_id=? AND id=?",
                [identifier, interrupt_id],
            )
        )
        if not found:
            raise LookupError("Question introuvable")
        item = found[0]
        if item["decision_json"]:
            if json.loads(item["decision_json"]) != decision:
                raise Conflict("Une autre réponse est déjà enregistrée.")
            return
        if (
            run["state"] not in {"waiting", "ready"}
            or item["revision"] != revision
            or item["expires_at"] <= utc_now()
        ):
            raise Conflict("La question a changé ou expiré.")
        encoded = encode(decision)
        if len(encoded) > 16000:
            raise ValueError("Réponse trop longue")
        Draft202012Validator(
            json.loads(item["schema_json"]),
            format_checker=Draft202012Validator.FORMAT_CHECKER,
        ).validate(decision)
        con.execute(
            f"UPDATE app.chat_interrupts SET decision_json=?,revision=revision+1 WHERE {OWNER} AND run_id=? AND id=? AND revision=? RETURNING id",
            [encoded, identifier, interrupt_id, revision],
        )
        con.execute(
            f"UPDATE app.chat_runs SET state='ready',revision=revision+1 WHERE {OWNER} AND id=? RETURNING id",
            [identifier],
        )


@retry_metadata
def claim(identifier):
    with transaction() as con:
        run = _get(con, identifier)
        if (
            run["state"] != "ready"
            or run["expires_at"] <= utc_now()
            or run["resumes"] >= MAX_RESUMES
            or run["active_seconds"] >= MAX_ACTIVE_SECONDS
        ):
            raise Conflict("Cette exécution ne peut pas être reprise.")
        row = con.execute(
            f"UPDATE app.chat_runs SET state='running',resumes=resumes+1,lease_until=?,revision=revision+1 WHERE {OWNER} AND id=? AND revision=? AND state='ready' RETURNING id",
            [
                utc_now()
                + timedelta(seconds=MAX_ACTIVE_SECONDS - run["active_seconds"]),
                identifier,
                run["revision"],
            ],
        ).fetchone()
        if not row:
            raise Conflict("Une autre reprise est déjà en cours.")
    return get(identifier, internal=True)


@retry_metadata
def cancel(identifier):
    with transaction() as con:
        run = _get(con, identifier)
        if run["state"] not in TERMINAL:
            con.execute(
                f"UPDATE app.chat_runs SET state='cancelled',revision=revision+1,slot=NULL,active_thread=NULL,expires_at=? WHERE {OWNER} AND id=? RETURNING id",
                [utc_now() + timedelta(hours=RETAIN_HOURS), identifier],
            )
    # Cleanup keeps a running worker's checkpoints until its lease is released.
    # A paused execution can be purged immediately after cancellation.
    cleanup()


def publish(identifier, source_kind, source_id, projection, state):
    now = utc_now()
    # One atomic upsert needs no BEGIN/COMMIT round trips.
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.coaching_run_activity (id,source_kind,source_id,state,projection_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,projection_json=excluded.projection_json,revision=coaching_run_activity.revision+1,expires_at=excluded.expires_at WHERE coaching_run_activity.athlete_id=getvariable('arete_athlete_id') RETURNING id",
            [
                identifier,
                source_kind,
                source_id,
                state,
                encode(projection),
                now,
                now
                + timedelta(
                    hours=WAIT_HOURS
                    if state in {"running", "waiting", "ready"}
                    else RETAIN_HOURS
                ),
            ],
        )


def activity(identifier):
    with db_connection() as con:
        found = rows(
            con.execute(
                "SELECT id,source_kind,source_id,state,revision,projection_json FROM app.visible_coaching_run_activity WHERE id=? AND expires_at>now()",
                [identifier],
            )
        )
    if not found:
        raise LookupError("Activité introuvable")
    result = found[0]
    result["projection"] = json.loads(result.pop("projection_json"))
    return result


def latest(source_kind, source_id):
    with db_connection() as con:
        found = rows(
            con.execute(
                "SELECT id,source_kind,source_id,state,revision,projection_json FROM app.visible_coaching_run_activity WHERE source_kind=? AND source_id=? AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
                [source_kind, source_id],
            )
        )
    if not found:
        return None
    result = found[0]
    result["projection"] = json.loads(result.pop("projection_json"))
    return result
