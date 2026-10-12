"""Normalize provider usage for structured logs, without claiming missing usage is zero."""

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


_REPEATED = re.compile(r"(.+?)\1+")


def _model_name(raw: str) -> str:
    """A streamed answer merges its chunks' metadata, strings included, so the
    name arrives repeated once per chunk carrying it ("x:freex:free")."""
    repeated = _REPEATED.fullmatch(raw)
    return repeated.group(1) if repeated else raw


def served_models(response: Any) -> list[str]:
    """Models the provider actually used; a router or fallback list may differ
    from the configured name."""
    return [
        _model_name(name)
        for m in getattr(response, "result", [])
        if (name := (getattr(m, "response_metadata", None) or {}).get("model_name"))
    ]


def record_model_call(
    *, model: str, elapsed_ms: int, response: Any = None, error: str | None = None
) -> None:
    usages = [
        m.usage_metadata
        for m in getattr(response, "result", [])
        if getattr(m, "usage_metadata", None)
    ]
    logger.info(
        "Agent model call: model=%s served=%s elapsed_ms=%d usage=%s error=%s",
        model,
        served_models(response) or None,
        elapsed_ms,
        usages or None,
        error,
    )


def record_decision_call(
    *, model: str, elapsed_ms: int, payload: dict | None, error: str | None
) -> None:
    # Both decision callers report usage without logging the athlete's source text.
    logger.info(
        "Agent model call: model=%s served=%s elapsed_ms=%d usage=%s error=%s",
        model,
        payload.get("model") if payload else None,
        elapsed_ms,
        payload.get("usage") if payload else None,
        error,
    )


def record_run(
    *, profile: str, stats: Any, total_ms: int, error: str | None = None
) -> None:
    """One line per run: what a turn, a briefing or a feedback really cost."""
    logger.info(
        "Agent run: profile=%s calls=%d tools=%d model_ms=%d ttft_ms=%s "
        "total_ms=%d first_result_ms=%s models=%s error=%s skill_reads=%d skill_read_ms=%d skill_read_tokens_approx=%d memory_searches=%d memory_ms=%d memory_tokens=%d memory_decision_calls=%d memory_decision_ms=%d",
        profile,
        stats.model_calls,
        stats.tool_calls,
        stats.model_ms,
        stats.first_token_ms,
        total_ms,
        stats.first_result_ms,
        sorted(set(stats.served_models)) or None,
        error,
        stats.skill_reads,
        stats.skill_read_ms,
        stats.skill_read_tokens_approx,
        stats.memory_searches,
        stats.memory_ms,
        stats.memory_tokens,
        stats.memory_decision_calls,
        stats.memory_decision_ms,
    )
