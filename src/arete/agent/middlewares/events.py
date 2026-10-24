"""Project confirmed domain receipts before filesystem result offloading.

Native v3 callbacks own tool execution lifecycle. This adapter only exposes
application artifacts that cannot be inferred from truncated UI previews.
"""

from langchain.agents.middleware import AgentMiddleware
from langgraph.config import get_stream_writer

from arete.agent.runtime.events import chart_card, coach_card, enforce_tool_status


class ToolEventMiddleware(AgentMiddleware):
    @staticmethod
    def _publish(request, result):
        result = enforce_tool_status(result)
        writer = get_stream_writer()
        if card := coach_card(result):
            writer(card)
        if chart := chart_card(result):
            writer(chart)
        import json

        from langchain_core.messages import ToolMessage

        if isinstance(result, ToolMessage) and result.status == "success":
            call = request.tool_call
            if call["name"] == "read_file":
                path = call["args"].get("file_path")
                skill = next(
                    (
                        s
                        for s in request.state.get("skills_metadata", [])
                        if s["path"] == path
                    ),
                    None,
                )
                if skill:
                    name = skill.get("metadata", {}).get("display_name", skill["name"])
                    writer(
                        {
                            "type": "activity",
                            "id": "skill:" + call["id"],
                            "label": "Méthode consultée : " + name,
                            "state": "done",
                        }
                    )
            if call["name"] in {
                "remember_fact",
                "forget_fact",
                "append_journal",
                "edit_file",
                "delete",
            }:
                try:
                    payload = (
                        json.loads(result.content)
                        if isinstance(result.content, str)
                        else {}
                    )
                except ValueError:
                    payload = {}
                action = payload.get("action") if isinstance(payload, dict) else None
                if call["name"] == "append_journal":
                    action = "created" if payload.get("written") else "already_present"
                if call["name"] == "forget_fact":
                    action = (
                        "updated" if payload.get("forgotten") else "already_present"
                    )
                if call["name"] in {"edit_file", "delete"}:
                    if call["args"].get("file_path") not in {
                        "/memories/notes.md",
                        "/memories/sessions.md",
                    }:
                        return result
                    action = "updated"
                if action in {
                    "created",
                    "already_present",
                    "needs_clarification",
                    "updated",
                }:
                    writer(
                        {"type": "memory_receipt", "id": call["id"], "action": action}
                    )
        return result

    def wrap_tool_call(self, request, handler):
        return self._publish(request, handler(request))

    async def awrap_tool_call(self, request, handler):
        return self._publish(request, await handler(request))
