"""Project native LangGraph events into independent message and tool surfaces.

Message IDs prevent model turns from being concatenated into one paragraph.
Completed updates reconcile streamed deltas, including providers that only
return a final message. Nested graphs must not overwrite the coach's answer.
"""

from __future__ import annotations

import logging
from time import monotonic

from langchain_core.messages import AIMessage

from arete.agent.runtime.events import preview, tool_result_event
from arete.agent.runtime.execution import MAX_RUN_SECONDS

MAX_STREAM_EVENTS = 12_000
MAX_STREAM_TEXT_CHARS = 64_000
MAX_STREAM_SECONDS = MAX_RUN_SECONDS
logger = logging.getLogger(__name__)


class StreamProjection:
    def __init__(self, *, supports_chart_cards: bool = False) -> None:
        self.supports_chart_cards = supports_chart_cards
        self.texts: dict[str, str] = {}
        self.last_id = ""
        self.chars = 0
        self.context_usage: dict | None = None
        self.model_ids: dict[str, str] = {}
        self.tools: dict[str, tuple[str, float]] = {}
        self.internal_reads: set[str] = set()
        self.turn_messages: dict[int, str] = {}
        self.turn_runs: dict[int, str] = {}
        self.preparing: dict[tuple[str, int], str] = {}
        self.blocks: dict[tuple[str, int], str] = {}

    def _record(self, message_id: str, text: str) -> None:
        self.chars += len(text) - len(self.texts.get(message_id, ""))
        if self.chars > MAX_STREAM_TEXT_CHARS:
            raise ValueError("La réponse dépasse la limite de taille du stream.")
        self.texts[message_id] = text
        self.last_id = message_id

    def events(self, part: dict) -> list[dict]:
        if "method" in part:
            return self._native(part)
        if part.get("ns"):
            return []
        kind, data = part["type"], part["data"]
        if kind == "custom":
            # Cached clients reject unknown events. Their standalone answer and
            # existing tool activity remain usable during a rolling release.
            if isinstance(data, dict) and data.get("type") == "chart_card":
                return [data] if self.supports_chart_cards else []
            return (
                [data]
                if isinstance(data, dict)
                and data.get("type")
                in (
                    "activity",
                    "memory_receipt",
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
                if self.texts.get(message_id) == message.text:
                    continue
                self._record(message_id, message.text)
                events.append(
                    {"type": "message", "id": message_id, "text": message.text}
                )
            return events
        return []

    def _native(self, part: dict) -> list[dict]:
        params = part["params"]
        if params["namespace"]:
            return []
        kind, data = part["method"], params["data"]
        if kind in {"custom", "updates", "values"}:
            return self.events({"type": kind, "data": data})
        if kind == "lifecycle":
            if data.get("namespace") or data.get("event") == "drained":
                return []
            phase = data.get("event")
            return [
                {
                    "type": "activity",
                    "id": "graph",
                    "state": "running"
                    if phase == "started"
                    else "error"
                    if phase == "failed"
                    else "done",
                    "label": {
                        "started": "Exécution du coach",
                        "completed": "Exécution terminée",
                        "interrupted": "Intervention humaine attendue",
                        "failed": "Exécution interrompue",
                    }.get(phase, "Exécution terminée"),
                }
            ]
        if kind == "tools":
            call_id = data["tool_call_id"]
            if data["event"] == "tool-started":
                name = data["tool_name"]
                self.tools[call_id] = (name, monotonic())
                arguments = data.get("input")
                if (
                    name == "read_file"
                    and isinstance(arguments, dict)
                    and str(arguments.get("file_path", "")).startswith(
                        ("/skills/", "/conversation_history/")
                    )
                ):
                    self.internal_reads.add(call_id)
                return [
                    {
                        "type": "activity",
                        "id": "arguments:" + call_id,
                        "state": "done",
                        "label": "Arguments préparés",
                    },
                    {
                        "type": "tool_start",
                        "id": call_id,
                        "name": name,
                        "args": preview(data.get("input", {})),
                    },
                ]
            if data["event"] not in {"tool-finished", "tool-error"}:
                return []
            name, started = self.tools.pop(call_id, ("", monotonic()))
            elapsed = round((monotonic() - started) * 1000)
            if data["event"] == "tool-error":
                return [
                    {
                        "type": "tool_end",
                        "id": call_id,
                        "name": name,
                        "status": "error",
                        "output": preview("Action interrompue ou échouée."),
                        "elapsed_ms": elapsed,
                    }
                ]
            tool_event = dict(
                tool_result_event(
                    data.get("output"),
                    call_id=call_id,
                    name=name,
                    elapsed_ms=elapsed,
                )
            )
            if call_id in self.internal_reads:
                # Skills and compacted histories can contain prompt material.
                # Their successful consultation has its own application receipt.
                tool_event["output"] = preview(
                    "Lecture terminée"
                    if tool_event["status"] == "done"
                    else "Lecture échouée"
                )
                self.internal_reads.remove(call_id)
            return [tool_event]
        if kind != "messages":
            return []
        chunk, meta = data
        if (
            meta.get("langgraph_node") != "model"
            or meta.get("lc_source") in {"summarization", "conversation_title"}
            or "conversation_title" in meta.get("tags", [])
        ):
            return []
        if isinstance(chunk, AIMessage):
            if not chunk.text:
                return []
            message_id = chunk.id or str(meta.get("run_id", "model"))
            step = int(meta.get("langgraph_step", 0))
            previous = self.turn_messages.get(step)
            completed = []
            if previous and previous != message_id and self.texts.get(previous):
                self._record(previous, "")
                completed.append({"type": "message", "id": previous, "text": ""})
            self.turn_messages[step] = message_id
            self._record(message_id, chunk.text)
            return [
                *completed,
                {"type": "message", "id": message_id, "text": chunk.text},
            ]
        run = str(meta.get("run_id", meta.get("langgraph_step", 0)))
        event = chunk["event"]
        if event == "message-start":
            message_id = chunk["id"]
            step = int(meta.get("langgraph_step", 0))
            previous = self.turn_messages.get(step)
            previous_run = self.turn_runs.get(step)
            self.turn_runs[step] = run
            self.turn_messages[step] = message_id
            self.model_ids[run] = message_id
            result = [
                {
                    "type": "activity",
                    "id": "model:" + run,
                    "state": "running",
                    "label": "Préparation de la réponse",
                }
            ]
            if previous and previous != message_id:
                result.insert(
                    0,
                    {
                        "type": "activity",
                        "id": "model:" + str(previous_run),
                        "state": "error",
                        "label": "Tentative remplacée par une nouvelle réponse",
                    },
                )
                for (prepared_message, _), call_id in self.preparing.items():
                    if prepared_message == previous:
                        result.insert(
                            0,
                            {
                                "type": "activity",
                                "id": "arguments:" + call_id,
                                "state": "error",
                                "label": "Préparation abandonnée",
                            },
                        )
            if previous and previous != message_id and self.texts.get(previous):
                self._record(previous, "")
                result.insert(0, {"type": "message", "id": previous, "text": ""})
            return result
        message_id = self.model_ids.get(run, run)
        index = chunk.get("index", 0)
        key = (message_id, index)
        if (
            event == "content-block-start"
            and chunk.get("content", {}).get("type") == "tool-call"
        ):
            content = chunk["content"]
            self.preparing[key] = content.get("id") or f"{message_id}:{index}"
            return [
                {
                    "type": "activity",
                    "id": "arguments:" + self.preparing[key],
                    "state": "running",
                    "label": "Préparation d’une action",
                }
            ]
        if event == "message-finish":
            return [
                {
                    "type": "activity",
                    "id": "model:" + run,
                    "state": "done",
                    "label": "Réponse du modèle reçue",
                }
            ]
        if (
            event == "content-block-delta"
            and chunk.get("delta", {}).get("type") == "text-delta"
        ):
            text = chunk["delta"]["text"]
            self.blocks[key] = self.blocks.get(key, "") + text
            self._record(message_id, self.texts.get(message_id, "") + text)
            return [{"type": "token", "id": message_id, "text": text}]
        if (
            event == "content-block-finish"
            and chunk.get("content", {}).get("type") == "text"
        ):
            self.blocks[key] = chunk["content"]["text"]
            text = "".join(
                value
                for (mid, _), value in sorted(self.blocks.items())
                if mid == message_id
            )
            self._record(message_id, text)
            return [{"type": "message", "id": message_id, "text": text}]
        return []

    def done(self) -> dict:
        text = self.texts.get(self.last_id, "")
        if not text:
            raise ValueError("Le coach n'a retourné aucune réponse.")
        return {"type": "done", "message": {"role": "assistant", "content": text}}
