"""Read the same domain data used by each UI page."""

import re
from datetime import timedelta
from typing import Any

from arete.services.settings import athlete_today


def _strength_sessions(**filters: Any) -> list[dict[str, Any]]:
    """Strength sessions as the Log lists them: no per-exercise detail."""
    from arete.strength.repository import StrengthRepository

    return [
        _without_nulls(
            {
                "date": s.date.isoformat(),
                "id": s.id,
                "name": s.name,
                "program": s.program,
                "duration_min": s.duration_min,
                "overall_rpe": s.overall_rpe,
                "notes": s.notes,
            }
        )
        for s in StrengthRepository().list_sessions(**filters)
    ]


def _player_stats() -> dict[str, Any]:
    """The bars as the coach reads them: the streak is not named a level, since
    with the RPG on the athlete's only "Niveau" is the RPG's."""
    from arete.services.metrics import get_player_stats

    stats: dict[str, Any] = get_player_stats().model_dump(mode="json")
    stats["weeks_at_goal_streak"] = stats.pop("level")
    return stats


def _dashboard() -> dict[str, Any]:
    """What the Dashboard shows: the bars, today's plan and sessions, the briefing.

    The read used to stop at the bars, so "what do I do today?" asked from the
    Dashboard needed another tool call to find the plan on screen.
    """
    from arete.garmin.repository import GarminRepository
    from arete.services.analytics import list_sessions
    from arete.services.coaching_repository import BriefingRepository
    from arete.services.plan_repository import PlanDecisionRepository
    from arete.services.planning import _session_to_dict

    today = athlete_today()
    planned = GarminRepository().list_planned_sessions(
        start_date=today, end_date=today, status=None, limit=10
    )
    briefing = BriefingRepository().get_for_day(today)
    return {
        "player_stats": _player_stats(),
        "planned_today": [_without_nulls(_session_to_dict(s)) for s in planned],
        "done_today": [
            s
            for s in list_sessions(limit=5, for_model=True)["sessions"]
            if s["date"] == today.isoformat()
        ],
        "strength_today": _strength_sessions(start_date=today, end_date=today),
        "briefing_today": briefing.text if briefing else None,
        # What the morning's readiness did to the plan, and why: "why did my
        # session change?" is answered from the page.
        "plan_decisions_today": [
            {
                "planned_session_id": d.planned_session_id,
                "id": d.id,
                "revision": d.revision,
                "state": d.state,
                "applied_at": d.applied_at.isoformat() if d.applied_at else None,
                "readiness_measured_on": str(d.readiness_measured_on)
                if d.readiness_measured_on
                else None,
                "decision": d.decision,
                "reason": d.reason,
                "reverted": d.reverted_at is not None,
                # The morning's suggestion an athlete's choice replaced.
                "replaced": (d.original or {}).get("replaced"),
            }
            for d in PlanDecisionRepository().list_for_day(today)
        ],
    }


def _analytics(params: dict[str, Any] | None = None) -> dict[str, Any]:
    """The Analytics page as the coach needs it: what each card says.

    Every card carried a 30-point daily series for its chart, and the series
    were 84 % of the read — 9.7k of 11.6k tokens on real data, the zones card
    alone 3.1k. The model reasons from the headline, the comparison with the
    previous period and the card's own French insight; a trend over a chosen
    window is what the analytics toolkit is for.
    """
    from arete.features.periods import DEFAULT_PERIOD, PERIOD_DAYS
    from arete.services.analytics import get_overview

    if (params or {}).get("path") == "/analytics/bilan":
        from arete.services.settings import athlete_today
        from arete.services.year_review import FIRST_YEAR, year_review

        current = athlete_today().year
        raw = (params or {}).get("param_year")
        year = (
            int(raw)
            if isinstance(raw, str)
            and re.fullmatch(r"[0-9]{4}", raw)
            and FIRST_YEAR <= int(raw) <= current
            else current
        )
        data = year_review(year)
        # Aggregates match the open year. Session names and Strava best efforts
        # stay on the browser page, just as on the ordinary Analytics page.
        return {
            "year_review": {
                key: value
                for key, value in data.items()
                if key not in {"highlights", "best_efforts", "fitness"}
            },
            "fitness": {
                key: value for key, value in data["fitness"].items() if key != "series"
            },
        }
    selected = (params or {}).get("param_period")
    period = (
        selected
        if isinstance(selected, str) and selected in PERIOD_DAYS
        else DEFAULT_PERIOD
    )
    overview = get_overview(period=period)
    cards = {
        name: {k: v for k, v in card.items() if k != "series"}
        for name, card in overview.get("cards", {}).items()
    }
    return {
        "overview": {**overview, "cards": cards},
        "trends": "analytics toolkit: get_workload(days), get_fitness(days)",
    }


#: What a Planning page read covers: the week just gone and three ahead.
#: The whole plan used to be read at once, and a plan runs months out — 109
#: sessions to December on real data, 35k characters — so it overflowed the
#: read bound and the coach on the Planning page could not see the plan at
#: all. Anything further is one `list_planned` call away in the planning
#: toolkit.
PLANNING_PAST_DAYS = 7
PLANNING_AHEAD_DAYS = 21


def _without_nulls(row: dict[str, Any]) -> dict[str, Any]:
    """Drop empty fields: a null is a token spent saying nothing."""
    return {k: v for k, v in row.items() if v is not None and v != ""}


#: Completed sessions a Planning read lists, newest first, from the window's start.
#: The plan alone already fills ~20k of the 32k-character bound on real data.
PLANNING_DONE_LIMIT = 15


def _planning() -> dict[str, Any]:
    """The plan of the window, and what was actually done in its past days.

    The plan alone hid the athlete's sessions: asked to keep today's run and
    clear the rest, the coach saw no run and deleted every planned session.
    """
    from arete.garmin.repository import GarminRepository
    from arete.services.analytics import list_sessions
    from arete.services.planning import _session_to_dict

    today = athlete_today()
    start = today - timedelta(days=PLANNING_PAST_DAYS)
    end = today + timedelta(days=PLANNING_AHEAD_DAYS)
    # API default params are FastAPI Query objects; call with plain values.
    sessions = GarminRepository().list_planned_sessions(
        start_date=start, end_date=end, status=None, limit=200
    )
    rows = sorted(
        (_without_nulls(_session_to_dict(s)) for s in sessions),
        key=lambda row: row["date"],
    )
    return {
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "planned_sessions": rows,
        "done_sessions": [
            _without_nulls(s)
            for s in list_sessions(limit=PLANNING_DONE_LIMIT, for_model=True)[
                "sessions"
            ]
            if s["date"] >= start.isoformat()
        ],
        "beyond_the_window": "planning toolkit: list_planned(start_date, end_date); "
        "done sessions: list_recent_sessions",
    }


def _log() -> dict[str, Any]:
    """Both tabs of the Log: cardio sessions and strength sessions."""
    from arete.services.analytics import list_sessions

    return {
        "recent_sessions": list_sessions(limit=20, offset=0, for_model=True),
        "recent_strength_sessions": _strength_sessions(limit=10),
    }


def _settings() -> dict[str, Any]:
    from arete.services.settings import get_settings

    # Identity stays out of the prompt: the coach has no use for it, and the
    # page data goes to the model provider (and to LangSmith when tracing).
    return {
        "settings": get_settings().model_dump(
            mode="json", exclude={"email", "display_name"}
        )
    }


def _profile() -> dict[str, Any]:
    from arete.services.gamification import snapshot

    state = snapshot()
    # The ledger and identity are deliberately not sent to the model.
    return {
        "player": {
            key: state[key]
            for key in (
                "enabled",
                "level",
                "rank",
                "xp",
                "shards",
                "sessions",
                "equipped",
                "week",
            )
        }
    }


def _follow_up() -> dict[str, Any]:
    from arete.services import automations, inbox

    return {"automations": automations.listing(), "inbox": inbox.listing()}


_PAGE_FETCHERS = {
    "follow_up": _follow_up,
    "profile": _profile,
    "dashboard": _dashboard,
    "planning": _planning,
    "log": _log,
    "settings": _settings,
}


def _log_selection(params: dict[str, Any]) -> dict[str, Any]:
    """Resolve only known selectors; client metadata never supplies page facts."""
    from dataclasses import asdict

    from arete.services.activity_detail import activity_detail_for_model
    from arete.strength.repository import StrengthRepository

    path = params.get("path", "")
    match = (
        re.fullmatch(r"/log/sessions/([0-9]{1,16})/?", path)
        if isinstance(path, str)
        else None
    )
    if match:
        return {"activity": activity_detail_for_model(int(match[1]))}
    result: dict[str, Any] = {
        "active_tab": "cardio" if params.get("param_tab") == "cardio" else "force"
    }
    session_id = params.get("param_session")
    if isinstance(session_id, str) and re.fullmatch(r"[0-9]{1,16}", session_id):
        session = StrengthRepository().get_session(int(session_id))
        result["selected_strength_session"] = asdict(session) if session else None
    return result


def get_page_data(page: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
    from arete.services.gamification import preference

    result = _analytics(params) if page == "analytics" else _PAGE_FETCHERS[page]()
    if page == "log":
        result.update(_log_selection(params or {}))
    if preference()["enabled"]:
        result["coach_identity"] = (
            "Chiron — Coach Arete. Mentor grec calme et exigeant, distinct du personnage joueur. Explique les faits sans inventer de récompenses."
        )
    return result
