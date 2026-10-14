"""Capability declarations shared by native binding, instructions and authorization."""

from __future__ import annotations

from dataclasses import dataclass

from langchain_core.tools import BaseTool


@dataclass(frozen=True)
class Toolkit:
    """A named bundle of tools + the instructions to use them well."""

    id: str
    description: str
    tools: list[BaseTool]
    instructions: str
    # Explicit allowlist: a newly added tool is unavailable to background jobs
    # until its read-only behavior has been reviewed.
    read_tools: frozenset[str]
    # Only explicit workout actions may create interactive chat cards.
    workout_actions: frozenset[str] = frozenset()
