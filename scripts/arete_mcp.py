"""Arete as a read-only MCP server, for the Claude (or other AI) you already use.

The in-app coach runs on a free model, one request per question. For deeper
analysis, this stdio server lets a stronger assistant read the same data
through the HTTP API: training load, form, sessions, health, plan, goals,
paces, the coach's facts and the weekly review. Only GET requests, nothing is
written. Sessions imported from Strava before its retirement are left out
(Strava's API agreement forbids its data in AI applications).

Run:
    uv run --extra mcp python scripts/arete_mcp.py

Environment:
    ARETE_API_URL       the API, e.g. https://arete-arete15.vercel.app/api
                        (default http://127.0.0.1:8000, a local `make dev`)
    ARETE_API_BYPASS    Vercel "Protection Bypass for Automation" secret, when
                        the deployment is behind Vercel Authentication
    ARETE_API_KEY       the instance's API key, when sign-in is enforced
                        (ARETE_AUTH=clerk): the server treats it as the athlete

Claude Code: claude mcp add arete --env ARETE_API_URL=... --env ARETE_API_BYPASS=... \
    -- uv run --directory /path/to/arete --extra mcp python scripts/arete_mcp.py
"""

from __future__ import annotations

import inspect
import json
import os
import sys
from datetime import date, timedelta
from typing import Any

import httpx

DEFAULT_URL = "http://127.0.0.1:8000"
TIMEOUT_S = 30
MAX_SESSIONS = 100
MAX_RANGE_DAYS = 120


class AreteApi:
    """GET-only client of the Arete HTTP API."""

    def __init__(
        self,
        base_url: str,
        bypass: str | None = None,
        api_key: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        headers = {"x-vercel-protection-bypass": bypass} if bypass else {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers=headers,
            timeout=TIMEOUT_S,
            transport=transport,
        )

    def get(self, path: str, **params: Any) -> Any:
        response = self._client.get(
            path, params={k: v for k, v in params.items() if v is not None}
        )
        response.raise_for_status()
        return response.json()


def _drop_series(overview: dict[str, Any]) -> dict[str, Any]:
    """Headlines and insights only: the chart points are noise for a reader."""
    cards = {
        name: {k: v for k, v in card.items() if k != "series"}
        for name, card in (overview.get("cards") or {}).items()
    }
    return {**overview, "cards": cards}


def _window(start: str, end: str) -> tuple[str, str]:
    last = date.fromisoformat(end) if end else date.today()
    first = date.fromisoformat(start) if start else last - timedelta(days=28)
    if (last - first).days > MAX_RANGE_DAYS:
        first = last - timedelta(days=MAX_RANGE_DAYS)
    return first.isoformat(), last.isoformat()


# ------------------------------------------------------------------ tools --
def training_overview(api: AreteApi, period: str = "30d") -> dict[str, Any]:
    """Volume, form (CTL/ATL/TSB), HR zones, decoupling, pace, elevation,
    cadence, recovery: each with its headline, comparison and insight."""
    return _drop_series(api.get("/analytics/overview", period=period))


def current_form(api: AreteApi) -> dict[str, Any]:
    """Today's fitness, fatigue, form, readiness (with its source) and ACWR."""
    return {
        "fitness": api.get("/metrics/fitness"),
        "workload": api.get("/metrics/workload"),
    }


def recent_sessions(api: AreteApi, limit: int = 20, offset: int = 0) -> dict[str, Any]:
    """Completed sessions, newest first (Strava imports excluded)."""
    limit = max(1, min(limit, MAX_SESSIONS))
    return api.get(
        "/analytics/sessions", limit=limit, offset=max(0, offset), for_model=True
    )


def health(api: AreteApi, start: str = "", end: str = "") -> Any:
    """Daily Garmin health (HRV, sleep, body battery, stress, resting HR,
    readiness) between two ISO dates, at most 120 days."""
    first, last = _window(start, end)
    return api.get("/garmin/health/range", start=first, end=last)


def planned_sessions(api: AreteApi, start: str = "", end: str = "") -> Any:
    """Planned sessions between two ISO dates (default: today to +28 days)."""
    first = start or date.today().isoformat()
    last = end or (date.fromisoformat(first) + timedelta(days=28)).isoformat()
    first, last = _window(first, last)
    return api.get("/garmin/planned", start_date=first, end_date=last)


def goals(api: AreteApi) -> dict[str, Any]:
    """Upcoming race goals, and the projection of form to the next one."""
    upcoming = api.get("/goals")
    nxt = api.get("/goals/next")
    projection = api.get(f"/goals/{nxt['id']}/projection") if nxt else None
    return {"goals": upcoming, "next": nxt, "projection": projection}


def paces(api: AreteApi) -> Any:
    """VDOT, Daniels training paces (s/km) and race equivalents (s)."""
    return api.get("/metrics/paces")


def coach_memory(api: AreteApi) -> dict[str, Any]:
    """What the coach knows: durable athlete facts and last week's review."""
    return {
        "facts": api.get("/athlete-facts"),
        "weekly_review": api.get("/plan/review"),
    }


TOOLS = (
    training_overview,
    current_form,
    recent_sessions,
    health,
    planned_sessions,
    goals,
    paces,
    coach_memory,
)


def build_server(api: AreteApi):
    from mcp.server import MCPServer

    server: Any = MCPServer(
        name="arete",
        instructions=(
            "Données d'entraînement d'un athlète (Arete), en lecture seule. "
            "Réponds en français, cite les chiffres avec leur période."
        ),
    )
    for fn in TOOLS:

        def bound(fn=fn):
            def call(**kwargs: Any) -> str:
                return json.dumps(fn(api, **kwargs), ensure_ascii=False, default=str)

            call.__name__ = fn.__name__
            call.__doc__ = fn.__doc__
            # Same parameters as the tool function, without the client.
            params = {k: v for k, v in fn.__annotations__.items() if k != "api"}
            params["return"] = str  # the JSON text below, not the dict
            call.__annotations__ = params
            sig = inspect.signature(fn)
            call.__signature__ = sig.replace(  # type: ignore[attr-defined]
                parameters=[p for name, p in sig.parameters.items() if name != "api"],
                return_annotation=str,
            )
            return call

        server.tool(name=fn.__name__, description=(fn.__doc__ or "").strip())(bound())
    return server


def main() -> int:
    api = AreteApi(
        os.environ.get("ARETE_API_URL", DEFAULT_URL),
        os.environ.get("ARETE_API_BYPASS") or None,
        api_key=os.environ.get("ARETE_API_KEY") or None,
    )
    build_server(api).run("stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
