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

from langsmith import traceable
from pydantic import SecretStr

from arete.agent.backends.skills import SystemSkillsBackend
from arete.agent.factory import build_agent
from arete.agent.middlewares.journal import JournalMiddleware
from arete.agent.middlewares.skills import SystemSkillsMiddleware
from arete.agent.models.jev import (
    JEV_MAX_RETRIES,
    JEV_MODEL,
    JEV_TIMEOUT_SECONDS,
    JevClient,
)
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


def _assemble(
    profile_id: str, *, glm_flash: bool = False, calendar_enabled: bool = True
):
    profile = get_profile(profile_id)
    calendar = None
    if profile_id == "chat" and calendar_enabled and config.google_calendar_configured:
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
    journal = JournalMiddleware(system_skills=skills_backend)
    skills = (
        SystemSkillsMiddleware(
            backend=journal.backend,
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
        journal=journal,
        calendar=calendar,
        memory_model=JevClient(
            api_key=SecretStr(config.openrouter_api_key),
            model=JEV_MODEL,
            timeout=JEV_TIMEOUT_SECONDS,
            max_retries=JEV_MAX_RETRIES,
        )
        if profile.fact_memory_tools and config.memory_jev_enabled
        else None,
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
    *,
    graph=None,
    context: AgentContext | None = None,
) -> str:
    """Slack supplies its own history; reuse the chat graph and runtime limits."""
    from langchain_core.messages import AIMessage

    from arete.agent.runtime.execution import stream_agent
    from arete.agent.runtime.streaming import MAX_STREAM_EVENTS, StreamProjection

    context = context or AgentContext(thread_id=thread_id, slack_visibility=visibility)
    context.slack_visibility = visibility
    projection = StreamProjection()
    answer = ""
    count = 0
    async with aclosing(
        stream_agent(
            graph if graph is not None else get_agent(),
            {"messages": messages},
            context=context,
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


@lru_cache(maxsize=MAX_CACHED_ATHLETES)
def _slack_graph(athlete_id: int, glm_flash: bool):
    assert athlete_id == current_athlete_id()
    return _assemble("slack", glm_flash=glm_flash, calendar_enabled=False)


async def dispatch_slack_message(message, *, client):
    """Keep classification, delivery selection and streamed execution in one trace."""
    from arete.observability.tracing import agent_tracing

    with agent_tracing():
        return await _dispatch_slack_message(
            message,
            client=client,
            langsmith_extra={
                "metadata": {
                    "thread_id": message.thread_id,
                    "athlete_id": current_athlete_id(),
                    "task": "slack",
                }
            },
        )


@traceable(
    name="arete_coach",
    process_inputs=lambda inputs: {
        "messages": [{"role": "user", "content": inputs["message"].text}]
    },
)
async def _dispatch_slack_message(message, *, client):
    from arete.services.slack import dispatch

    # The outer trace must survive prepare() returning: transport picks the
    # private destination before it invokes the prepared streaming producer.
    return await dispatch(
        message, client=client, produce=run_slack_coach, prepare=prepare_slack_agent
    )


async def prepare_slack_agent(messages, message, client):
    """Compose before delivery starts, so private reads never stream to a channel."""
    from time import monotonic

    from anyio import to_thread

    from arete.agent.middlewares.surface import SurfaceDetectionMiddleware
    from arete.agent.runtime.surface import CLASSIFIER_MAX_TOKENS, CLASSIFIER_TIMEOUT
    from arete.observability.agent import record_run
    from arete.observability.tracing import agent_tracing
    from arete.services import slack_identity
    from arete.services.slack import MAX_JOB_SECONDS, HistoryError, SlackPreparation
    from arete.services.slack_product import SlackProduct, valid_timezone

    identity = await to_thread.run_sync(
        slack_identity.identity, message.team, message.user
    )
    private_owner = await to_thread.run_sync(
        slack_identity.private_owner, message.thread_id
    )
    actor = identity[0] if identity else None
    if private_owner and (
        not actor
        or not actor.is_admin
        or actor.clerk_user_id != private_owner
        or message.in_channel
    ):
        raise HistoryError("Ce fil privé exige son administrateur Arete actif.")
    if actor is None or not actor.is_admin:
        return SlackPreparation(run_slack_coach)
    context = AgentContext(
        profile="slack", thread_id=message.thread_id, account_id=actor.clerk_user_id
    )
    context.started_at = monotonic()
    context.deadline = context.started_at + MAX_JOB_SECONDS

    def finalize():
        if not context.run_logged:
            context.run_logged = True
            record_run(
                profile=context.profile,
                stats=context.stats,
                total_ms=round((monotonic() - context.started_at) * 1000),
                error="NoGraphCompletion",
            )

    try:
        glm_flash = await to_thread.run_sync(
            lambda: get_feature_flags().glm_flash and glm_flash_available()
        )
        route = resolve_route(glm_flash=glm_flash)
        if route.base_url != "https://openrouter.ai/api/v1":
            raise ValueError("Le classement Slack administrateur exige OpenRouter.")
        classifier = build_chat_model(
            route=replace(route, fallbacks=()),
            max_tokens=CLASSIFIER_MAX_TOKENS,
            temperature=0,
            timeout=CLASSIFIER_TIMEOUT,
            max_retries=0,
            openrouter_reasoning=False,
        )
        with agent_tracing():
            decision = await SurfaceDetectionMiddleware(
                classifier, context_tokens=route.context_tokens
            ).prepare(messages, context)
        context.classifier_calls = 1
        private = decision.private_data or bool(private_owner)
        context.slack_decision = decision
        assert identity is not None
        context.slack_product = SlackProduct(
            client,
            message,
            actor.clerk_user_id,
            valid_timezone(identity[1]),
            private=private,
        )
        # All intents share one graph. Its policy is resolved per invocation;
        # neither classification nor the Slack client enters the graph cache.
        with _graph_lock:
            graph = _slack_graph(current_athlete_id(), glm_flash)

        async def produce(history, thread_id, visibility, emit):
            await to_thread.run_sync(
                slack_identity.require_admin,
                message.team,
                message.user,
                actor.clerk_user_id,
            )
            return await run_slack_coach(
                history, thread_id, visibility, emit, graph=graph, context=context
            )

        return SlackPreparation(
            produce,
            product=private or decision.surface != "coach",
            private=private,
            account_id=actor.clerk_user_id,
            finalize=finalize,
        )
    except BaseException as exc:
        finalize()
        if isinstance(exc, Exception):
            raise HistoryError(
                "Classement Slack indisponible ; aucune action exécutée. " + str(exc)
            ) from exc
        raise
