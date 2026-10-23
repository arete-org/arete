"""Thin adapters to the same automation service used by HTTP."""

import json
from typing import Annotated, Literal

from pydantic import Field

from arete.agent.tools.validation import typed_tool
from arete.services import automations as service
from arete.services.automation_schedule import AutomationInput
from arete.services.coaching_attention import QuestionSubject
from arete.services.human_input import QuestionField


def _out(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


@typed_tool
def create_automation(
    definition: AutomationInput, explicitly_requested: bool = False
) -> str:
    """Schedule a mission. Activate only an explicit athlete request; coach initiatives remain proposals."""
    return _out(service.create(definition, activate=explicitly_requested))


@typed_tool
def list_automations(offset: Annotated[int, Field(ge=0, le=10000)] = 0) -> str:
    """Read scheduled missions and proposals; pagination is explicit."""
    return _out(service.listing(offset=offset))


@typed_tool
def get_automation(automation_id: str) -> str:
    """Read a mission, its revision and its latest run."""
    return _out(service.get(automation_id))


@typed_tool
def update_automation(automation_id: str, definition: service.Update) -> str:
    """Replace a mission using its observed revision; pending occurrences are cancelled."""
    return _out(service.update(automation_id, definition))


@typed_tool
def set_automation_state(
    automation_id: str, revision: int, state: Literal["active", "paused"]
) -> str:
    """Activate or suspend a mission on the athlete's explicit request."""
    return _out(service.set_state(automation_id, revision, state))


@typed_tool
def delete_automation(automation_id: str, revision: int) -> str:
    """Remove a mission on explicit request, preserving its product history."""
    service.delete(automation_id, revision)
    return _out({"deleted": True})


@typed_tool
def ask_athlete(
    question: Annotated[str, Field(min_length=1, max_length=1000)],
    subject: QuestionSubject | None = None,
    fields: Annotated[list[QuestionField], Field(max_length=8)] | None = None,
) -> str:
    """Ask one indispensable question; the human answer supplies information only.

    For perceived effort, availability or missing context about a known session,
    include its typed subject. The server verifies ownership and reuses an existing
    question. Free-form questions without a subject remain unclassified.
    Use fields for structured answers: text, choice, choices, number, date or
    boolean; at most eight fields and eight options. Ask only for information
    needed to proceed. An answer is never approval for a different action.
    """
    raise AssertionError("ask_athlete must be answered by a human interrupt")


AUTOMATION_TOOLS = [
    create_automation,
    list_automations,
    get_automation,
    update_automation,
    set_automation_state,
    delete_automation,
]
