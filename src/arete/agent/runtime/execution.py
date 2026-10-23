"""Shared execution bounds for chat and unattended coaching.

Use the async graph even from synchronous workers so the total deadline can
cancel provider waits, including SDK retries. Cancellation cannot roll back
an already committed write or kill a synchronous tool running in a thread;
never replay a failed run automatically.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from functools import partial
from time import monotonic
from typing import Any, cast

from anyio import from_thread
from langchain.agents.middleware.model_call_limit import ModelCallLimitExceededError
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError

from arete.agent.models.routing import configured_model_name
from arete.agent.runtime.budget import (
    MAX_GRAPH_STEPS,
    MAX_RUN_SECONDS,
    MAX_TOOL_CONCURRENCY,
)
from arete.agent.runtime.context import AgentContext
from arete.config import config
from arete.observability.agent import record_run
from arete.observability.tracing import agent_tracing
from arete.services.athlete_scope import database_athlete_id

RUN_LIMIT_ERRORS = (ModelCallLimitExceededError, ToolCallLimitExceededError)
LIMIT_MESSAGE = (
    "Le coach a atteint sa limite d'appels. Le travail est incomplet ; "
    "les modifications déjà effectuées sont conservées. Consulte les résultats "
    "avant de poursuivre avec une demande plus ciblée."
)
TIMEOUT_MESSAGE = (
    "Le coach a dépassé le délai de 5 minutes. Le travail est incomplet ; "
    "vérifie les modifications déjà effectuées avant de réessayer."
)


def run_config(
    recursion_limit: int = MAX_GRAPH_STEPS,
    *,
    context: AgentContext | None = None,
    graph: Any = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "recursion_limit": recursion_limit,
        "max_concurrency": MAX_TOOL_CONCURRENCY,
        "run_name": "arete_coach",
        "metadata": {
            "task": "session_feedback"
            if context and context.profile == "feedback"
            else context.profile
            if context
            else "chat",
            "provider": config.llm_provider,
            "model": configured_model_name(),
        },
    }
    # Composition snapshots the route on the graph. Reading the flag again
    # here could mislabel a run if an administrator toggles it concurrently.
    graph_config = getattr(graph, "config", None)
    if isinstance(graph_config, dict):
        metadata = graph_config.get("metadata", {})
        for key in ("model", "model_policy"):
            if key in metadata:
                result["metadata"][key] = metadata[key]
    # Model requests are spent per athlete: name whose run this is.
    athlete_id = database_athlete_id()
    if athlete_id is not None:
        result["metadata"]["athlete_id"] = athlete_id
    if context is not None:
        result["run_id"] = context.run_id
    if context and context.thread_id is not None:
        result["metadata"]["thread_id"] = context.thread_id
        result["configurable"] = {
            "thread_id": context.execution_id or context.thread_id
        }
    return result


def _elapsed_ms(started: float) -> int:
    return round((monotonic() - started) * 1000)


def _personal(context: AgentContext) -> bool:
    from arete.agent.runtime.policy import slack_policy

    return context.profile == "chat" or (
        context.profile == "slack" and slack_policy(context).personal_context
    )


async def refresh_personal_data(context: AgentContext) -> None:
    """Refresh once before context reads, never for product/admin/background runs."""
    from anyio import to_thread

    from arete.services.garmin_sync import ensure_fresh

    if not _personal(context) or context.garmin_freshness is not None:
        return
    assert context.deadline is not None
    try:
        context.garmin_freshness = await to_thread.run_sync(
            partial(ensure_fresh, deadline=context.deadline - 120)
        )
    except Exception as exc:
        context.garmin_freshness = {
            "state": "failed",
            "complete": False,
            "error": type(exc).__name__,
        }
    context.page_section = None


async def invoke_agent(graph: Any, state: Any, *, context: AgentContext) -> dict:
    started = context.started_at or monotonic()
    context.started_at = started
    context.deadline = context.deadline or started + MAX_RUN_SECONDS
    error = None
    try:
        with agent_tracing():
            async with asyncio.timeout(max(0, context.deadline - monotonic())):
                await refresh_personal_data(context)
                result = cast(
                    dict,
                    await graph.ainvoke(
                        state,
                        context=context,
                        config=run_config(context=context, graph=graph),
                    ),
                )
                # A tool-free answer is useful only once it has completed.
                if context.stats.first_result_ms is None:
                    context.stats.first_result_ms = _elapsed_ms(started)
                return result
    except BaseException as exc:
        error = type(exc).__name__
        raise
    finally:
        from arete.agent.runtime.conversation_title import close_title

        await close_title(context)
        context.run_logged = True
        record_run(
            profile=context.profile,
            stats=context.stats,
            total_ms=_elapsed_ms(started),
            error=error,
        )


def invoke_agent_sync(graph: Any, state: dict, *, context: AgentContext) -> dict:
    """Bridge AnyIO workers back to the server loop that owns the HTTP pool.

    A fresh asyncio.run() per job would reuse cached async HTTP clients across
    closed loops. Both FastAPI sync routes and the scheduler use AnyIO workers.
    Call invoke_agent directly from async callers.
    """
    return from_thread.run(partial(invoke_agent, graph, state, context=context))


async def stream_agent(
    graph: Any, state: dict, *, context: AgentContext
) -> AsyncGenerator[dict, None]:
    started = context.started_at or monotonic()
    context.started_at = started
    context.deadline = context.deadline or started + MAX_RUN_SECONDS
    error = None
    try:
        with agent_tracing():
            async with asyncio.timeout(max(0, context.deadline - monotonic())):
                if _personal(context):
                    yield {
                        "type": "custom",
                        "data": {"type": "sync_status", "state": "running"},
                    }
                await refresh_personal_data(context)
                if context.garmin_freshness is not None:
                    yield {
                        "type": "custom",
                        "data": {
                            "type": "sync_status",
                            "state": context.garmin_freshness.get("state", "failed"),
                        },
                    }
                from langgraph.stream.transformers import (
                    CustomTransformer,
                    UpdatesTransformer,
                )

                stream = await graph.astream_events(
                    state,
                    context=context,
                    config=run_config(context=context, graph=graph),
                    transformers=[
                        CustomTransformer,
                        UpdatesTransformer,
                    ],
                    version="v3",
                )
                async with stream:
                    async for part in stream:
                        if context.stats.first_token_ms is None and _is_answer_text(
                            part
                        ):
                            context.stats.first_token_ms = _elapsed_ms(started)
                        yield part
                    context.interruptions = [
                        {
                            "id": item.id,
                            "value": item.value,
                            "schema": item.response_schema,
                        }
                        for item in await stream.interrupts()
                    ]
                if context.stats.first_result_ms is None:
                    context.stats.first_result_ms = _elapsed_ms(started)
    except BaseException as exc:
        error = type(exc).__name__
        raise
    finally:
        from arete.agent.runtime.conversation_title import close_title

        await close_title(context)
        context.run_logged = True
        record_run(
            profile=context.profile,
            stats=context.stats,
            total_ms=_elapsed_ms(started),
            error=error,
        )


def _is_answer_text(part: dict) -> bool:
    """A streamed text chunk from the coach's own model node."""
    if "method" in part:
        params = part["params"]
        if part["method"] != "messages" or params["namespace"]:
            return False
        chunk, meta = params["data"]
        return (
            meta.get("langgraph_node") == "model"
            and meta.get("lc_source") not in {"summarization", "conversation_title"}
            and "conversation_title" not in meta.get("tags", [])
            and isinstance(chunk, dict)
            and chunk.get("delta", {}).get("type") == "text-delta"
            and bool(chunk["delta"].get("text"))
        )
    if part.get("type") != "messages" or part.get("ns"):
        return False
    chunk, meta = part["data"]
    return (
        meta.get("langgraph_node") == "model"
        and meta.get("lc_source") != "summarization"
        and bool(chunk.text)
    )
