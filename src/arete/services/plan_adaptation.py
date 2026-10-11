"""Apply the morning's decisions to today's plan, and take them back.

``adaptation.evaluate`` decides; this module reads the facts, claims one
decision per session and day, writes the planned session and keeps what it
replaced so the athlete can revert in one tap. Called by the daily run (after
the health sync, before the briefing) and by ``POST /plan/today/adapt``.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import TYPE_CHECKING, Any

from arete.dataio.settings import athlete_zone_model, get_user_settings
from arete.garmin.models import PlannedSession, SessionStatus
from arete.garmin.repository import GarminRepository
from arete.garmin.workout_structure import NotPushable, derive, describe_fr
from arete.services.adaptation import AdaptationInput, Decision, evaluate
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.plan_repository import (
    AlreadyDecided,
    PlanDecision,
    PlanDecisionRepository,
)
from arete.services.settings import athlete_today

if TYPE_CHECKING:
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

    ``respect_setting`` is the daily run's: with the switch off it writes
    nothing. An explicit request from the athlete ignores it.
    """
    from arete.services.coaching_rules import rule_facts

    day = target_date or athlete_today()
    decisions = PlanDecisionRepository()
    if respect_setting and not auto_adapt_enabled():
        return decisions.list_for_day(day)

    planned_repo = GarminRepository()
    sessions = planned_repo.list_planned_sessions(
        start_date=day, end_date=day, status=None, limit=10, ascending=True
    )
    decided = {d.planned_session_id for d in decisions.list_for_day(day)}
    # Imported prescriptions were explicitly reviewed; summary-field adaptation
    # cannot faithfully rewrite their steps or their source evidence.
    pending = [
        s
        for s in sessions
        if s.id is not None and s.id not in decided and s.prescription is None
    ]
    if not pending:
        return decisions.list_for_day(day)

    facts = rule_facts(day)
    for session in pending:
        assert session.id is not None
        outcome = evaluate(
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
        )
        if outcome is None:
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
            )
        except AlreadyDecided:
            continue  # another run claimed it first: its decision stands
        if outcome.decision in (Decision.EASE, Decision.REPLACE_EASY):
            # garmin_pushed_at cleared: a copy sent before the change is stale,
            # the next push replaces it.
            planned_repo.update_planned_session_fields(
                session.id,
                **outcome.adapted,
                status=SessionStatus.MODIFIED,
                garmin_pushed_at=None,
            )
        elif outcome.decision == Decision.REST:
            planned_repo.update_planned_session_fields(
                session.id, status=SessionStatus.SKIPPED, garmin_pushed_at=None
            )
        decisions.mark(decision.id, "applied_at")
        if respect_setting and outcome.decision != Decision.KEEP:
            # The daily run changed the plan before the athlete looked: say so.
            from arete.services.notifications import notify

            notify("Séance adaptée", outcome.reason, "/", kind="adapted_session")
        logger.info(
            "Plan decision for session %s: %s (%s)",
            session.id,
            outcome.decision.value,
            outcome.reason,
        )
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
    if decision.reverted_at is not None or decision.decision == Decision.KEEP.value:
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
    if session.prescription is not None:
        raise NotPushable(
            "Utilise l’export Garmin de la prescription validée dans le Planning."
        )
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
