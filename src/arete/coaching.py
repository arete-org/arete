"""Application composition for chat, API cards and scheduled coaching.

Only this composition root imports the agent factory. Domain producers receive
plain callbacks, so they remain usable and testable without an agent framework.
"""

from collections.abc import Awaitable, Callable
from contextlib import aclosing
from dataclasses import replace
from datetime import date
from functools import lru_cache, wraps
from pathlib import Path
from threading import Lock
from typing import Any, Literal

from arete.agent.backends.memory import build_memory_filesystem
from arete.agent.backends.skills import SystemSkillsBackend
from arete.agent.factory import build_agent
from arete.agent.middlewares.skills import SystemSkillsMiddleware
from arete.agent.models.providers import build_chat_model
from arete.agent.models.registry import (
    AGENT_MAX_RETRIES,
    AGENT_MAX_TOKENS,
)
from arete.agent.models.routing import resolve_route
from arete.agent.profiles.catalog import get_profile
from arete.agent.runtime.budget import MAX_GRAPH_STEPS
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.execution import invoke_agent_sync
from arete.calendar import get_calendar_service
from arete.config import config
from arete.services import briefing, coaching_rules, session_feedback, weekly_review
from arete.services.athlete_scope import current_athlete_id, resolve_athlete_id
from arete.services.coaching_repository import Briefing
from arete.services.feature_flags import get_feature_flags, glm_flash_available
from arete.services.system_skills import publish_bundle

AGENT_RECURSION_LIMIT = MAX_GRAPH_STEPS
SYSTEM_SKILLS_ROOT = Path(__file__).parent / "agent" / "skills" / "system"


MAX_CACHED_ATHLETES = 32
_graph_lock = Lock()


def _serialized(factory):
    # lru_cache allows duplicate construction during concurrent first access.
    @wraps(factory)
    def get():
        with _graph_lock:
            glm_flash = get_feature_flags().glm_flash and glm_flash_available()
            return factory(current_athlete_id(), glm_flash=glm_flash)

    get.cache_clear = factory.cache_clear
    return get


def _assemble(profile_id: str, *, glm_flash: bool = False):
    profile = get_profile(profile_id)
    calendar = None
    if profile_id == "chat" and config.google_calendar_configured:
        calendar = get_calendar_service
        profile = replace(
            profile,
            capabilities=(*profile.capabilities, "calendar"),
        )
    route = resolve_route(glm_flash=glm_flash)
    # Use one explicit request per candidate: layering SDK retries and the
    # router's fallback list would multiply requests and exhaust the deadline.
    candidates = tuple(dict.fromkeys((route.model, *route.fallbacks)))
    models = tuple(
        build_chat_model(
            route=replace(route, model=name, fallbacks=()),
            max_retries=(
                0
                if len(candidates) > 1 or route.openrouter_policy == "glm_flash"
                else AGENT_MAX_RETRIES
            ),
        )
        for name in candidates
    )
    model = models[0]
    skills_backend = None
    skill_files = {}
    if profile.journal_tools:
        skill_files = publish_bundle(SYSTEM_SKILLS_ROOT)
        skills_backend = SystemSkillsBackend(skill_files)
    filesystem = build_memory_filesystem(system_skills=skills_backend)
    skills = (
        SystemSkillsMiddleware(
            backend=filesystem.backend,
            paths=set(skill_files),
        )
        if skills_backend is not None
        else None
    )
    graph = build_agent(
        profile,
        model=model,
        context_tokens=route.context_tokens,
        output_tokens=AGENT_MAX_TOKENS,
        filesystem=filesystem,
        calendar=calendar,
        fallback_models=models[1:],
        skills=skills,
    )
    return graph.with_config(
        metadata={"model": route.model, "model_policy": route.openrouter_policy}
    )


def system_skill_catalog() -> list[dict]:
    """Use native discovery without constructing a model or requiring its key."""
    from deepagents.backends import CompositeBackend

    from arete.agent.backends.skills import SYSTEM_SKILLS_ROUTE

    files = publish_bundle(SYSTEM_SKILLS_ROOT)
    backend = SystemSkillsBackend(files)
    middleware = SystemSkillsMiddleware(
        backend=CompositeBackend(
            default=backend, routes={SYSTEM_SKILLS_ROUTE: backend}
        ),
        paths=set(files),
    )
    discovered = middleware.before_agent({}, None, {})["skills_metadata"]
    return [
        {key: skill[key] for key in ("name", "description", "path")}
        for skill in sorted(discovered, key=lambda item: item["name"])
    ]


@_serialized
@lru_cache(maxsize=MAX_CACHED_ATHLETES)
def get_agent(athlete_id: int, *, glm_flash: bool = False):
    assert athlete_id == current_athlete_id()
    return _assemble("chat", glm_flash=glm_flash)


async def run_slack_coach(
    messages: list[dict[str, str]],
    thread_id: str,
    visibility: Literal["private", "public"],
    emit: Callable[[dict], Awaitable[None]],
) -> str:
    """Slack supplies its own history; reuse the chat graph and runtime limits."""
    from langchain_core.messages import AIMessage

    from arete.agent.runtime.execution import stream_agent
    from arete.agent.runtime.streaming import MAX_STREAM_EVENTS, StreamProjection

    projection = StreamProjection()
    answer = ""
    count = 0
    async with aclosing(
        stream_agent(
            get_agent(),
            {"messages": messages},
            context=AgentContext(thread_id=thread_id, slack_visibility=visibility),
        )
    ) as stream:
        async for part in stream:
            count += 1
            if count > MAX_STREAM_EVENTS:
                raise ValueError("Le stream dépasse la limite d’événements.")
            # Tokens are provisional: only a completed, tool-free model update
            # can become canonical Slack history after provider fallback.
            if part.get("type") == "updates" and not part.get("ns"):
                for message in (part["data"].get("model") or {}).get("messages", []):
                    if isinstance(message, AIMessage):
                        answer = message.text if not message.tool_calls else ""
            for event in projection.events(part):
                await emit(event)
    if not answer.strip():
        raise RuntimeError("Agent returned an empty Slack answer")
    return answer


@_serialized
@lru_cache(maxsize=MAX_CACHED_ATHLETES)
def build_briefing_agent(athlete_id: int, *, glm_flash: bool = False):
    assert athlete_id == current_athlete_id()
    return _assemble("briefing", glm_flash=glm_flash)


@_serialized
@lru_cache(maxsize=MAX_CACHED_ATHLETES)
def build_feedback_agent(athlete_id: int, *, glm_flash: bool = False):
    assert athlete_id == current_athlete_id()
    return _assemble("feedback", glm_flash=glm_flash)


@_serialized
@lru_cache(maxsize=MAX_CACHED_ATHLETES)
def build_review_agent(athlete_id: int, *, glm_flash: bool = False):
    assert athlete_id == current_athlete_id()
    return _assemble("review", glm_flash=glm_flash)


def _run_mission(graph, profile: str, message: str, max_chars: int) -> str:
    result = invoke_agent_sync(
        graph,
        {"messages": [{"role": "user", "content": message}]},
        context=AgentContext(profile=profile),  # type: ignore[arg-type]
    )
    messages = result.get("messages", [])
    if not messages:
        raise RuntimeError("Agent returned no messages")
    text = (messages[-1].text or "").strip()
    if not text:
        raise RuntimeError("Agent returned an empty answer")
    if len(text) > max_chars:
        raise RuntimeError(
            f"Answer too long for the {profile} card ({len(text)} chars)"
        )
    return text


def run_briefing(facts: str) -> str:
    return _run_mission(
        build_briefing_agent(), "briefing", facts, briefing.MAX_BRIEFING_CHARS
    )


def run_feedback(facts: str) -> str:
    return _run_mission(
        build_feedback_agent(), "feedback", facts, session_feedback.MAX_FEEDBACK_CHARS
    )


def run_feedback_batch(facts: str, count: int) -> str:
    """One feedback request answering ``count`` numbered sessions."""
    return _run_mission(
        build_feedback_agent(),
        "feedback",
        facts,
        session_feedback.MAX_FEEDBACK_CHARS * count,
    )


def write_sync_feedback(session_ids: list[int]) -> dict[str, Any]:
    """Feedback on the sessions a sync imported, in one model request."""
    return coaching_rules.sync_feedback(session_ids, produce=run_feedback_batch)


def run_review(facts: str) -> str:
    return _run_mission(
        build_review_agent(), "review", facts, weekly_review.MAX_REVIEW_CHARS
    )


def generate_weekly_review(*, refresh: bool = False) -> weekly_review.Review:
    return weekly_review.generate_review(run_review, refresh=refresh)


def generate_briefing(
    *, trigger: str = "api", target_date: date | None = None, user_id: int | None = None
) -> Briefing:
    user_id = resolve_athlete_id(user_id)
    return briefing.generate_briefing(
        produce=run_briefing, trigger=trigger, target_date=target_date, user_id=user_id
    )


def get_or_create_briefing(
    *, trigger: str = "api", target_date: date | None = None, user_id: int | None = None
) -> Briefing:
    user_id = resolve_athlete_id(user_id)
    return briefing.get_or_create_briefing(
        produce=run_briefing, trigger=trigger, target_date=target_date, user_id=user_id
    )


def enrich_session_feedback(
    rule_feedback: str,
    highlights: list[str],
    evidence: session_feedback.SessionEvidence | None = None,
) -> tuple[str, Literal["agent", "rules"]]:
    return session_feedback.enrich_session_feedback(
        rule_feedback, highlights, produce=run_feedback, evidence=evidence
    )
