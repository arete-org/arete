"""Application composition for chat, API cards and scheduled coaching.

Only this composition root imports the agent factory. Domain producers receive
plain callbacks, so they remain usable and testable without an agent framework.
"""

# ruff: noqa: E402
# The clock starts before the imports so the first run can report their cost.
from time import perf_counter

_IMPORT_STARTED = perf_counter()

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import aclosing
from dataclasses import replace
from datetime import date
from functools import lru_cache, partial, wraps
from pathlib import Path
from threading import Lock
from typing import Any, Literal

from deepagents.backends import CompositeBackend, StateBackend
from langsmith import traceable
from pydantic import SecretStr

from arete.agent.backends.journal import (
    JOURNAL_PERMISSIONS,
    LEDGER_TOOL_DESCRIPTIONS,
    MEMORIES_ROUTE,
    LedgerBackend,
)
from arete.agent.backends.skills import SYSTEM_SKILLS_ROUTE, SystemSkillsBackend
from arete.agent.factory import build_agent
from arete.agent.middlewares.filesystem import build_filesystem_middleware
from arete.agent.middlewares.skills import SystemSkillsMiddleware
from arete.agent.middlewares.summarization import ContextSummarizationMiddleware
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
    AGENT_TEMPERATURE,
    AGENT_TIMEOUT_SEC,
)
from arete.agent.models.routing import resolve_route
from arete.agent.profiles.catalog import get_profile
from arete.agent.runtime.budget import MAX_GRAPH_STEPS
from arete.agent.runtime.context import AgentContext, read_athlete_clock
from arete.agent.runtime.execution import invoke_agent_sync
from arete.calendar import get_calendar_service
from arete.config import config
from arete.observability.agent import record_stack_ready
from arete.services import (
    briefing,
    coaching_rules,
    evening_message,
    session_feedback,
    weekly_review,
)
from arete.services.athlete_scope import current_athlete_id, resolve_athlete_id
from arete.services.coaching_repository import Briefing
from arete.services.feature_flags import get_feature_flags, glm_flash_available
from arete.services.system_skills import publish_bundle

_IMPORT_MS = round((perf_counter() - _IMPORT_STARTED) * 1000)
# Never released: only the process's first successful assembly logs.
_stack_ready_unlogged = Lock()

AGENT_RECURSION_LIMIT = MAX_GRAPH_STEPS
SYSTEM_SKILLS_ROOT = Path(__file__).parent / "agent" / "skills" / "system"


MAX_CACHED_ATHLETES = 32
_graph_lock = Lock()


def _off_loop() -> None:
    """Composition reads the rollout flag (a database query), takes a thread
    lock and may compile a graph: run it in a worker, never on the event loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise RuntimeError(
        "Agent composition on the event loop: resolve it in an AnyIO worker"
    )


def _glm_flash() -> bool:
    return get_feature_flags().glm_flash and glm_flash_available()


def _serialized(factory):
    # lru_cache allows duplicate construction during concurrent first access.
    @wraps(factory)
    def get():
        _off_loop()
        # The flag read needs no lock: only construction is serialized.
        glm_flash = _glm_flash()
        with _graph_lock:
            return factory(current_athlete_id(), glm_flash=glm_flash)

    get.cache_clear = factory.cache_clear
    return get


def build_agent_filesystem(
    *,
    system_skills: SystemSkillsBackend | None = None,
    offload_tool_results: bool = True,
):
    """Compose the application's mounts; the filesystem middleware stays generic."""
    backend = CompositeBackend(
        default=StateBackend(),
        routes={
            MEMORIES_ROUTE: LedgerBackend(),
            **(
                {SYSTEM_SKILLS_ROUTE: system_skills}
                if system_skills is not None
                else {}
            ),
        },
    )
    return build_filesystem_middleware(
        backend,
        permissions=JOURNAL_PERMISSIONS,
        tool_descriptions=LEDGER_TOOL_DESCRIPTIONS,
        offload_tool_results=offload_tool_results,
    )


def _assemble(
    profile_id: str,
    *,
    glm_flash: bool = False,
    calendar_enabled: bool = True,
    checkpointer=None,
):
    _off_loop()
    started = perf_counter()
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
            max_tokens=AGENT_MAX_TOKENS,
            temperature=AGENT_TEMPERATURE,
            timeout=AGENT_TIMEOUT_SEC,
            max_retries=(
                0
                if profile_id == "automation"
                or len(candidates) > 1
                or route.openrouter_policy == "glm_flash"
                else AGENT_MAX_RETRIES
            ),
        )
        for name in candidates
    )
    model = models[0]
    skills_backend = None
    skill_files = {}
    if profile.filesystem_tools:
        skill_files = publish_bundle(SYSTEM_SKILLS_ROOT)
        skills_backend = SystemSkillsBackend(skill_files)
    filesystem = build_agent_filesystem(
        system_skills=skills_backend,
        # Slack's shared graph can disable filesystem access per invocation.
        # Keep its results inline rather than hand out unreadable file pointers.
        offload_tool_results=profile_id == "chat",
    )
    skills = (
        SystemSkillsMiddleware(
            backend=filesystem.backend,
            paths=set(skill_files),
        )
        if skills_backend is not None
        else None
    )
    from arete.agent.runtime.conversation_title import (
        TITLE_MAX_TOKENS,
        TITLE_TIMEOUT_SECONDS,
        generate_title,
    )

    title_generator = (
        partial(
            generate_title,
            build_chat_model(
                route=replace(route, fallbacks=()),
                max_tokens=TITLE_MAX_TOKENS,
                temperature=0,
                timeout=TITLE_TIMEOUT_SECONDS,
                max_retries=0,
                openrouter_reasoning=False,
            ),
        )
        if profile_id == "chat"
        else None
    )
    graph = build_agent(
        profile,
        checkpointer=checkpointer,
        title_generator=title_generator,
        model=model,
        context_tokens=route.context_tokens,
        output_tokens=AGENT_MAX_TOKENS,
        filesystem=filesystem,
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
        summarization=(
            # The native summarizer already retries up to three times. Avoid
            # multiplying those attempts by SDK/provider-model fallback retries.
            ContextSummarizationMiddleware(
                build_chat_model(
                    route=replace(route, fallbacks=()),
                    max_tokens=AGENT_MAX_TOKENS,
                    temperature=AGENT_TEMPERATURE,
                    timeout=AGENT_TIMEOUT_SEC,
                    max_retries=0,
                ),
                filesystem.backend,
            )
            if profile_id == "chat"
            else None
        ),
    )
    if _stack_ready_unlogged.acquire(blocking=False):
        record_stack_ready(
            import_ms=_IMPORT_MS,
            compile_ms=round((perf_counter() - started) * 1000),
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
    catalog = []
    for skill in sorted(discovered, key=lambda item: item["name"]):
        # Native discovery keeps presentation metadata beside the immutable body;
        # the UI does not maintain a second registry or infer permissions from it.
        label = skill.get("metadata", {}).get("display_name", skill["name"])
        if (
            not isinstance(label, str)
            or not 1 <= len(label.strip()) <= 80
            or not label.isprintable()
        ):
            raise ValueError(f"Invalid system skill display name: {skill['name']}")
        catalog.append(
            {
                **{key: skill[key] for key in ("name", "description", "path")},
                "display_name": label.strip(),
            }
        )
    return catalog


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
    from anyio import to_thread
    from langchain_core.messages import AIMessage

    from arete.agent.runtime.execution import stream_agent
    from arete.agent.runtime.streaming import MAX_STREAM_EVENTS, StreamProjection

    if context is None or graph is None:
        # One worker hop: the athlete clock, the rollout flag and a compile.
        context, graph = await to_thread.run_sync(
            _slack_coach_setup, context, graph, thread_id
        )
    assert context is not None
    context.slack_visibility = visibility
    projection = StreamProjection()
    answer = ""
    count = 0
    async with aclosing(
        stream_agent(
            graph,
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


def _slack_coach_setup(
    context: AgentContext | None, graph, thread_id: str
) -> tuple[AgentContext, Any]:
    return (
        context or AgentContext(thread_id=thread_id),
        graph if graph is not None else get_agent(),
    )


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


@_serialized
@lru_cache(maxsize=MAX_CACHED_ATHLETES)
def build_evening_agent(athlete_id: int, *, glm_flash: bool = False):
    assert athlete_id == current_athlete_id()
    return _assemble("evening", glm_flash=glm_flash)


def _run_mission(
    graph, profile: str, message: str, max_chars: int, deadline: float | None = None
) -> str:
    """One tool-free request. ``deadline`` (monotonic) bounds the whole run,
    fallbacks included, so a scheduled dispatch settles a failure before the
    platform stops its function; None keeps the run's own envelope."""
    context = AgentContext(profile=profile)  # type: ignore[arg-type]
    context.deadline = deadline
    result = invoke_agent_sync(
        graph, {"messages": [{"role": "user", "content": message}]}, context=context
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


def _bounded(run: Callable[..., str], deadline: float | None) -> Callable[[str], str]:
    """``run`` stopping by ``deadline``; ``run`` itself without one."""
    if deadline is None:
        return run
    return partial(run, deadline=deadline)


def run_briefing(facts: str, deadline: float | None = None) -> str:
    return _run_mission(
        build_briefing_agent(),
        "briefing",
        facts,
        briefing.MAX_BRIEFING_CHARS,
        deadline,
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


def run_review(facts: str, deadline: float | None = None) -> str:
    return _run_mission(
        build_review_agent(), "review", facts, weekly_review.MAX_REVIEW_CHARS, deadline
    )


def run_evening(facts: str, deadline: float | None = None) -> str:
    return _run_mission(
        build_evening_agent(),
        "evening",
        facts,
        evening_message.MAX_EVENING_CHARS,
        deadline,
    )


def write_evening_message(
    evening: evening_message.Survey, *, deadline: float | None = None
) -> evening_message.EveningMessage | None:
    """The scheduler's evening message: one request, None when already held."""
    return evening_message.write(_bounded(run_evening, deadline), evening)


def generate_weekly_review(
    *, refresh: bool = False, review_id: int | None = None
) -> weekly_review.Review:
    return weekly_review.generate_review(
        run_review, refresh=refresh, review_id=review_id
    )


def write_scheduled_review(
    *, deadline: float | None = None
) -> weekly_review.Review | None:
    """The scheduler's review: written once per week, None when it exists."""
    return weekly_review.write_review(_bounded(run_review, deadline), scheduled=True)


def generate_briefing(
    *, trigger: str = "api", target_date: date | None = None, user_id: int | None = None
) -> Briefing:
    user_id = resolve_athlete_id(user_id)
    return briefing.generate_briefing(
        produce=run_briefing, trigger=trigger, target_date=target_date, user_id=user_id
    )


def get_or_create_briefing(
    *,
    trigger: str = "api",
    target_date: date | None = None,
    user_id: int | None = None,
    replacing: Briefing | None = None,
    deadline: float | None = None,
) -> Briefing | None:
    user_id = resolve_athlete_id(user_id)
    return briefing.get_or_create_briefing(
        produce=_bounded(run_briefing, deadline),
        trigger=trigger,
        target_date=target_date,
        user_id=user_id,
        replacing=replacing,
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
    from arete.observability.agent import record_run
    from arete.observability.tracing import agent_tracing
    from arete.services import slack_identity
    from arete.services.jev import JEV_MODEL, JEV_TIMEOUT, JevService
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
    try:
        now = await read_athlete_clock()
    except Exception as exc:
        raise HistoryError(
            "Classement Slack indisponible ; aucune action exécutée. " + str(exc)
        ) from exc
    context = AgentContext(
        profile="slack",
        thread_id=message.thread_id,
        account_id=actor.clerk_user_id,
        current_datetime=now,
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

    def compose():
        # All intents share one graph. Its policy is resolved per invocation;
        # neither classification nor the Slack client enters the graph cache.
        _off_loop()
        glm_flash = _glm_flash()
        route = resolve_route(glm_flash=glm_flash)
        if route.base_url != "https://openrouter.ai/api/v1":
            raise ValueError("Le classement Slack administrateur exige OpenRouter.")
        with _graph_lock:
            return route, _slack_graph(current_athlete_id(), glm_flash)

    try:
        route, graph = await to_thread.run_sync(compose)
        classifier = JevService(
            api_key=route.api_key, model=JEV_MODEL, timeout=JEV_TIMEOUT
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


def run_automation(run: dict) -> None:
    """Bridge dispatcher workers to the event loop; only missions use checkpoints."""
    from anyio import from_thread

    from_thread.run(_run_automation, run)


def _automation_setup(run: dict) -> tuple[AgentContext, Any]:
    """One segment's synchronous composition, run in a worker: the athlete
    clock and rollout flag are reads, the route record a write, and the graph
    compile blocks. The server loop keeps serving browser streams meanwhile."""
    import json

    from arete.agent.runtime.checkpoints import AutomationSaver
    from arete.dataio.db import db_connection
    from arete.services.automations import OWNER

    context = AgentContext(profile="automation", thread_id=run["id"])
    # Persist only the non-secret route identity; credentials and clients
    # are resolved at composition and never serialized in graph state.
    glm = _glm_flash()
    route = resolve_route(glm_flash=glm)
    policy = json.dumps(
        {"model": route.model, "policy": route.openrouter_policy}, sort_keys=True
    )
    if run["model_policy"] and run["model_policy"] != policy:
        raise RuntimeError("La configuration du modèle a changé ; reprise annulée.")
    with db_connection() as con:
        con.execute(
            f"UPDATE app.automation_runs SET model_policy=? WHERE {OWNER} AND id=? RETURNING id",
            [policy, run["id"]],
        )
    graph = _assemble("automation", glm_flash=glm, checkpointer=AutomationSaver())
    return context, graph


async def _run_automation(run: dict) -> None:
    import json
    from time import monotonic

    from anyio import to_thread
    from langgraph.types import Command

    from arete.agent.runtime.execution import invoke_agent, run_config
    from arete.services import automation_execution as execution
    from arete.services.automation_schedule import MAX_ACTIVE_SECONDS, SEGMENT_SECONDS

    started = monotonic()
    identifier = run["id"]
    result, interrupts, error = None, [], None
    notify = True
    try:
        # Inside the try: a failed settings read still finishes the run.
        context, graph = await to_thread.run_sync(_automation_setup, run)
        context.tool_slots = asyncio.Semaphore(1)
        context.deadline = started + min(
            SEGMENT_SECONDS, MAX_ACTIVE_SECONDS - run["active_seconds"]
        )
        cfg = run_config(context=context, graph=graph)
        snapshot = await graph.aget_state(cfg)
        state: Any
        if snapshot.values:
            decisions = await to_thread.run_sync(execution.decisions, identifier)
            pending_ids = {
                item.id for task in snapshot.tasks for item in task.interrupts
            }
            answers = {
                key: value for key, value in decisions.items() if key in pending_ids
            }
            if not answers:
                raise RuntimeError("Aucune décision nouvelle pour cette reprise")
            state = Command(resume=answers)
        else:
            definition = json.loads(run["definition_json"])
            source = definition.get("source")
            if source and source.get("kind") == "evening":
                from arete.agent.runtime.evening import (
                    DECISION_TIMEOUT_SECONDS,
                    decide_reply,
                )
                from arete.services.jev import JEV_MODEL, JevService

                await to_thread.run_sync(execution.validate_evening_source, identifier)
                decision = await decide_reply(
                    JevService(
                        api_key=SecretStr(config.openrouter_api_key),
                        model=JEV_MODEL,
                        timeout=DECISION_TIMEOUT_SECONDS,
                    ),
                    source,
                    context,
                    config.llm_context_tokens,
                )
                definition = await to_thread.run_sync(
                    execution.record_evening_decision, identifier, decision.model_dump()
                )
                if decision.action == "record_only":
                    result = "Ta réponse est enregistrée. Aucun ajustement demandé."
                    notify = False
                    return
            state = {
                "messages": [
                    {
                        "role": "user",
                        "content": "Mission planifiée à exécuter maintenant :\n"
                        + json.dumps(definition, ensure_ascii=False)
                        + "\nSéance concernée : "
                        + str(run["session_key"] or "aucune"),
                    }
                ]
            }
        output = await invoke_agent(graph, state, context=context)
        snapshot = await graph.aget_state(cfg)
        interrupts = [
            {"id": item.id, "value": item.value, "schema": item.response_schema}
            for task in snapshot.tasks
            for item in task.interrupts
        ]
        if not interrupts:
            messages = output.get("messages", [])
            result = messages[-1].text if messages else None
            if not result:
                raise RuntimeError("La mission n’a produit aucun résultat")
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        from functools import partial

        await to_thread.run_sync(
            partial(
                execution.finish,
                identifier,
                seconds=monotonic() - started,
                result=result,
                interrupts=interrupts,
                error=error,
                notify=notify,
            )
        )
