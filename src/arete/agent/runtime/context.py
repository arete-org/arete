"""Agent run context and panel-context budget constants.

The panel carries the page the user is looking at (route + query params), not
an editable draft, so there is no live-draft machinery here.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID, uuid4

if TYPE_CHECKING:
    from arete.agent.profiles.models import AgentProfile
    from arete.agent.runtime.surface import SurfaceDecision
    from arete.services.calendar import CalendarService
    from arete.services.slack_product import SlackProduct

from arete.agent.runtime.budget import MAX_TOOL_CONCURRENCY

#: Key under which the API layer stamps the open-page payload in the source
#: dict. ``agent/context/sections.py`` is the reader; ``api/agent.py`` is the
#: only writer.
PANEL_CONTEXT_KEY = "panel_context"

#: Budget for one serialized panel-context payload. Over it the injection is
#: SKIPPED, never truncated — half a JSON payload parses as a different page.
MAX_PANEL_CONTEXT_CHARS = 64_000

#: Route names the frontend can send. Anything else is rejected at the API
#: boundary before any server-side page read.
PANEL_PAGES = frozenset(
    {"dashboard", "planning", "analytics", "log", "settings", "profile"}
)


@dataclass
class RunStats:
    """What one run cost: model requests are the scarce resource on a free tier."""

    model_calls: int = 0
    skill_reads: int = 0
    skill_read_ms: int = 0
    skill_read_tokens_approx: int = 0
    memory_searches: int = 0
    memory_ms: int = 0
    memory_tokens: int = 0
    tool_calls: int = 0
    model_ms: int = 0
    first_token_ms: int | None = None
    first_result_ms: int | None = None
    served_models: list[str] = field(default_factory=list)


def _athlete_today() -> date:
    from arete.services.settings import athlete_today

    return athlete_today()


@dataclass
class AgentContext:
    """Per-run context handed to ``create_agent(context_schema=...)``.

    ``source`` is a plain dict the API layer stamps before invoking the graph.
    Only ``PANEL_CONTEXT_KEY``
    inside it is read by the middleware.
    """

    source: dict[str, Any] = field(default_factory=dict)
    # Selected by the server entrypoint, never from panel_context or messages.
    profile: Literal["chat", "briefing", "feedback", "review", "slack"] = "chat"
    resolved_profile: AgentProfile | None = field(default=None, init=False, repr=False)
    calendar: CalendarService | None = field(default=None, init=False, repr=False)
    thread_id: str | None = None
    # One graph run per turn; browser feedback uses this as its trace root.
    # Slack has an outer trace covering classification and delivery as well.
    run_id: UUID = field(default_factory=uuid4, init=False)
    # Clerk user id from the verified request identity, never from the body.
    account_id: str = ""
    document_ids: tuple[str, ...] | None = None
    # Slack only: who reads the answer. None for the browser and missions.
    slack_visibility: Literal["private", "public"] | None = None
    slack_product: SlackProduct | None = field(default=None, repr=False)
    slack_decision: SurfaceDecision | None = field(default=None, repr=False)
    classifier_calls: int = 0
    run_logged: bool = False
    attachment_paths: tuple[str, ...] = ()
    # The athlete's calendar day (their timezone), fixed for the invocation.
    current_date: date = field(default_factory=_athlete_today)
    deadline: float | None = field(default=None, init=False)
    started_at: float | None = field(default=None, init=False)
    stats: RunStats = field(default_factory=RunStats, init=False, repr=False)
    # The open page's data, cached per run and invalidated after domain actions.
    page_section: str | None = field(default=None, init=False, repr=False)
    # Paths only: skill bodies enter messages through read_file results.
    requested_skills: tuple[str, ...] = field(default=(), init=False)
    # Async ToolNode uses gather(), ignoring RunnableConfig concurrency.
    tool_slots: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(MAX_TOOL_CONCURRENCY),
        init=False,
        repr=False,
    )

    @property
    def panel_context(self) -> dict[str, Any] | None:
        """Parsed ``source.panel_context`` payload, or None."""
        raw = self.source.get(PANEL_CONTEXT_KEY)
        if isinstance(raw, str) and raw:
            import json

            try:
                payload = json.loads(raw)
            except ValueError:
                return None
            return payload if isinstance(payload, dict) else None
        if isinstance(raw, dict):
            return raw
        return None
