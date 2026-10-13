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
from typing import TYPE_CHECKING, Any

from arete.dataio.settings import athlete_zone_model, get_user_settings
from arete.garmin.models import PlannedSession, SessionStatus
from arete.garmin.repository import GarminRepository
from arete.garmin.workout_structure import (
    NotPushable,
    derive,
    describe_fr,
    ensure_template_fits,
)
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
    from arete.garmin.workout_structure import Block

logger = logging.getLogger(__name__)

#: Bound on what the daily run sends to Garmin in one go.
MAX_DAILY_PUSHES = 3

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
# The session as watch steps, and its copy on Garmin's calendar
# --------------------------------------------------------------------------- #
def structure(session: PlannedSession) -> tuple[Block, ...]:
    """The session's steps in the athlete's zones; ``NotPushable`` says why not."""
    from arete.services.garmin_export import described_prescription

    if session.prescription is not None:
        raise NotPushable(
            "Utilise l’export Garmin de la prescription validée dans le Planning."
        )
    # Steps read from the description are explicit too: not this template.
    if described_prescription(session) is not None:
        raise NotPushable(
            "Étapes lues dans la description : envoie-les depuis le Planning."
        )
    ensure_template_fits(session)
    settings = get_user_settings() or {}
    return derive(session, athlete_zone_model(), settings.get("threshold_pace_sec_km"))


def structure_preview(session_id: int) -> dict[str, Any]:
    """What the watch would receive, or why it would receive nothing."""
    from arete.garmin.workout_structure import estimated_seconds

    session = GarminRepository().get_planned_session(session_id)
    if session is None:
        raise LookupError(f"planned session {session_id}")
    try:
        blocks = structure(session)
    except NotPushable as e:
        return {
            "pushable": False,
            "text": None,
            "estimated_min": None,
            "reason": str(e),
        }
    return {
        "pushable": True,
        "text": describe_fr(blocks),
        "estimated_min": round(estimated_seconds(blocks) / 60),
        "reason": None,
    }


def push_session(client: GarminClient, session_id: int) -> dict[str, Any]:
    """Schedule the session on Garmin's calendar, replacing an earlier copy.

    Raises ``LookupError`` (unknown session), ``NotPushable`` (no structure);
    Garmin's own errors propagate. Never retried automatically: a failed
    upload may still have created the workout.
    """
    from arete.services import garmin_export

    session = GarminRepository().get_planned_session(session_id)
    if session is None:
        raise LookupError(f"planned session {session_id}")
    # Daily adaptation must never rewrite an explicitly prescribed workout.
    structure(session)
    result = garmin_export.export(session_id, client=client)
    if result["state"] not in {"scheduled", "transfer_requested"}:
        raise ValueError(result["error"] or "Export Garmin non confirmé.")
    updated = GarminRepository().get_planned_session(session_id)
    assert updated and updated.garmin_pushed_at
    return {
        "garmin_workout_id": str(result["workout_id"]),
        "garmin_schedule_id": str(result["schedule_id"]),
        "garmin_pushed_at": updated.garmin_pushed_at.isoformat(),
    }


def push_today(client: GarminClient, target_date: date | None = None) -> str:
    """The daily run's push: today's sessions not on Garmin yet. Never raises."""
    if not bool((get_user_settings() or {}).get("push_to_garmin_enabled", False)):
        return "disabled"
    day = target_date or athlete_today()
    sent, skipped, failed = 0, 0, 0
    try:
        sessions = GarminRepository().list_planned_sessions(
            start_date=day, end_date=day, status=None, limit=10, ascending=True
        )
    except Exception as e:  # noqa: BLE001 - background job must not die
        return f"failed: {e}"
    for session in sessions:
        # Document exports and withdrawals require the athlete's explicit action.
        if session.prescription is not None:
            skipped += 1
            continue
        if (
            session.status == SessionStatus.SKIPPED
            and session.id is not None
            and (session.garmin_workout_id or session.garmin_schedule_id)
        ):
            _withdraw(client, session)  # rest day: the watch must not offer it
            continue
        if sent + failed >= MAX_DAILY_PUSHES:
            break
        if (
            session.id is None
            or session.status not in (SessionStatus.PENDING, SessionStatus.MODIFIED)
            or session.garmin_pushed_at is not None
        ):
            continue
        try:
            push_session(client, session.id)
            sent += 1
        except NotPushable:
            skipped += 1
        except Exception:  # noqa: BLE001 - one failed upload, not the run
            logger.warning(
                "Garmin push failed for session %s", session.id, exc_info=True
            )
            failed += 1
    return f"{sent} sent, {skipped} not pushable, {failed} failed"


def _withdraw(client: GarminClient, session: PlannedSession) -> None:
    from arete.services import garmin_export

    assert session.id is not None
    # The daily cancellation is explicit domain policy for skipped legacy plans.
    try:
        result = garmin_export.withdraw_skipped(session.id, client=client)
        if result["state"] != "removed":
            logger.warning(
                "Garmin withdrawal unconfirmed for %s: %s", session.id, result["error"]
            )
    except Exception:
        logger.warning(
            "Could not withdraw session %s from Garmin", session.id, exc_info=True
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
