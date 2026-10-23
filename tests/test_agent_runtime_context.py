"""The clock is immutable per human turn, including browser history replay."""

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from langchain.agents.middleware import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from arete.agent.context.builder import ContextBudgetExceeded, validate_context
from arete.agent.middlewares.runtime_context import RuntimeContextMiddleware
from arete.agent.runtime.context import MESSAGE_SENT_AT_KEY, AgentContext

NOW = datetime(2026, 10, 15, 23, 59, 59, tzinfo=ZoneInfo("Europe/Paris"))


def request(messages, moment=NOW, profile="chat"):
    return ModelRequest(
        model=None,
        messages=messages,
        tools=[],
        system_message=SystemMessage("Stable harness"),
        state={"messages": messages},
        runtime=SimpleNamespace(
            context=AgentContext(current_datetime=moment, profile=profile)
        ),
    )


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("multimodal", [False, True])
def test_clock_preserves_state_metadata_tool_pairs_and_budget(async_mode, multimodal):
    content = (
        [
            {"type": "text", "text": "Et demain ?"},
            {
                "type": "image_url",
                "image_url": {"url": "https://example.test/photo.png"},
            },
        ]
        if multimodal
        else "Et demain ?"
    )
    messages = [
        HumanMessage("Ancien message sans date."),
        AIMessage("Ancienne réponse."),
        HumanMessage(
            content, id="question", name="athlete", additional_kwargs={"keep": True}
        ),
        AIMessage("", tool_calls=[{"name": "read", "args": {}, "id": "call"}]),
        ToolMessage("Résultat", tool_call_id="call"),
    ]
    original = request(messages)
    raw = [m.model_dump() for m in messages]
    middleware = RuntimeContextMiddleware()

    async def handler(built):
        return built

    def build(source):
        return (
            asyncio.run(middleware.awrap_model_call(source, handler))
            if async_mode
            else middleware.wrap_model_call(source, lambda r: r)
        )

    first, repeated = build(original), build(original)
    later = build(request(messages, NOW + timedelta(seconds=2)))
    assert first.system_message == repeated.system_message == later.system_message
    assert NOW.isoformat() not in first.system_message.text
    assert first.messages == repeated.messages
    assert first.messages[:2] == later.messages[:2] == messages[:2]
    assert first.messages[3:] == later.messages[3:] == messages[3:]
    current = first.messages[2]
    assert current.id == "question" and current.name == "athlete"
    assert current.additional_kwargs == {"keep": True}
    assert "2026-10-15T23:59:59+02:00" in current.text
    assert "Demain : 2026-10-16" in current.text
    assert "Demain : 2026-10-17" in later.messages[2].text
    assert [m.model_dump() for m in messages] == raw
    assert (
        current.content[:-1] == content
        if multimodal
        else current.text.startswith(content)
    )
    cost = validate_context(first, context_tokens=8192, output_tokens=4096)
    assert cost > validate_context(original, context_tokens=8192, output_tokens=4096)
    with pytest.raises(ContextBudgetExceeded):
        validate_context(
            first, context_tokens=cost + 1024 + 4096 - 1, output_tokens=4096
        )


def test_stamped_turn_is_replayed_identically_after_midnight_and_timezone_change():
    from arete.api.agent import ChatMessageIn, _to_langchain

    middleware = RuntimeContextMiddleware()
    question = HumanMessage(
        "Demain ?",
        id="question",
        additional_kwargs={MESSAGE_SENT_AT_KEY: "1999-01-01T00:00:00+00:00"},
    )
    original = request([question])
    update = middleware.before_agent(original.state, original.runtime)
    stamped = update["messages"][0]
    assert stamped.id == question.id
    assert stamped.content == question.content
    assert stamped.additional_kwargs[MESSAGE_SENT_AT_KEY] == NOW.isoformat()
    first = middleware.wrap_model_call(
        original.override(messages=[stamped]), lambda r: r
    )
    # Serialize through the actual browser/API contract; parsing a fixed offset
    # must produce the same model bytes as the original ZoneInfo timestamp.
    replay = ChatMessageIn(
        role="user",
        content=question.text,
        sent_at=stamped.additional_kwargs[MESSAGE_SENT_AT_KEY],
    )
    history = [
        _to_langchain(replay.role, replay.content, replay.sent_at.isoformat()),
        AIMessage("Réponse."),
        HumanMessage("Et aujourd’hui ?", id="new"),
    ]
    next_day = datetime(2026, 10, 16, 10, 0, tzinfo=ZoneInfo("America/New_York"))
    second = middleware.wrap_model_call(request(history, next_day), lambda r: r)
    assert first.system_message == second.system_message
    assert first.messages[0].content == second.messages[0].content
    assert "2026-10-16T10:00:00-04:00" in second.messages[-1].text
    assert question.additional_kwargs[MESSAGE_SENT_AT_KEY].startswith("1999")


def test_compacted_request_keeps_clock_and_raw_summary():
    from deepagents.middleware.summarization import SummarizationMiddleware

    summary = HumanMessage("Résumé sans horloge.")
    history = [HumanMessage("Demain ?"), AIMessage("Réponse longue.")]
    messages = SummarizationMiddleware._apply_event_to_messages(
        history,
        {"cutoff_index": 2, "summary_message": summary, "file_path": "/history.md"},
    )
    built = RuntimeContextMiddleware().wrap_model_call(request(messages), lambda r: r)
    assert NOW.isoformat() in built.messages[-1].text
    assert "server_datetime" not in summary.text


@pytest.mark.parametrize(
    "profile", ["briefing", "feedback", "review", "evening", "slack"]
)
def test_background_profiles_keep_their_server_date(profile):
    original = request([HumanMessage("Facts")], profile=profile)
    built = RuntimeContextMiddleware().wrap_model_call(original, lambda r: r)
    assert "Date actuelle : 2026-10-15" in built.system_message.text
    assert built.messages == original.messages


def test_missing_human_is_an_explicit_invariant_failure():
    with pytest.raises(AssertionError, match="human message"):
        RuntimeContextMiddleware().wrap_model_call(
            request([AIMessage("No question")]), lambda r: r
        )
