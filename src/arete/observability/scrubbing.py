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

# Keys whose value is structural or operational, never athlete content:
# a run/tool/message's own name, type and identifiers, and model/finish
# bookkeeping. Kept verbatim wherever they appear, at any depth. Token usage
# and timings need no entry here: they are already numbers, and only string
# values are ever redacted below.
ALLOWED_KEYS = frozenset(
    {
        "name",
        "type",
        "role",
        "id",
        "tool_call_id",
        "run_id",
        "parent_run_id",
        "trace_id",
        "lc",
        "model",
        "model_name",
        "finish_reason",
        "status",
        "object",
        "chunk_position",
    }
)

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


#: An identifier (name, id, status, model) never needs more than this; a
#: longer string under an allowlisted key is free text wearing that key's
#: name, not the identifier the allowlist was meant for.
MAX_ALLOWED_VALUE_CHARS = 200


def _is_safe_allowlisted_value(value: Any) -> bool:
    return len(value) <= MAX_ALLOWED_VALUE_CHARS if isinstance(value, str) else True


#: A schema field name (content, tool_calls, additional_kwargs, ...) is a
#: short snake_case identifier or a plain index; a dict acting as a lookup
#: table (state["files"], keyed by an athlete-chosen filename) is not. The
#: value-side allowlist cannot protect a key, so a key failing this pattern
#: is redacted like any other free-text value instead of trusted by default.
_SAFE_KEY = re.compile(r"^(?:[a-z][a-z0-9_]{0,39}|\d+)$")


def _redact_key(key: Any) -> Any:
    if isinstance(key, str) and not _SAFE_KEY.match(key):
        return _redact_string(key)
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


def _walk(value: Any, *, depth: int, nodes_left: list[int]) -> Any:
    assert depth >= 0
    assert nodes_left[0] >= 0
    if depth > WALK_DEPTH_MAX or nodes_left[0] == 0:
        return REDACTED_TRUNCATED
    nodes_left[0] -= 1

    if isinstance(value, BaseMessage):
        return _redact_message(value, depth=depth, nodes_left=nodes_left)
    if isinstance(value, dict):
        return {
            _redact_key(key): child
            if key in ALLOWED_KEYS
            and not isinstance(child, (dict, list, tuple))
            and _is_safe_allowlisted_value(child)
            else _walk(child, depth=depth + 1, nodes_left=nodes_left)
            for key, child in value.items()
        }
    if isinstance(value, (list, tuple)):
        return type(value)(
            _walk(item, depth=depth + 1, nodes_left=nodes_left) for item in value
        )
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
