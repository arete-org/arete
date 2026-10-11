"""Small, correlated UI events; full tool results stay in the agent state."""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any, Literal, TypedDict

from langchain_core.messages import ToolMessage
from langgraph.types import Command

MAX_TOOL_PREVIEW_CHARS = 2_000


def enforce_tool_status(result: Any) -> Any:
    """Keep model-visible status aligned with declared tool failures, without replay.

    Preserve complete payloads and Command updates: an error can follow a
    partially committed batch or include a workout card that still needs updating.
    """
    if (
        isinstance(result, Command)
        and isinstance(result.update, dict)
        and "messages" in result.update
    ):
        return replace(
            result,
            update={
                **result.update,
                "messages": [
                    enforce_tool_status(m) for m in result.update.get("messages", [])
                ],
            },
        )
    if not isinstance(result, ToolMessage) or result.status == "error":
        return result
    content = result.content
    if isinstance(content, str):
        try:
            payload = json.loads(content)
        except ValueError:
            payload = None  # Tools may legitimately return plain text.
        if (isinstance(payload, dict) and payload.get("error")) or content.startswith(
            "Error:"
        ):
            return result.model_copy(update={"status": "error"})
    return result


class Preview(TypedDict):
    text: str
    truncated: bool


class ToolStarted(TypedDict):
    type: Literal["tool_start"]
    id: str
    name: str
    args: Preview


class ToolCompleted(TypedDict):
    type: Literal["tool_end"]
    id: str
    name: str
    status: Literal["done", "error"]
    output: Preview
    elapsed_ms: int


def preview(value: Any) -> Preview:
    text = (
        value
        if isinstance(value, str)
        else json.dumps(value, ensure_ascii=False, default=str)
    )
    return {
        "text": text[:MAX_TOOL_PREVIEW_CHARS],
        "truncated": len(text) > MAX_TOOL_PREVIEW_CHARS,
    }


def tool_result_event(
    result: Any, *, call_id: str, name: str, elapsed_ms: int
) -> ToolCompleted:
    """Handle both normal ToolMessages and state-changing toolkit Commands."""
    result = enforce_tool_status(result)
    messages = (
        result.update.get("messages", [])
        if isinstance(result, Command) and isinstance(result.update, dict)
        else [result]
    )
    message = next(
        (
            m
            for m in messages
            if isinstance(m, ToolMessage) and m.tool_call_id == call_id
        ),
        None,
    )
    content = message.content if message is not None else str(result)
    failed = message is not None and message.status == "error"
    return {
        "type": "tool_end",
        "id": call_id,
        "name": name,
        "status": "error" if failed else "done",
        "output": preview(content),
        "elapsed_ms": elapsed_ms,
    }


def workout_updates(result: Any) -> list[dict]:
    """Extract typed domain results, never the truncated tool previews."""
    if not isinstance(result, str):
        return []
    try:
        payload = json.loads(result)
    except ValueError:
        return []
    if not isinstance(payload, dict):
        return []
    sessions = payload.get("sessions", [])
    if isinstance(payload.get("session"), dict):
        sessions = [payload["session"]]
    if not isinstance(sessions, list) or len(sessions) > 50:
        return []
    return [
        {"session": session, "export": payload.get("export")}
        for session in sessions
        if isinstance(session, dict)
        and isinstance(session.get("id"), int)
        and isinstance(session.get("revision"), int)
    ]


def coach_card(result: Any) -> dict | None:
    """References only, emitted after a confirmed domain write."""
    if (
        not isinstance(result, ToolMessage)
        or result.status == "error"
        or not isinstance(result.content, str)
    ):
        return None
    try:
        payload = json.loads(result.content)
    except ValueError:
        return None
    if not isinstance(payload, dict) or payload.get("error"):
        return None
    kind, ident = None, None
    if result.name == "remember_fact" and payload.get("saved"):
        kind, ident = "fact", payload.get("fact", {}).get("id")
    elif result.name == "forget_fact" and payload.get("forgotten"):
        kind, ident = "fact", payload.get("fact_id")
    elif result.name == "respond_coach_followup" and payload.get("saved"):
        kind, ident = "followup", payload.get("followup", {}).get("id")
    if kind is None or type(ident) is not int or ident <= 0:
        return None
    return {
        "type": "coach_card",
        "id": f"{kind}:{ident}",
        "ref_kind": kind,
        "ref_id": ident,
    }
