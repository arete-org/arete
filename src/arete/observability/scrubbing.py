"""Default-deny redaction of model/tool content before it leaves to LangSmith.

LangSmith stores run inputs, outputs and tool results server-side once tracing
is opted in. Chasing every path where athlete content (journal, facts,
attachments, retrieved memory, chat turns) can appear keeps leaking: a new
tool, a new middleware or a new retrieval path adds another path nobody
remembered to list. Redact by default instead: keep only the handful of keys
that are structural or operational, never free text, and redact every other
string value, whatever key it sits under. This module is pure: no agent, API
or HTTP imports.
"""

from __future__ import annotations

import re
from typing import Any

from langchain_core.messages import BaseMessage

# A structure deeper or larger than this is unexpected for a coaching run;
# redact it wholesale rather than walk it unscrubbed.
WALK_DEPTH_MAX = 20
WALK_NODES_MAX = 2_000

REDACTED = "[REDACTED]"
REDACTED_TRUNCATED = "[REDACTED:truncated]"

# Keys whose value is structural or operational, never athlete content: a
# run/tool/message's own name, type and identifiers, and model/finish
# bookkeeping. Kept verbatim wherever they appear, at any depth (bounded by
# _is_trusted_field below). Token usage and timings need no entry here:
# they are already numbers, and only string values are ever redacted.
#
# "name"/"id"/"model"/"trace_id" stay open-ended: a tool, run or model name
# is developer- or framework-chosen, never athlete free text in this
# codebase, but it cannot be checked against a closed set without the
# scrubber knowing every tool and middleware name, which would make it an
# agent-aware allowlist again. A handful of genuinely closed vocabularies
# (below) are checked exactly instead of trusted by shape.
ALLOWED_KEYS = frozenset(
    {
        "name",
        "id",
        "tool_call_id",
        "run_id",
        "parent_run_id",
        "trace_id",
        "lc",
        "model",
        "model_name",
    }
)

# Values for a key with a genuinely small, closed vocabulary: checked
# exactly, so a short athlete word (an injury, a body part) cannot pass
# merely for being short and lowercase like a real enum member.
ALLOWED_ENUM_VALUES: dict[str, frozenset[str]] = {
    "type": frozenset(
        {
            "human",
            "ai",
            "system",
            "tool",
            "function",
            "chat",
            "constructor",
            "not_implemented",
            "chain",
            "llm",
            "tool_call",
            "undefined",
            # BaseMessage subclasses report their own class name while
            # streaming, not the lowercase type above.
            "HumanMessageChunk",
            "AIMessageChunk",
            "SystemMessageChunk",
            "ToolMessageChunk",
            "FunctionMessageChunk",
            "ChatMessageChunk",
        }
    ),
    "role": frozenset({"user", "assistant", "system", "tool", "function"}),
    "status": frozenset({"success", "error", "pending"}),
    "finish_reason": frozenset(
        {"stop", "length", "tool_calls", "content_filter", "function_call"}
    ),
    "object": frozenset(
        {"chat.completion", "chat.completion.chunk", "text_completion"}
    ),
    "chunk_position": frozenset({"first", "middle", "last"}),
}

_ERROR_TYPE = re.compile(r"^[A-Za-z_][\w.]*")


def redact_error(message: str | None) -> str | None:
    """Keep only the exception's type name; the rest can echo tool input.

    `langsmith.Client` never routes a run's error string through
    `hide_inputs`/`hide_outputs` (only through its separate `anonymizer`
    hook, which this codebase does not use), so a caller with the run's
    error in hand must redact it directly instead of relying on `scrub()`.
    """
    if message is None:
        return None
    match = _ERROR_TYPE.match(message)
    error_type = match.group(0) if match else "Error"
    return f"{error_type}: {REDACTED}"


def _redact_string(value: str) -> str:
    return f"[REDACTED:{len(value)} chars]" if value else REDACTED


#: A real tool/run/model name or id never contains whitespace and is short;
#: an athlete sentence (or a single free-text word long enough to matter)
#: reliably fails one of the two. Shape, not just length, is the check: a
#: multi-word answer about an injury or a mood always has a space.
_IDENTIFIER_SHAPED = re.compile(r"^\S{1,64}$")


def _is_trusted_field(key: Any, value: Any) -> bool:
    # Only a plain scalar is ever trusted outright; a dict, list, tuple, or
    # an object of an unrecognized type must still fall through to _walk,
    # which is the only place that redacts an object by its class name.
    if value is None or isinstance(value, (bool, int, float)):
        return key in ALLOWED_KEYS
    if not isinstance(value, str):
        return False
    if key in ALLOWED_ENUM_VALUES:
        return value in ALLOWED_ENUM_VALUES[key]
    return key in ALLOWED_KEYS and bool(_IDENTIFIER_SHAPED.match(value))


#: A schema field name (content, tool_calls, additional_kwargs, ...) is a
#: short snake_case identifier or a plain index; a dict acting as a lookup
#: table (state["files"], keyed by an athlete-chosen filename) is not. The
#: value-side allowlist cannot protect a key, so a key failing this pattern
#: is redacted like any other free-text value instead of trusted by default.
_SAFE_KEY = re.compile(r"^(?:[a-z][a-z0-9_]{0,39}|\d+)$")


def _redact_key(key: Any, index: int) -> Any:
    if isinstance(key, str) and not _SAFE_KEY.match(key):
        # Position, not content, disambiguates two redacted keys of equal
        # length: a plain length marker would collide and drop an entry.
        return f"[REDACTED:{len(key)} chars, item {index}]"
    return key


def _redact_message(
    value: BaseMessage, *, depth: int, nodes_left: list[int]
) -> BaseMessage:
    updates: dict[str, Any] = {
        "content": _walk(value.content, depth=depth + 1, nodes_left=nodes_left),
        "additional_kwargs": _walk(
            value.additional_kwargs, depth=depth + 1, nodes_left=nodes_left
        ),
    }
    response_metadata = getattr(value, "response_metadata", None)
    if response_metadata:
        updates["response_metadata"] = _walk(
            response_metadata, depth=depth + 1, nodes_left=nodes_left
        )
    tool_calls = getattr(value, "tool_calls", None)
    if tool_calls:
        updates["tool_calls"] = _walk(
            tool_calls, depth=depth + 1, nodes_left=nodes_left
        )
    return value.model_copy(update=updates)


def _walk_dict(value: dict, *, depth: int, nodes_left: list[int]) -> dict:
    """Bounded by item, not just by recursion: a huge dict of cheap,
    trusted-looking entries must still stop at the node budget, the same as
    one that recurses on every entry."""
    result: dict[Any, Any] = {}
    for index, (key, child) in enumerate(value.items()):
        if nodes_left[0] <= 0:
            # A JSON-safe string key: Ellipsis or any non-string key would
            # break serialization downstream, which scrub()'s own try/except
            # cannot see since it happens after this payload is returned.
            result[REDACTED_TRUNCATED] = len(value) - index
            break
        nodes_left[0] -= 1
        value_out = (
            child
            if _is_trusted_field(key, child)
            else _walk(child, depth=depth + 1, nodes_left=nodes_left)
        )
        result[_redact_key(key, index)] = value_out
    return result


def _walk_sequence(value: list | tuple, *, depth: int, nodes_left: list[int]):
    result = []
    for item in value:
        if nodes_left[0] <= 0:
            result.append(REDACTED_TRUNCATED)
            break
        nodes_left[0] -= 1
        result.append(_walk(item, depth=depth + 1, nodes_left=nodes_left))
    return type(value)(result)


def _walk(value: Any, *, depth: int, nodes_left: list[int]) -> Any:
    assert depth >= 0
    assert nodes_left[0] >= 0
    if depth > WALK_DEPTH_MAX or nodes_left[0] == 0:
        return REDACTED_TRUNCATED
    nodes_left[0] -= 1

    if isinstance(value, BaseMessage):
        return _redact_message(value, depth=depth, nodes_left=nodes_left)
    if isinstance(value, dict):
        return _walk_dict(value, depth=depth, nodes_left=nodes_left)
    if isinstance(value, (list, tuple)):
        return _walk_sequence(value, depth=depth, nodes_left=nodes_left)
    if isinstance(value, str):
        return _redact_string(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    # An object of a type this walker does not recognize (a bound model, a
    # Path, a custom class) is unknown content, not safe metadata: redact it
    # rather than pass it through unexamined. A chain run's inputs can carry
    # the model object itself, not just messages.
    return f"[REDACTED:{type(value).__name__}]"


def scrub(payload: dict) -> dict:
    """Redact a LangSmith run's inputs or outputs dict; bounded, never raises.

    Safe to pass directly as `langsmith.Client(hide_inputs=scrub, hide_outputs=scrub)`.
    Any unexpected failure redacts everything rather than leaking the payload.
    """
    if not isinstance(payload, dict):
        return payload
    try:
        nodes_left = [WALK_NODES_MAX]
        scrubbed = _walk(payload, depth=0, nodes_left=nodes_left)
        assert isinstance(scrubbed, dict)
        return scrubbed
    except Exception:
        return {}
