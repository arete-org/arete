"""Framework hooks for capability execution; declarations live in the catalog."""

import asyncio
import logging
from dataclasses import replace
from time import monotonic, time_ns

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError
from langchain_core.messages import ToolMessage
from langchain_core.messages.utils import count_tokens_approximately
from langgraph.config import get_stream_writer

from arete.agent.capabilities.discovery import _profile, tool_available
from arete.agent.capabilities.registry import (
    CAPABILITIES,
    READ_TOOL_NAMES,
    validate_registry,
)
from arete.agent.middlewares.observability import run_stats
from arete.agent.runtime.budget import MAX_TOOL_CALLS
from arete.agent.runtime.events import enforce_tool_status, workout_updates

logger = logging.getLogger(__name__)


class ToolkitMiddleware(AgentMiddleware):
    """Authorize and observe native ToolNode execution without invoking tools ourselves."""

    def __init__(self) -> None:
        super().__init__()
        validate_registry()

    @staticmethod
    def _count(request) -> None:
        stats = run_stats(request)
        if stats is not None:
            # Framework limits count model-issued calls, not middleware retries.
            if stats.tool_calls >= MAX_TOOL_CALLS:
                raise ToolCallLimitExceededError(
                    thread_count=stats.tool_calls,
                    run_count=stats.tool_calls + 1,
                    thread_limit=None,
                    run_limit=MAX_TOOL_CALLS,
                )
            stats.tool_calls += 1

    @staticmethod
    def _config(request, *, loop=None):
        config = dict(getattr(request.runtime, "config", None) or {})
        context = getattr(request.runtime, "context", None)
        name = request.tool_call["name"]
        emits_workouts = any(name in tk.workout_actions for tk in CAPABILITIES.values())
        # Capture the writer on the graph loop. Synchronous services execute in workers.
        try:
            writer = get_stream_writer()
        except RuntimeError:
            writer = None  # Unit calls outside a graph have no stream consumer.

        def progress(value):
            if not emits_workouts or writer is None:
                return
            session = {k: v for k, v in value["session"].items() if k != "prescription"}
            event = {
                "type": "workout_update",
                "id": request.tool_call["id"],
                "thread_id": getattr(context, "thread_id", None),
                "sequence": time_ns() // 1_000,
                "session": session,
                "export": value.get("export"),
            }
            if loop:
                if loop.is_closed():
                    logger.info(
                        "Workout progress retained in database after stream closure"
                    )
                    return
                try:
                    loop.call_soon_threadsafe(writer, event)
                except RuntimeError:
                    if not loop.is_closed():
                        raise
                    logger.info("Workout progress retained after event loop closure")
            else:
                writer(event)

        config["configurable"] = {
            **config.get("configurable", {}),
            "workout_progress": progress,
        }
        return config, progress

    @staticmethod
    def _invalidate(request, name):
        # A write may partially commit even when it raises. Re-read next model
        # boundary; never let a cached read contradict the action's result.
        context = getattr(request.runtime, "context", None)
        if context is None:
            return
        if name not in READ_TOOL_NAMES:
            context.ledger_sections = {}
            context.memory_results = {}
        if any(
            name in {t.name for t in tk.tools} and name not in tk.read_tools
            for tk in CAPABILITIES.values()
        ):
            context.page_section = None

    @staticmethod
    def _denied(request):
        name = request.tool_call["name"]
        if not tool_available(_profile(request.runtime), name):
            return ToolMessage(
                content="Tool unavailable for this mission.",
                name=name,
                tool_call_id=request.tool_call["id"],
                status="error",
            )
        return None

    @staticmethod
    def _finish(request, result, progress, started):
        result = enforce_tool_status(result)
        if isinstance(result, ToolMessage):
            for update in workout_updates(result.content):
                progress(update)
        context = getattr(request.runtime, "context", None)
        if (
            context is not None
            and context.started_at is not None
            and context.stats.first_result_ms is None
            and isinstance(result, ToolMessage)
            and result.status == "success"
            and any(
                request.tool_call["name"] in {t.name for t in tk.tools}
                for tk in CAPABILITIES.values()
            )
        ):
            # Distinguish domain evidence from narration and preparatory file I/O.
            context.stats.first_result_ms = round(
                (monotonic() - context.started_at) * 1000
            )
        if (
            context is not None
            and request.tool_call["name"] == "read_file"
            and str(request.tool_call.get("args", {}).get("file_path", "")).startswith(
                "/skills/system/"
            )
        ):
            context.stats.skill_reads += 1
            context.stats.skill_read_ms += round((monotonic() - started) * 1000)
            if isinstance(result, ToolMessage) and result.status == "success":
                context.stats.skill_read_tokens_approx += int(
                    count_tokens_approximately([result])
                )
        return result

    def wrap_tool_call(self, request, handler):
        self._count(request)
        if denied := self._denied(request):
            return denied
        config, progress = self._config(request)
        request = replace(request, runtime=replace(request.runtime, config=config))
        started = monotonic()
        try:
            return self._finish(request, handler(request), progress, started)
        finally:
            self._invalidate(request, request.tool_call["name"])

    async def awrap_tool_call(self, request, handler):
        self._count(request)
        if denied := self._denied(request):
            return denied
        config, progress = self._config(request, loop=asyncio.get_running_loop())
        request = replace(request, runtime=replace(request.runtime, config=config))
        started = monotonic()
        try:
            return self._finish(request, await handler(request), progress, started)
        finally:
            self._invalidate(request, request.tool_call["name"])
