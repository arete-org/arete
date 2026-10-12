"""Tool-event middleware.

``ToolEventMiddleware`` emits ``tool_start`` / ``tool_end`` custom stream
events (``langgraph.config.get_stream_writer``) so the UI can show live tool
progress; consumed with ``stream_mode="custom"``. The open page is context,
contributed by ``agent/context/sections.py``.
"""

from __future__ import annotations

import logging
from time import monotonic

from langchain.agents.middleware import AgentMiddleware

from arete.agent.runtime.events import coach_card, preview, tool_result_event

logger = logging.getLogger(__name__)


class ToolEventMiddleware(AgentMiddleware):
    """Track calls by ID, including parallel calls to the same tool.

    A failed or cancelled tool must never leave a green success tick behind.
    The UI receives bounded previews, not the entire analytics payload.
    """

    @staticmethod
    def _start(request, writer):
        call = request.tool_call
        call_id, name = call["id"], call["name"]
        writer(
            {
                "type": "tool_start",
                "id": call_id,
                "name": name,
                "args": preview(call.get("args", {})),
            }
        )
        return call_id, name, monotonic()

    @staticmethod
    def _failure(writer, call_id, name, started, exc):
        writer(
            {
                "type": "tool_end",
                "id": call_id,
                "name": name,
                "status": "error",
                "output": preview(str(exc)),
                "elapsed_ms": round((monotonic() - started) * 1000),
            }
        )

    def wrap_tool_call(self, request, handler):
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        call_id, name, started = self._start(request, writer)
        try:
            result = handler(request)
        except Exception as exc:
            self._failure(writer, call_id, name, started, exc)
            raise
        writer(
            tool_result_event(
                result,
                call_id=call_id,
                name=name,
                elapsed_ms=round((monotonic() - started) * 1000),
            )
        )
        if card := coach_card(result):
            writer(card)
        return result

    async def awrap_tool_call(self, request, handler):
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        call_id, name, started = self._start(request, writer)
        try:
            result = await handler(request)
        except Exception as exc:
            self._failure(writer, call_id, name, started, exc)
            raise
        writer(
            tool_result_event(
                result,
                call_id=call_id,
                name=name,
                elapsed_ms=round((monotonic() - started) * 1000),
            )
        )
        if card := coach_card(result):
            writer(card)
        return result
