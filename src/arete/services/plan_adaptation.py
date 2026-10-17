"""Apply the morning's decisions to today's plan, and take them back.

``adaptation.evaluate`` decides; this module reads the facts, claims one
decision per session and day, writes the planned session and keeps what it
replaced so the athlete can revert in one tap. Called by the daily run (after
the health sync, before the briefing) and by ``POST /plan/today/adapt``.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import date, timedelta
from time import monotonic
from typing import TYPE_CHECKING, Any

from arete.dataio.settings import get_user_settings
from arete.garmin.models import PlannedSession, SessionStatus
from arete.garmin.repository import GarminRepository
from arete.services.adaptation import (
    AdaptationInput,
    Decision,
    describe,
    evaluate,
    one_recovery_per_day,
)
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.plan_repository import (
    ATHLETE_CHOICE,
    AlreadyDecided,
    PlanDecision,
    PlanDecisionRepository,
)
from arete.services.settings import athlete_today

if TYPE_CHECKING:
    import duckdb

    from arete.garmin.client import GarminClient
    from arete.services.garmin_export import Exchange, Prepared

logger = logging.getLogger(__name__)

#: Bound on what the daily run sends to Garmin in one go.
MAX_DAILY_PUSHES = 3
#: Time a session's exchange needs left before it starts: a few reads and two
#: writes, each given its whole 10 s timeout (garmin_export.REQUEST_TIMEOUT).
SESSION_SECONDS = 20
#: An answer (apply or revert) waits for Garmin at most this long in all.
ANSWER_SECONDS = 25
#: What one session of an answer may need: a same-day re-export to a watch
#: with a legacy copy to adopt (9 requests) or a withdrawal (8).
ANSWER_SESSION_REQUESTS = 9
#: A low day's answer: the eased session and the rest, at their worst.
ANSWER_REQUESTS = 2 * ANSWER_SESSION_REQUESTS

#: The planning fields a decision may overwrite, saved before it does
#: (``date`` only by a renegotiated move, whose revert restores it alone).
_PLAN_FIELDS = (
    "session_type",
    "target_duration_min",
    "target_hr_zone",
    "target_intensity",
    "description",
    "status",
    "date",
)
#: All a rest changes on a session with explicit steps: its status.
_STRUCTURED_FIELDS = ("status",)


def snapshot(session: PlannedSession) -> dict[str, Any]:
    return {
        "session_type": session.session_type.value,
        "target_duration_min": session.target_duration_min,
        "target_hr_zone": session.target_hr_zone,
        "target_intensity": session.target_intensity,
        "description": session.description,
        "status": session.status.value,
    }


def auto_adapt_enabled(user_id: int | None = None) -> bool:
    user_id = resolve_athlete_id(user_id)
    return bool((get_user_settings(user_id) or {}).get("auto_adapt_enabled", True))


def adapt_today(
    target_date: date | None = None, *, respect_setting: bool = True
) -> list[PlanDecision]:
    """Decide once for each of the day's planned sessions; the day's decisions.

    Sessions decided together share one recovery (``one_recovery_per_day``).

    ``respect_setting`` is the daily run's: with the switch off it writes
    nothing. An explicit request from the athlete ignores it.
    """
    from arete.services.coaching_rules import rule_facts

    day = target_date or athlete_today()
    decisions = PlanDecisionRepository()

    planned_repo = GarminRepository()
    sessions = planned_repo.list_planned_sessions(
        start_date=day, end_date=day, status=None, limit=10, ascending=True
    )
    earlier = decisions.list_for_day(day)
    decided = {d.planned_session_id for d in earlier}
    # A recovery proposed or applied by an earlier run still holds the day's.
    recovery = next(
        (
            d.original or {}
            for d in earlier
            if d.decision == Decision.REPLACE_EASY
            and d.state in {"pending", "discussion", "applied"}
            and d.reverted_at is None
        ),
        None,
    )
    # Imported prescriptions were explicitly reviewed; summary-field adaptation
    # cannot faithfully rewrite their steps or their source evidence.
    pending = [s for s in sessions if s.id is not None and s.id not in decided]
    if not pending:
        return decisions.list_for_day(day)

    facts = rule_facts(day)
    inputs = [
        AdaptationInput(
            session_type=session.session_type.value,
            sport=session.sport,
            status=session.status.value,
            target_duration_min=session.target_duration_min,
            target_hr_zone=session.target_hr_zone,
            target_intensity=session.target_intensity,
            description=session.description,
            readiness=facts.readiness_score,
            readiness_source=facts.readiness_source,
            acwr=facts.acwr,
            tsb=facts.tsb,
            fitness_goal=facts.fitness_goal,
            sleep=facts.checkin.sleep if facts.checkin else None,
            legs=facts.checkin.legs if facts.checkin else None,
        )
        for session in pending
    ]
    outcomes = one_recovery_per_day(
        [(inp, evaluate(inp)) for inp in inputs],
        kept=None
        if recovery is None
        else describe(
            str(recovery.get("session_type")),
            recovery.get("target_duration_min"),
            recovery.get("target_hr_zone"),
        ),
    )
    for session, outcome in zip(pending, outcomes, strict=True):
        assert session.id is not None
        if outcome is None or outcome.decision == Decision.KEEP:
            continue
        try:
            decision = decisions.create(
                day=day,
                planned_session_id=session.id,
                decision=outcome.decision.value,
                reason=outcome.reason,
                readiness_score=facts.readiness_score,
                readiness_source=facts.readiness_source,
                acwr=facts.acwr,
                original=snapshot(session),
                adapted=outcome.adapted or None,
                state="discussion" if session.prescription is not None else "pending",
                session_revision=session.revision,
                readiness_measured_on=facts.readiness_measured_on,
            )
        except AlreadyDecided:
            continue  # another run claimed it first: its decision stands
        logger.info("Plan proposal %s: %s", decision.id, outcome.decision.value)
    return decisions.list_for_day(day)


class NothingToRevert(Exception):
    """The decision was a keep, or has been reverted already."""


class RevertRefused(Exception):
    """Reverting would undo something else: the athlete edits the plan instead."""


def revert(decision_id: int) -> PlanDecision:
    """Put the planned session back as it was before the decision.

    Raises ``LookupError`` for an unknown id and ``NothingToRevert`` for a
    keep or a decision already reverted. A copy on Garmin keeps its ids and is
    marked stale; with the automatic push on, the original replaces it in place
    (or comes back after a reverted rest), once, after the commit. Otherwise,
    or when that attempt fails, the card offers to send it again.
    """
    return revert_reporting(decision_id)[0]


def revert_reporting(decision_id: int) -> tuple[PlanDecision, str]:
    """``revert``, with what Garmin did after it (``garmin_outcome``).

    The athlete's own choice (``ATHLETE_CHOICE``) is reverted only while the
    session is as that choice wrote it (its ``session_revision``), else
    ``RevertRefused``: an edit made since is never silently undone, and a
    second tap reverts nothing. A move is reverted only on its own day, and
    gives back the day alone.
    """
    decisions = PlanDecisionRepository()
    decision = decisions.get(decision_id)
    if decision is None:
        raise LookupError(f"decision {decision_id}")
    if (
        decision.applied_at is None
        or decision.reverted_at is not None
        or decision.decision == Decision.KEEP.value
    ):
        raise NothingToRevert(f"decision {decision_id}")
    athletes = decision.readiness_source == ATHLETE_CHOICE
    moved = decision.decision == Decision.MOVE
    if moved and decision.date != athlete_today():
        raise RevertRefused(
            "Ce déplacement date d’un autre jour : modifie la séance depuis le Planning."
        )
    session = GarminRepository().get_planned_session(decision.planned_session_id)
    fields: tuple[str, ...] = _PLAN_FIELDS
    if moved:
        fields = ("date",)
    elif session is not None and session.prescription is not None:
        if decision.decision not in {Decision.REST, Decision.DROP}:
            raise NothingToRevert("Cette séance possède une prescription validée.")
        fields = _STRUCTURED_FIELDS
    elif decision.decision in {Decision.REST, Decision.DROP}:
        # A rest changed the status alone: restoring only it leaves an export
        # Garmin still holds as it is (not dirty), so nothing is sent again.
        fields = _STRUCTURED_FIELDS
    original = {k: v for k, v in (decision.original or {}).items() if k in fields}
    if "date" in original:
        original["date"] = date.fromisoformat(str(original["date"]))
    changed = GarminRepository().update_planned_session_fields(
        decision.planned_session_id,
        expected_revision=decision.session_revision if athletes else None,
        **original,
        garmin_pushed_at=None,
    )
    if athletes and not changed:
        raise RevertRefused(
            "La séance a changé depuis ce choix : modifie-la depuis le Planning."
        )
    decisions.mark(decision.id, "reverted_at")
    garmin = garmin_outcome(follow_on_garmin([decision], reverted=True))
    reverted = decisions.get(decision.id)
    assert reverted is not None
    return reverted, garmin


# --------------------------------------------------------------------------- #
# The day's sessions on Garmin's calendar, through the export circuit
# --------------------------------------------------------------------------- #
def _pushing() -> bool:
    return bool((get_user_settings() or {}).get("push_to_garmin_enabled", False))


def push_today(client: GarminClient, target_date: date | None = None) -> str:
    """The daily run's push: the day's sessions through the export circuit.

    Explicit, parsed and derived steps alike; a session the export view cannot
    send, one Garmin already holds as it is, or one whose last export is
    unsettled is skipped without a request. At most ``MAX_DAILY_PUSHES``
    exports share one request and time budget; nothing is retried, and an
    ambiguous outcome stays ``uncertain`` until reconciled. Never raises.
    """
    from arete.services import garmin_export

    if not _pushing():
        return "disabled"
    day = target_date or athlete_today()
    try:
        sessions = GarminRepository().list_planned_sessions(
            start_date=day, end_date=day, status=None, limit=10, ascending=True
        )
    except Exception as e:  # noqa: BLE001 - background job must not die
        return f"failed: {e}"
    if not sessions:
        return "0 sent, 0 skipped, 0 failed"
    # The Exchange caps its own deadline at MAX_EXPORT_SECONDS.
    exchange = garmin_export.Exchange(
        client, max_calls=garmin_export.MAX_BATCH_REQUESTS
    )
    room = garmin_export.MAX_EXPORT_REQUESTS
    sent, skipped, failed = 0, 0, 0
    for session in sessions:
        if session.id is None:
            continue
        if session.status not in (
            SessionStatus.PENDING,
            SessionStatus.MODIFIED,
            SessionStatus.SKIPPED,
        ):
            continue
        try:
            if session.status == SessionStatus.SKIPPED:
                # Rest: the watch must not offer it.
                if garmin_export.on_garmin(session.id) and _affords(exchange, room):
                    _withdraw(exchange, session.id)
                continue
            prepared = garmin_export.prepare(session.id)
        except Exception:  # noqa: BLE001 - one unreadable session, not the run
            logger.warning("Garmin push check failed for %s", session.id, exc_info=True)
            failed += 1
            continue
        reason = _skip_reason(prepared)
        if reason is not None:
            logger.info("Garmin push of %s skipped: %s", session.id, reason)
            skipped += 1
            continue
        if sent + failed >= MAX_DAILY_PUSHES or not _affords(exchange, room):
            logger.info("Garmin push of %s skipped: run budget spent", session.id)
            skipped += 1
            continue
        if _send(exchange, session.id, prepared, why="push"):
            sent += 1
        else:
            failed += 1
    return f"{sent} sent, {skipped} skipped, {failed} failed"


def _skip_reason(prepared: Prepared) -> str | None:
    """Why the daily run leaves this session as it is, from its export view."""
    from arete.services import garmin_export

    view, _ = prepared
    state = view["export"]
    if not view["session"]["exportable"]:
        return view["session"]["reason"] or "not exportable"
    if state and state["state"] in {"working", "uncertain", "conflict"}:
        return f"export {state['state']}"
    if garmin_export.sent_as_is(prepared):
        return "already on Garmin"
    return None


def _affords(exchange: Exchange, requests: int) -> bool:
    """Room left in the shared budget for one more session's whole exchange."""
    return (
        exchange.calls + requests <= exchange.max_calls
        and exchange.deadline - monotonic() >= SESSION_SECONDS
    )


def _send(
    exchange: Exchange, session_id: int, prepared: Prepared | None = None, *, why: str
) -> bool:
    """One export attempt; whether Garmin confirmed it. Never raises.

    A copy sent to a watch (``transfer_requested``) goes back to that watch,
    or to Garmin Connect only once the watch is unpaired or incompatible.
    """
    from arete.services import garmin_export

    try:
        result = garmin_export.export(
            session_id, exchange=exchange, prepared=prepared, keep_device=True
        )
    except Exception:  # noqa: BLE001 - refused before any write
        logger.warning("Garmin %s of %s failed", why, session_id, exc_info=True)
        return False
    if result["state"] in {"scheduled", "transfer_requested"}:
        return True
    logger.warning(
        "Garmin %s of %s ended %s: %s",
        why,
        session_id,
        result["state"],
        result["error"],
    )
    return False


def _withdraw(exchange: Exchange, session_id: int) -> bool:
    """One withdrawal attempt, logged when unconfirmed; whether Garmin
    confirmed it. Never raises."""
    from arete.services import garmin_export

    try:
        result = garmin_export.withdraw_skipped(session_id, exchange=exchange)
    except Exception:  # noqa: BLE001 - refused before any write, or unreadable
        logger.warning("Could not withdraw %s from Garmin", session_id, exc_info=True)
        return False
    if result["state"] != "removed":
        logger.warning(
            "Garmin withdrawal unconfirmed for %s: %s", session_id, result["error"]
        )
        return False
    return True


#: The accepted week (« Ma semaine », ARE-60): at most this many sessions go
#: to Garmin in one answer, within this wait.
MAX_WEEK_PUSHES = 4
WEEK_PUSH_SECONDS = 60


def push_week(
    send: list[PlannedSession],
    withdraw: list[PlannedSession],
    client: GarminClient | None = None,
) -> dict:
    """The accepted week's key sessions through the export circuit. Never raises.

    Under the athlete's standing authorization only, as the daily push: the
    automatic push on and Garmin connected (``state`` says which is missing).
    A skipped session Garmin holds is withdrawn; the others are sent, the
    first ``MAX_WEEK_PUSHES``, except one Garmin holds as it is or whose
    export view cannot send it. One attempt each, nothing replayed: an
    ambiguous export stays ``uncertain`` until reconciled. Each session's
    outcome is ``sent``, ``already``, ``withdrawn``, ``skipped``, ``failed``
    or ``not_started`` (budget).
    """
    from arete.services import garmin_export

    if not _pushing():
        return {"state": "disabled", "sessions": []}
    try:
        if client is None:
            from arete.garmin.client import GarminClient

            client = GarminClient()
        if not client.has_tokens():
            return {"state": "disconnected", "sessions": []}
        exchange = garmin_export.Exchange(
            client,
            deadline=monotonic() + WEEK_PUSH_SECONDS,
            max_calls=MAX_WEEK_PUSHES * ANSWER_SESSION_REQUESTS,
        )
    except Exception:  # noqa: BLE001 - the plan is written; the watch is best effort
        logger.warning("Week push not started", exc_info=True)
        return {"state": "failed", "sessions": []}
    outcomes: list[dict] = []

    def report(session: PlannedSession, outcome: str) -> None:
        outcomes.append(
            {
                "planned_session_id": session.id,
                "date": session.date.isoformat(),
                "session_type": session.session_type.value,
                "outcome": outcome,
            }
        )

    for session in withdraw:
        assert session.id is not None
        try:
            held = garmin_export.on_garmin(session.id)
        except Exception:  # noqa: BLE001 - one unreadable session, not the answer
            logger.warning("Garmin state of %s unreadable", session.id, exc_info=True)
            report(session, "failed")
            continue
        if not held:
            continue
        if not _affords(exchange, ANSWER_SESSION_REQUESTS):
            report(session, "not_started")
        else:
            report(
                session, "withdrawn" if _withdraw(exchange, session.id) else "failed"
            )
    for position, session in enumerate(send):
        assert session.id is not None
        if position >= MAX_WEEK_PUSHES:
            report(session, "not_started")
            continue
        try:
            prepared = garmin_export.prepare(session.id)
        except Exception:  # noqa: BLE001 - one unreadable session, not the answer
            logger.warning("Garmin push check failed for %s", session.id, exc_info=True)
            report(session, "failed")
            continue
        reason = _skip_reason(prepared)
        if reason == "already on Garmin":
            report(session, "already")
        elif reason is not None:
            logger.info("Week push of %s skipped: %s", session.id, reason)
            report(session, "skipped")
        elif not _affords(exchange, ANSWER_SESSION_REQUESTS):
            report(session, "not_started")
        else:
            sent = _send(exchange, session.id, prepared, why="week push")
            report(session, "sent" if sent else "failed")
    return {"state": "done", "sessions": outcomes}


def follow_on_garmin(
    decisions: list[PlanDecision],
    *,
    reverted: bool = False,
    client: GarminClient | None = None,
) -> dict:
    """Bring Garmin in line with a committed answer: one attempt each, never raises.

    Only with the automatic push on, and only for a session Garmin holds: an
    applied rest withdraws it, any other change (a move included, which the
    export reschedules, or a revert) replaces it in place; a reverted rest
    sends back the session it withdrew. The whole answer waits at most
    ``ANSWER_SECONDS``: a session that does not fit is not started and keeps
    the card's send button. A failure stays in the export state the card
    shows; nothing replays it.

    What happened, as ``push_week`` reports it: ``state`` (``disabled``
    when a copy needs the push that is off, ``disconnected``, ``failed`` when
    not started, else ``done``) and each session acted on with its
    ``outcome`` (``sent``, ``withdrawn``, ``failed`` or ``not_started``); a
    session Garmin does not hold is not listed, and none means ``done``.
    """
    from arete.services import garmin_export

    try:
        actions: list[tuple[int, str]] = []
        for decision in decisions:
            session_id = decision.planned_session_id
            rest = decision.decision in {Decision.REST, Decision.DROP}
            if garmin_export.on_garmin(session_id):
                if reverted and rest:
                    state = garmin_export.export_state(session_id)
                    if state is None or state["state"] != "dirty":
                        # Never withdrawn (the push was off): Garmin still
                        # holds the session as it is.
                        continue
                actions.append(
                    (session_id, "withdraw" if rest and not reverted else "export")
                )
            elif reverted and rest:
                state = garmin_export.export_state(session_id)
                if state is not None and state["state"] == "removed":
                    actions.append((session_id, "export"))
        if not actions:
            return {"state": "done", "sessions": []}
        if not _pushing():
            # The copy stays stale: the card offers to send or withdraw it.
            return {"state": "disabled", "sessions": []}
        if client is None:
            from arete.garmin.client import GarminClient

            client = GarminClient()
            if not client.has_tokens():
                return {"state": "disconnected", "sessions": []}
        exchange = garmin_export.Exchange(
            client, deadline=monotonic() + ANSWER_SECONDS, max_calls=ANSWER_REQUESTS
        )
    except Exception:  # noqa: BLE001 - the answer is committed; the watch is best effort
        logger.warning("Garmin follow-up not started", exc_info=True)
        return {"state": "failed", "sessions": []}
    outcomes = []
    for session_id, action in actions:
        if not _affords(exchange, ANSWER_SESSION_REQUESTS):
            logger.warning("Garmin follow-up of %s not started: budget", session_id)
            outcome = "not_started"
        elif action == "withdraw":
            outcome = "withdrawn" if _withdraw(exchange, session_id) else "failed"
        else:
            outcome = (
                "sent" if _send(exchange, session_id, why="follow-up") else "failed"
            )
        outcomes.append({"planned_session_id": session_id, "outcome": outcome})
    return {"state": "done", "sessions": outcomes}


def garmin_outcome(result: dict, session_id: int | None = None) -> str:
    """One session's ``follow_on_garmin`` in one word, for the athlete.

    ``sent`` or ``withdrawn`` (the copy Garmin holds), ``failed`` or
    ``not_started`` (left in the export state the card shows, never
    replayed), ``unchanged`` (Garmin holds no copy), ``disabled`` (a copy
    the automatic push, off, did not touch) or ``disconnected``.
    ``session_id`` picks that session's outcome among several.
    """
    if result["state"] != "done":
        return str(result["state"])
    sessions = [
        s
        for s in result["sessions"]
        if session_id is None or s["planned_session_id"] == session_id
    ]
    return str(sessions[0]["outcome"]) if sessions else "unchanged"


class ProposalConflict(ValueError):
    """A stale proposal must be inspected again, never blindly replayed."""


def respond(
    decision_id: int,
    revision: int,
    action: str,
    group: Mapping[int, int] | None = None,
) -> PlanDecision:
    """Apply and record together, using the same guards as manual plan edits.

    The day's open proposals form one group, answered in one transaction or
    not at all. ``group`` maps each other decision of the day to the revision
    the athlete saw; a group that differs from the day's is a conflict.
    """
    return respond_reporting(decision_id, revision, action, group)[0]


def respond_reporting(
    decision_id: int,
    revision: int,
    action: str,
    group: Mapping[int, int] | None = None,
) -> tuple[PlanDecision, str]:
    """``respond``, with what Garmin did for this proposal's session after an
    applied answer (``garmin_outcome``; ``unchanged`` otherwise)."""
    import duckdb

    from arete.dataio import plan_changes
    from arete.dataio.db import transaction

    if action not in {"apply", "keep", "snooze"}:
        raise ValueError("Action inconnue")
    repo = PlanDecisionRepository()
    decision = repo.get(decision_id)
    if decision is None:
        raise LookupError("Proposition introuvable")
    seen = {**(group or {}), decision_id: revision}
    day = {d.id: d for d in repo.list_for_day(decision.date)}
    if not seen.keys() <= day.keys():
        # Unknown, foreign or another day's: the same answer, never an oracle.
        raise LookupError("Proposition introuvable")
    terminal = "applied" if action == "apply" else "dismissed"
    if action != "snooze" and all(day[i].state == terminal for i in seen):
        return decision, "unchanged"
    members = [d for d in day.values() if d.state in {"pending", "discussion"}]
    if {d.id for d in members} != seen.keys() or any(
        d.revision != seen[d.id] for d in members
    ):
        raise ProposalConflict("Cette proposition a changé. Recharge-la.")
    if decision.date != athlete_today():
        raise ProposalConflict("Cette proposition a expiré.")
    if action == "apply" and any(d.state == "discussion" for d in members):
        raise ProposalConflict("Discute des étapes de cette séance avec le coach.")
    try:
        with transaction() as con:
            # A proposal created since the read above joins the group: refuse.
            current = con.execute(
                "SELECT id,revision FROM app.visible_plan_decisions "
                "WHERE date=? AND state IN ('pending','discussion')",
                [decision.date],
            ).fetchall()
            if dict(current) != seen:
                raise ProposalConflict("Cette proposition a changé. Recharge-la.")
            for member in members:
                _respond_one(con, member, action, terminal)
    except duckdb.TransactionException as exc:
        raise ProposalConflict(
            "Modification concurrente : recharge la proposition."
        ) from exc
    garmin = "unchanged"
    if action == "apply":
        plan_changes.touch()
        # After the commit: the answer stands whatever Garmin says.
        garmin = garmin_outcome(follow_on_garmin(members), decision.planned_session_id)
    result = repo.get(decision_id)
    assert result is not None
    return result, garmin


def _respond_one(
    con: duckdb.DuckDBPyConnection, decision: PlanDecision, action: str, terminal: str
) -> None:
    session = con.execute(
        "SELECT revision,status,prescription,date FROM app.visible_planned_sessions WHERE id=?",
        [decision.planned_session_id],
    ).fetchone()
    # A move or a drop touches no step: a session with explicit ones allows them.
    stepless = decision.decision in {Decision.MOVE, Decision.DROP}
    if action == "apply" and (
        not session
        or session[0] != decision.session_revision
        or session[1] not in {"pending", "modified"}
        or (session[2] and not stepless)
        or session[3] != decision.date
    ):
        raise ProposalConflict("La séance a changé : examine une nouvelle proposition.")
    if action == "apply":
        # The session before the claim: its revision guard then refuses a
        # write committed since the proposal, and a racing one conflicts.
        fields = dict(decision.adapted or {})
        if "date" in fields:
            fields["date"] = date.fromisoformat(str(fields["date"]))
        if decision.decision in {Decision.REST, Decision.DROP}:
            fields["status"] = SessionStatus.SKIPPED
        elif decision.decision != Decision.MOVE:
            # A move keeps the status: its new day's readiness still weighs it.
            fields["status"] = SessionStatus.MODIFIED
        fields["garmin_pushed_at"] = None
        changed = GarminRepository().update_planned_session_fields(
            decision.planned_session_id,
            expected_revision=decision.session_revision,
            connection=con,
            **fields,
        )
        if not changed:
            raise ProposalConflict("La séance a changé.")
    state = decision.state if action == "snooze" else terminal
    claimed = con.execute(
        "UPDATE app.plan_decisions SET state=?,revision=revision+1,snoozed_until=?,applied_at=CASE WHEN ?='applied' THEN now() ELSE applied_at END "
        "WHERE user_id=getvariable('arete_athlete_id') AND deleted_at IS NULL AND id=? AND revision=? AND state IN ('pending','discussion') RETURNING id",
        [
            state,
            athlete_today() + timedelta(days=1) if action == "snooze" else None,
            state,
            decision.id,
            decision.revision,
        ],
    ).fetchone()
    if claimed is None:
        raise ProposalConflict("Cette proposition vient de changer.")
