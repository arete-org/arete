"""What a briefing or a session feedback must look like, checked without a model.

Used by deterministic regression tests. Each check returns the list of what is
wrong, empty when fine.
"""

from __future__ import annotations

import re

#: Field names the prompts forbid: the athlete reads French, not a payload.
RAW_FIELDS = ("days_with_data", "readiness_score", "fitness_goal", "acwr_", "tsb=")

_LIST_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s", re.MULTILINE)


def _sentences(text: str) -> int:
    return len([s for s in re.split(r"(?<=[.!?…])\s+", text.strip()) if s])


def _common(text: str, max_chars: int) -> list[str]:
    problems = []
    if not text.strip():
        return ["empty"]
    if len(text) > max_chars:
        problems.append(f"{len(text)} chars > {max_chars}")
    if _LIST_LINE.search(text):
        problems.append("a list")
    if not 1 <= _sentences(text) <= 5:
        problems.append(f"{_sentences(text)} sentences")
    if not re.search(r"\b(tu|ta|ton|tes|te|t')", text, re.IGNORECASE):
        problems.append("not addressed to the athlete (tu)")
    if any(field in text for field in RAW_FIELDS):
        problems.append("a raw field name")
    if re.search(r"\b(let me|the user|I need to|thinking)\b", text, re.IGNORECASE):
        problems.append("leaked reasoning in English")
    return problems


def briefing_problems(text: str) -> list[str]:
    problems = _common(text, 1_200)
    if "aujourd" not in text.lower():
        problems.append("no action for today")
    if not re.search(r"\d", text):
        problems.append("no number")
    return problems


def feedback_problems(text: str) -> list[str]:
    return _common(text, 900)
