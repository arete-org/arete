"""Analytics toolkit — narrow reads, instead of the 30-day page dump.

The injected Analytics page uses ``get_overview(period="30d")``:
eight DuckDB queries plus a 42-day EWMA, in one block, always the same window.
Fine to ground a first answer, useless to compare two periods or to look up
one number.

These tools wrap route functions that already exist, so the agent reads the
same values the pages render. Read-only. Each one validates its own bounds:
the routes get theirs from FastAPI ``Query`` metadata, which does nothing when
the function is called directly.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from langchain_core.tools import BaseTool
from pydantic import Field

from arete.agent.runtime.budget import MAX_TOOL_OUTPUT_CHARS
from arete.agent.tools.validation import typed_tool

#: Mirrors the routes' own Query bounds — see api/metrics.py.
WORKLOAD_DAYS_RANGE = (7, 90)
FITNESS_DAYS_RANGE = (14, 120)
MAX_SESSIONS = 100

#: Chronic load is a 28-day rolling average, so a shorter history leaves
#: its later weeks empty, collapses the denominator and sends ACWR through
#: the roof — a 7-day read answered 3.2 "danger" the same day the 28-day
#: read answered 0.99 "optimal". Below this, the ratio is not reported.
CHRONIC_LOAD_DAYS = 28
SPORT_TYPES = ("cardio", "strength", "mixed")


def _out(payload: Any) -> str:
    """Serialize a tool result, bounded like the page-source tool."""
    rendered = json.dumps(payload, ensure_ascii=False, default=str)
    if len(rendered) > MAX_TOOL_OUTPUT_CHARS:
        return json.dumps(
            {
                "error": (
                    f"Result too large for one read ({len(rendered)} chars). "
                    "Ask for a narrower window or a smaller limit."
                )
            }
        )
    return rendered


def _disambiguate_window(payload: dict[str, Any], days: int) -> dict[str, Any]:
    """Say which number is the window and which is the coverage.

    ``days_analyzed`` means "days that had data in them", but sitting next to
    a ``days`` argument it reads as the window — and models duly wrote "ACWR
    sur 5 jours" for a 28-day request. Renaming it at the tool boundary is
    cheaper and more reliable than asking the model to be careful.
    """
    out = dict(payload)
    out["window_days"] = days
    if "days_analyzed" in out:
        out["days_with_data"] = out.pop("days_analyzed")
    return out


def _without_meaningless_acwr(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop the acute:chronic ratio when the window cannot support it.

    Returning a number the model will quote as "danger" is worse than
    returning none: the fix is to ask again over 28 days or more.
    """
    if payload.get("window_days", 0) >= CHRONIC_LOAD_DAYS:
        return payload
    out = dict(payload)
    for key in ("acwr", "acwr_zone", "acwr_ewma", "chronic_load"):
        out.pop(key, None)
    out["acwr_unavailable"] = (
        f"ACWR needs at least {CHRONIC_LOAD_DAYS} days of history; "
        f"ask again with days={CHRONIC_LOAD_DAYS} or more. Monotony, strain "
        "and acute load below are valid for this window."
    )
    return out


def _error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _guard(value: int, bounds: tuple[int, int], name: str) -> str | None:
    low, high = bounds
    if not low <= value <= high:
        return _error(f"{name} must be between {low} and {high}, got {value}")
    return None


@typed_tool
def get_workload(days: Annotated[int, Field(ge=7, le=90)] = 28) -> str:
    """Training load over a window: ACWR (injury-risk ratio), monotony, strain,
    acute and chronic load, each with its interpretation zone. ACWR needs at
    least 28 days of history and is omitted below that; monotony, strain and
    acute load are valid on any window.

    Args:
        days: Window to analyze, 7 to 90 (default 28).
    """
    invalid = _guard(days, WORKLOAD_DAYS_RANGE, "days")
    if invalid:
        return invalid
    try:
        from arete.services.metrics import get_workload_metrics

        payload = get_workload_metrics(days=days).model_dump(mode="json")
        return _out(_without_meaningless_acwr(_disambiguate_window(payload, days)))
    except (ConnectionError, TimeoutError):
        raise  # Read-only transient failures are retried by ToolRetryMiddleware.
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")


@typed_tool
def get_fitness(days: Annotated[int, Field(ge=14, le=120)] = 42) -> str:
    """Fitness-fatigue model over a window: CTL (fitness), ATL (fatigue),
    TSB (form) with its zone, readiness and the weekly CTL ramp rate.

    Args:
        days: Window to analyze, 14 to 120 (default 42).
    """
    invalid = _guard(days, FITNESS_DAYS_RANGE, "days")
    if invalid:
        return invalid
    try:
        from arete.services.metrics import get_fitness_metrics

        payload = get_fitness_metrics(days=days).model_dump(mode="json")
        return _out(_disambiguate_window(payload, days))
    except (ConnectionError, TimeoutError):
        raise  # Read-only transient failures are retried by ToolRetryMiddleware.
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")


@typed_tool
def get_training_advice(
    sport_type: Literal["cardio", "strength", "mixed"] = "mixed",
) -> str:
    """Rule-based training advice computed from the current workload and
    fitness: overall risk level, main concern, and prioritized recommendations
    with concrete actions. Deterministic, not LLM-generated — use it as a
    second opinion on your own reading of the numbers.

    Args:
        sport_type: cardio, strength or mixed (default mixed).
    """
    if sport_type not in SPORT_TYPES:
        return _error(f"sport_type must be one of {list(SPORT_TYPES)}")
    try:
        from arete.services.metrics import get_recommendations

        return _out(get_recommendations(sport_type=sport_type).model_dump(mode="json"))
    except (ConnectionError, TimeoutError):
        raise  # Read-only transient failures are retried by ToolRetryMiddleware.
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")


@typed_tool
def list_recent_sessions(
    limit: Annotated[int, Field(ge=1, le=100)] = 20,
    offset: Annotated[int, Field(ge=0)] = 0,
) -> str:
    """Recent completed sessions, newest first: date, sport, name, duration,
    distance, average HR and pace, RPE and notes. Page backwards with offset
    to reach older sessions.

    Args:
        limit: How many sessions, 1 to 100 (default 20).
        offset: How many to skip, for paging back (default 0).
    """
    invalid = _guard(limit, (1, MAX_SESSIONS), "limit")
    if invalid:
        return invalid
    if offset < 0:
        return _error(f"offset must be 0 or more, got {offset}")
    try:
        from arete.services.analytics import list_sessions

        return _out(list_sessions(limit=limit, offset=offset, for_model=True))
    except (ConnectionError, TimeoutError):
        raise  # Read-only transient failures are retried by ToolRetryMiddleware.
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")


@typed_tool
def get_activity_detail(session_id: Annotated[int, Field(gt=0)]) -> str:
    """One completed session in detail, by its id (from list_recent_sessions):
    summary, minutes per HR zone, laps, and the analysis of its recording —
    heart-rate drift and pace:HR decoupling, pace of each half and pace fade,
    cadence variability, power — plus the work intervals of a structured
    workout, the grade-adjusted pace and best climbing speeds (m/h) on foot,
    and the weather at the start. Deterministic numbers; no raw stream.

    Args:
        session_id: The session's id.
    """
    try:
        from arete.services.activity_detail import activity_detail_for_model

        return _out(activity_detail_for_model(session_id))
    except (LookupError, PermissionError) as exc:
        return _error(str(exc))
    except (ConnectionError, TimeoutError):
        raise  # Read-only transient failures are retried by ToolRetryMiddleware.
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")


ANALYTICS_TOOLS: list[BaseTool] = [
    get_workload,
    get_fitness,
    get_training_advice,
    list_recent_sessions,
    get_activity_detail,
]
