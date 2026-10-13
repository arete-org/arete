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
    AlreadyDecided,
    PlanDecision,
    PlanDecisionRepository,
)
from arete.services.settings import athlete_today

if TYPE_CHECKING:
    import duckdb

    from arete.garmin.client import GarminClient
    from arete.services.garmin_export import Exchange

logger = logging.getLogger(__name__)

#: Bound on what the daily run sends to Garmin in one go.
MAX_DAILY_PUSHES = 3
#: One run's requests to Garmin, shared by its sessions (12 at most each).
MAX_DAILY_REQUESTS = 60
#: Time a session's exchange needs before the run's shared deadline (120 s).
MIN_SECONDS_PER_SESSION = 30

#: The planning fields a decision may overwrite, saved before it does.
_PLAN_FIELDS = (
    "session_type",
    "target_duration_min",
    "target_hr_zone",
    "target_intensity",
    "description",
    "status",
)


def _snapshot(session: PlannedSession) -> dict[str, Any]:
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
                original=_snapshot(session),
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


def revert(decision_id: int) -> PlanDecision:
    """Put the planned session back as it was before the decision.

    Raises ``LookupError`` for an unknown id and ``NothingToRevert`` for a
    keep or a decision already reverted. A copy already scheduled on Garmin
    is marked unsent: its ids stay, so the next push replaces it instead of
    leaving it on the calendar beside the original.
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
    session = GarminRepository().get_planned_session(decision.planned_session_id)
    if session is not None and session.prescription is not None:
        raise NothingToRevert("Cette séance possède une prescription validée.")
    original = {k: v for k, v in (decision.original or {}).items() if k in _PLAN_FIELDS}
    GarminRepository().update_planned_session_fields(
        decision.planned_session_id,
        **original,
        garmin_pushed_at=None,
    )
    decisions.mark(decision.id, "reverted_at")
    reverted = decisions.get(decision.id)
    assert reverted is not None
    return reverted


# --------------------------------------------------------------------------- #
# The day's sessions on Garmin's calendar, through the export circuit
# --------------------------------------------------------------------------- #
def push_today(client: GarminClient, target_date: date | None = None) -> str:
    """The daily run's push: the day's sessions through the export circuit.

    Explicit, parsed and derived steps alike; a session the export view cannot
    send, one Garmin already holds as it is, or one whose last export is
    unsettled is skipped without a request. At most ``MAX_DAILY_PUSHES``
    exports share one request and time budget; nothing is retried, and an
    ambiguous outcome stays ``uncertain`` until reconciled. Never raises.
    """
    from arete.services import garmin_export

    if not bool((get_user_settings() or {}).get("push_to_garmin_enabled", False)):
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
    exchange = garmin_export.Exchange(client, max_calls=MAX_DAILY_REQUESTS)
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
                if garmin_export.on_garmin(session.id) and _affords(exchange):
                    _withdraw(exchange, session.id)
                continue
            reason = _skip_reason(session.id)
        except Exception:  # noqa: BLE001 - one unreadable session, not the run
            logger.warning("Garmin push check failed for %s", session.id, exc_info=True)
            failed += 1
            continue
        if reason is not None:
            logger.info("Garmin push of %s skipped: %s", session.id, reason)
            skipped += 1
            continue
        if sent + failed >= MAX_DAILY_PUSHES or not _affords(exchange):
            logger.info("Garmin push of %s skipped: run budget spent", session.id)
            skipped += 1
            continue
        try:
            result = garmin_export.export(session.id, exchange=exchange)
        except Exception:  # noqa: BLE001 - refused before any write
            logger.warning("Garmin push failed for %s", session.id, exc_info=True)
            failed += 1
            continue
        if result["state"] in {"scheduled", "transfer_requested"}:
            sent += 1
        else:
            logger.warning(
                "Garmin push of %s ended %s: %s",
                session.id,
                result["state"],
                result["error"],
            )
            failed += 1
    return f"{sent} sent, {skipped} skipped, {failed} failed"


def _skip_reason(session_id: int) -> str | None:
    """Why the daily run leaves this session as it is, from the export view."""
    from arete.services import garmin_export

    view = garmin_export.inspect_session(session_id, include_steps=False)
    state = view["export"]
    if not view["session"]["exportable"]:
        return view["session"]["reason"] or "not exportable"
    if state and state["state"] in {"working", "uncertain", "conflict"}:
        return f"export {state['state']}"
    if garmin_export.sent_as_is(session_id, state):
        return "already on Garmin"
    return None


def _affords(exchange: Exchange) -> bool:
    """Room left for one more session's full exchange in the shared budget."""
    from arete.services.garmin_export import MAX_EXPORT_REQUESTS

    return (
        exchange.calls + MAX_EXPORT_REQUESTS <= exchange.max_calls
        and exchange.deadline - monotonic() >= MIN_SECONDS_PER_SESSION
    )


def _withdraw(exchange: Exchange, session_id: int) -> None:
    """One withdrawal attempt, logged when unconfirmed. Never raises."""
    from arete.services import garmin_export

    try:
        result = garmin_export.withdraw_skipped(session_id, exchange=exchange)
    except Exception:  # noqa: BLE001 - refused before any write, or unreadable
        logger.warning("Could not withdraw %s from Garmin", session_id, exc_info=True)
        return
    if result["state"] != "removed":
        logger.warning(
            "Garmin withdrawal unconfirmed for %s: %s", session_id, result["error"]
        )


def follow_on_garmin(
    decisions: list[PlanDecision], client: GarminClient | None = None
) -> None:
    """Bring Garmin in line with applied decisions: one attempt each, never raises.

    Only a session Garmin may already hold is touched: a rest withdraws it, any
    other change replaces it in place. A failure stays in the export state the
    card shows; nothing replays it.
    """
    from arete.services import garmin_export

    try:
        held = [d for d in decisions if garmin_export.on_garmin(d.planned_session_id)]
        if not held:
            return
        if client is None:
            from arete.garmin.client import GarminClient

            client = GarminClient()
            if not client.has_tokens():
                return
        exchange = garmin_export.Exchange(client, max_calls=MAX_DAILY_REQUESTS)
    except Exception:  # noqa: BLE001 - the answer is committed; the watch is best effort
        logger.warning("Garmin follow-up not started", exc_info=True)
        return
    for decision in held:
        session_id = decision.planned_session_id
        if not _affords(exchange):
            logger.warning("Garmin follow-up of %s skipped: budget spent", session_id)
            continue
        if decision.decision == Decision.REST:
            _withdraw(exchange, session_id)
            continue
        try:
            result = garmin_export.export(session_id, exchange=exchange)
        except Exception:  # noqa: BLE001 - refused before any write
            logger.warning("Garmin follow-up failed for %s", session_id, exc_info=True)
            continue
        if result["state"] not in {"scheduled", "transfer_requested"}:
            logger.warning(
                "Garmin follow-up of %s ended %s: %s",
                session_id,
                result["state"],
                result["error"],
            )


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
        return decision
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
    if action == "apply":
        plan_changes.touch()
        # After the commit: the answer stands whatever Garmin says.
        follow_on_garmin(members)
    result = repo.get(decision_id)
    assert result is not None
    return result


def _respond_one(
    con: duckdb.DuckDBPyConnection, decision: PlanDecision, action: str, terminal: str
) -> None:
    session = con.execute(
        "SELECT revision,status,prescription,date FROM app.visible_planned_sessions WHERE id=?",
        [decision.planned_session_id],
    ).fetchone()
    if action == "apply" and (
        not session
        or session[0] != decision.session_revision
        or session[1] not in {"pending", "modified"}
        or session[2]
        or session[3] != decision.date
    ):
        raise ProposalConflict("La séance a changé : examine une nouvelle proposition.")
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
    if action == "apply":
        fields = dict(decision.adapted or {})
        fields["status"] = (
            SessionStatus.SKIPPED
            if decision.decision == Decision.REST
            else SessionStatus.MODIFIED
        )
        fields["garmin_pushed_at"] = None
        changed = GarminRepository().update_planned_session_fields(
            decision.planned_session_id,
            expected_revision=decision.session_revision,
            connection=con,
            **fields,
        )
        if not changed:
            raise ProposalConflict("La séance a changé.")
