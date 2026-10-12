"""Agent configuration without framework hooks or I/O."""

from dataclasses import dataclass
from typing import Literal

ProfileId = Literal["chat", "briefing", "feedback", "review", "slack"]


@dataclass(frozen=True)
class AgentProfile:
    id: ProfileId
    name: str
    instructions: str
    capabilities: tuple[str, ...]
    training_writes: bool = False
    page_context: bool = False
    #: Filesystem tools on the coach's journal; missions get it in the prompt
    #: and the server files their entries.
    journal_tools: bool = False

    system_prompt: str | None = None
    personal_context: bool = True
    external_write_tools: frozenset[str] = frozenset()
