"""Agent configuration without framework hooks or I/O."""

from dataclasses import dataclass
from typing import Literal

ProfileId = Literal[
    "chat", "briefing", "feedback", "review", "evening", "slack", "automation"
]


@dataclass(frozen=True)
class AgentProfile:
    id: ProfileId
    name: str
    instructions: str
    capabilities: tuple[str, ...]
    training_writes: bool = False
    page_context: bool = False
    #: Native tools over the server-composed filesystem mounts.
    filesystem_tools: bool = False
    #: Dated journal appends; background missions file their entries server-side.
    journal_tools: bool = False
    #: Typed durable facts, separate from the notes/session filesystem.
    fact_memory_tools: bool = False

    system_prompt: str | None = None
    personal_context: bool = True
    external_write_tools: frozenset[str] = frozenset()
