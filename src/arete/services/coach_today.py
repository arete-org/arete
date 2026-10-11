"""Read projection shared by the home card and chat; writes are explicit."""

from datetime import date
from typing import Any

from arete.services import coach_followup
from arete.services.coaching_repository import BriefingRepository
from arete.services.plan_adaptation import adapt_today
from arete.services.plan_repository import PlanDecisionRepository

MAX_VISIBLE_ITEMS = 3


def prepare() -> None:
    adapt_today()
    coach_followup.prepare()


def today() -> dict[str, Any]:
    day = date.today()
    proposals = [
        d.to_dict()
        for d in PlanDecisionRepository().list_for_day(day)
        if d.state in {"pending", "discussion"}
        and (d.snoozed_until is None or d.snoozed_until <= day)
    ]
    from arete.garmin.repository import GarminRepository

    repo = GarminRepository()
    for proposal in proposals:
        session = repo.get_planned_session(proposal["planned_session_id"])
        if (
            session is None
            or session.revision != proposal["session_revision"]
            or session.status.value not in {"pending", "modified"}
        ):
            proposal["state"] = "stale"
    followups = coach_followup.pending(day)
    items = [{"kind": "proposal", "record": d} for d in proposals]
    items += [{"kind": "followup", "record": f} for f in followups]
    briefing = BriefingRepository().get_for_day(day)
    return {
        "date": day.isoformat(),
        "items": items[:MAX_VISIBLE_ITEMS],
        "remaining": max(0, len(items) - MAX_VISIBLE_ITEMS),
        "briefing": briefing.to_dict() if briefing else None,
    }


def reference(raw: str) -> dict[str, Any]:
    """Only identifiers cross the browser boundary; scope is checked by services."""
    import re

    match = re.fullmatch(r"(proposal|followup):([1-9][0-9]{0,9})", raw)
    if not match:
        raise ValueError("Référence de suivi invalide")
    kind, ident = match[1], int(match[2])
    if kind == "followup":
        record = coach_followup.get(ident)
    else:
        decision = PlanDecisionRepository().get(ident)
        record = decision.to_dict() if decision else None
    if record is None:
        raise LookupError("Point de coaching indisponible")
    return {"kind": kind, "record": record}
