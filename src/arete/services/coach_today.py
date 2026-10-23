"""Read projection shared by the home card and chat; writes are explicit."""

from datetime import date
from typing import Any

from arete.dataio.db import db_connection
from arete.services import coach_followup
from arete.services.coaching_repository import Briefing, BriefingRepository
from arete.services.plan_adaptation import adapt_today
from arete.services.plan_repository import PlanDecision, PlanDecisionRepository
from arete.services.settings import athlete_today

MAX_VISIBLE_ITEMS = 3


def prepare() -> None:
    adapt_today()
    coach_followup.prepare()


def today() -> dict[str, Any]:
    day = athlete_today()
    with db_connection() as con:
        return card(
            con,
            day,
            PlanDecisionRepository().list_for_day(day, con=con),
            BriefingRepository().get_for_day(day, con=con),
        )


def card(
    con, day: date, decisions: list[PlanDecision], briefing: Briefing | None
) -> dict[str, Any]:
    """The day's card from its decisions and briefing, already read on ``con``."""
    # The day's open proposals are answered together, so they form one card.
    group = [d for d in decisions if d.state in {"pending", "discussion"}]
    # A response snoozes the whole group. Legacy rows snoozed one by one hide
    # only themselves, but ``members`` still names them for the response.
    members = [{"id": d.id, "revision": d.revision} for d in group]
    shown = [d for d in group if d.snoozed_until is None or d.snoozed_until <= day]
    # The session that keeps a training load leads the card.
    proposals = [d.to_dict() for d in sorted(shown, key=lambda d: d.decision == "rest")]
    from arete.garmin.repository import GarminRepository

    sessions = GarminRepository().get_planned_sessions(
        [p["planned_session_id"] for p in proposals], connection=con
    )
    # A missed session's replanning no longer fits a day that has trained since.
    from arete.services.missed_sessions import trained_on
    from arete.services.plan_repository import MISSED_REPLAN

    trained = any(
        p["readiness_source"] == MISSED_REPLAN for p in proposals
    ) and trained_on(con, day)
    for proposal in proposals:
        session = sessions.get(proposal["planned_session_id"])
        if (
            session is None
            or session.revision != proposal["session_revision"]
            or session.status.value not in {"pending", "modified"}
            or (trained and proposal["readiness_source"] == MISSED_REPLAN)
        ):
            proposal["state"] = "stale"
    followups = coach_followup.pending(day, con)
    items: list[dict[str, Any]] = (
        [
            {
                "kind": "proposal",
                "record": proposals[0],
                "group": proposals,
                "members": members,
            }
        ]
        if proposals
        else []
    )
    items += [{"kind": "followup", "record": f} for f in followups]
    return {
        "date": day.isoformat(),
        "items": items[:MAX_VISIBLE_ITEMS],
        "remaining": max(0, len(items) - MAX_VISIBLE_ITEMS),
        "briefing": briefing.to_dict() if briefing else None,
    }


def reference(raw: str) -> dict[str, Any]:
    """Only identifiers cross the browser boundary; scope is checked by services."""
    import re

    if raw == "onboarding:1":
        from arete.services.onboarding import confirmed_context

        return {"kind": "onboarding", "record": confirmed_context()}
    if re.fullmatch(r"automation_run:[0-9a-f-]{36}", raw):
        from arete.services.automations import run_detail

        return {"kind": "automation_run", "record": run_detail(raw.split(":", 1)[1])}
    match = re.fullmatch(
        r"(proposal|followup|briefing|review|session|evening):([1-9][0-9]{0,9})", raw
    )
    if not match:
        raise ValueError("Référence de suivi invalide")
    kind, ident = match[1], int(match[2])
    if kind == "followup":
        record = coach_followup.get(ident)
    elif kind == "review":
        # « Ajuster avec le coach » on « Ma semaine »: the week's review and
        # its proposals, read from the athlete's own rows.
        from arete.services.weekly_review import get_review_by_id

        review = get_review_by_id(ident)
        record = review.to_dict() if review else None
    elif kind == "session":
        # « Modifier » › « Autre… »: today's session and the rules' options.
        from arete.services.renegotiation import coach_context

        record = coach_context(ident)
    elif kind == "evening":
        # The push of the evening message: its text, question and answer.
        from arete.services.evening_message import get as evening

        message = evening(ident)
        record = message.to_dict() if message else None
    elif kind == "briefing":
        # The athlete asks about a briefing: the coach reads its text, quoted.
        briefing = BriefingRepository().get(ident)
        record = briefing.to_dict() if briefing else None
    else:
        decision = PlanDecisionRepository().get(ident)
        record = decision.to_dict() if decision else None
    if record is None:
        raise LookupError("Point de coaching indisponible")
    return {"kind": kind, "record": record}
