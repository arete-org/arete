"""Project LangGraph v2 chunks into independent message and tool surfaces.

Message IDs prevent model turns from being concatenated into one paragraph.
Completed updates reconcile streamed deltas, including providers that only
return a final message. Nested graphs must not overwrite the coach's answer.
"""

from __future__ import annotations

import logging

from langchain_core.messages import AIMessage

from arete.agent.runtime.execution import MAX_RUN_SECONDS

MAX_STREAM_EVENTS = 12_000
MAX_STREAM_TEXT_CHARS = 64_000
MAX_STREAM_SECONDS = MAX_RUN_SECONDS
logger = logging.getLogger(__name__)


class StreamProjection:
    def __init__(self) -> None:
        self.texts: dict[str, str] = {}
        self.last_id = ""
        self.chars = 0
        self.context_usage: dict | None = None

    def _record(self, message_id: str, text: str) -> None:
        self.chars += len(text) - len(self.texts.get(message_id, ""))
        if self.chars > MAX_STREAM_TEXT_CHARS:
            raise ValueError("La réponse dépasse la limite de taille du stream.")
        self.texts[message_id] = text
        self.last_id = message_id

    def events(self, part: dict) -> list[dict]:
        if part.get("ns"):
            return []
        kind, data = part["type"], part["data"]
        if kind == "custom":
            return (
                [data]
                if isinstance(data, dict)
                and data.get("type")
                in (
                    "thread_title",
                    "sync_status",
                    "tool_start",
                    "tool_end",
                    "calendar_action",
                    "workout_update",
                    "coach_card",
                    "context_compaction",
                )
                else []
            )
        if kind == "values":
            usage = data.get("context_window_usage")
            if usage is None or usage == self.context_usage:
                return []
            if not isinstance(usage, dict) or any(
                type(usage.get(key)) is not int or usage[key] < minimum
                for key, minimum in (("used_tokens", 0), ("window_tokens", 1))
            ):
                raise ValueError("Mesure de contexte invalide.")
            # Never forward the rest of graph state (files, prompts or history).
            self.context_usage = {
                key: usage[key] for key in ("used_tokens", "window_tokens")
            }
            return [{"type": "values", "context_window_usage": self.context_usage}]
        if kind == "messages":
            chunk, meta = data
            if (
                meta.get("langgraph_node") != "model"
                or meta.get("lc_source") in {"summarization", "conversation_title"}
                or "conversation_title" in meta.get("tags", [])
            ):
                return []
            text = chunk.text
            if not text:
                return []
            message_id = chunk.id or f"model-{meta.get('langgraph_step', 0)}"
            self._record(message_id, self.texts.get(message_id, "") + text)
            return [{"type": "token", "id": message_id, "text": text}]
        if kind == "updates":
            events = []
            for message in (data.get("model") or {}).get("messages", []):
                if not isinstance(message, AIMessage) or not message.text:
                    continue
                message_id = message.id or self.last_id or "model-0"
                self._record(message_id, message.text)
                events.append(
                    {"type": "message", "id": message_id, "text": message.text}
                )
            return events
        return []

    def done(self) -> dict:
        text = self.texts.get(self.last_id, "")
        if not text:
            raise ValueError("Le coach n'a retourné aucune réponse.")
        return {"type": "done", "message": {"role": "assistant", "content": text}}
