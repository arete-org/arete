"""The final request budget includes schemas and system context, not history alone."""

from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool

from arete.agent.context.builder import ContextBudgetExceeded, validate_context
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.policy import resolve_policy


def test_large_system_instructions_exceed_the_complete_budget():
    request = SimpleNamespace(
        messages=[HumanMessage("hi")],
        tools=[],
        system_message=SystemMessage("long " * 8000),
    )
    with pytest.raises(ContextBudgetExceeded):
        validate_context(request, context_tokens=8192, output_tokens=4096)


def test_tool_schemas_consume_the_same_context_budget():
    def read() -> str:
        """Read."""
        return "ok"

    request = SimpleNamespace(
        messages=[HumanMessage("hi")], tools=[], system_message=SystemMessage("coach")
    )
    assert validate_context(request, context_tokens=8192, output_tokens=4096) < 100
    request.tools = [StructuredTool.from_function(read, description="schema " * 8000)]
    with pytest.raises(ContextBudgetExceeded):
        validate_context(request, context_tokens=8192, output_tokens=4096)


def test_execution_policy_is_independent_of_framework_hooks():
    assert resolve_policy("chat").can_execute(
        "planning", "create_planned_session", frozenset({"list_planned"})
    )
    assert not resolve_policy("briefing").can_execute(
        "planning", "create_planned_session", frozenset({"list_planned"})
    )
    assert not resolve_policy("briefing").can_execute(
        "analytics", "future_write", frozenset({"get_workload"})
    )
    # The briefing gets its facts in the message: it executes nothing.
    assert not resolve_policy("briefing").can_execute(
        "analytics", "get_workload", frozenset({"get_workload"})
    )
    with pytest.raises(ValueError, match="Unknown"):
        resolve_policy("client_admin")


def test_compiled_background_profile_rejects_chat_policy_before_model_execution():
    from arete.agent.middlewares.policy import ProfilePolicyMiddleware

    middleware = ProfilePolicyMiddleware("briefing")
    with pytest.raises(AssertionError, match="compiled policy"):
        middleware.before_agent(
            {},
            SimpleNamespace(context=AgentContext(profile="chat")),
        )


def test_attachment_manifest_keeps_bodies_out_of_system_and_preserves_full_state():
    import json

    from deepagents.backends.utils import file_data_to_string

    from arete.agent.backends.attachments import attachment_files
    from arete.agent.context.attachments import (
        attachment_section,
    )

    text = "date, séance\n" * 4000 + "fin du programme"
    paths = tuple(f"/attachments/{i}.md" for i in range(20))
    files = attachment_files(dict.fromkeys(paths, text))
    section = attachment_section(files, paths)
    previews = json.loads(section.split("\n", 1)[1])
    assert {p["path"] for p in previews} == set(paths)
    assert all(p["total_chars"] == len(text) for p in previews)
    assert all("text" not in p for p in previews)
    assert "date, séance" not in section
    assert all(file_data_to_string(f) == text for f in files.values())
    with pytest.raises(AssertionError, match="missing"):
        attachment_section({}, paths)
    # Attachment evidence goes through the same complete-request budget.
    with pytest.raises(ContextBudgetExceeded):
        validate_context(
            SimpleNamespace(
                messages=[HumanMessage("Lis")],
                tools=[],
                system_message=SystemMessage("harness " * 3000 + section),
            ),
            context_tokens=8192,
            output_tokens=4096,
        )
