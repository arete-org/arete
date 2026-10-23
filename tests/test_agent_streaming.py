"""Protocol regressions: correlation, final snapshots, errors and prompt scope."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langgraph.types import Command

from arete.agent.middlewares.events import ToolEventMiddleware
from arete.agent.runtime.events import (
    MAX_TOOL_PREVIEW_CHARS,
    preview,
    tool_result_event,
)
from arete.agent.runtime.streaming import StreamProjection


def token(text, message_id, **metadata):
    return {
        "type": "messages",
        "ns": (),
        "data": (
            AIMessageChunk(content=text, id=message_id),
            {"langgraph_node": "model", **metadata},
        ),
    }


def test_turns_are_separate_and_final_update_reconciles_tokens():
    stream = StreamProjection()
    assert stream.events(token("Je consulte.", "first"))[0]["id"] == "first"
    stream.events(token("**Bon", "answer"))
    stream.events(token("jour**", "answer"))
    update = {
        "type": "updates",
        "data": {
            "model": {"messages": [AIMessage(content="**Bonjour** !", id="answer")]}
        },
    }
    assert stream.events(update) == [
        {"type": "message", "id": "answer", "text": "**Bonjour** !"}
    ]
    assert stream.done()["message"]["content"] == "**Bonjour** !"
    assert stream.texts["first"] == "Je consulte."


def test_nonstreaming_provider_and_nested_messages():
    stream = StreamProjection()
    nested = token("Private subagent text", "child")
    nested["ns"] = ("tools:child",)
    assert stream.events(nested) == []
    stream.events(
        {
            "type": "updates",
            "data": {"model": {"messages": [AIMessage(content="Answer", id="root")]}},
        }
    )
    assert stream.done()["message"]["content"] == "Answer"


def test_empty_and_oversized_stream_fail_explicitly():
    stream = StreamProjection()
    with pytest.raises(ValueError, match="aucune réponse"):
        stream.done()
    with (
        patch("arete.agent.runtime.streaming.MAX_STREAM_TEXT_CHARS", 5),
        pytest.raises(ValueError, match="taille"),
    ):
        stream.events(token("Too long", "m"))


def test_native_summary_tokens_never_replace_the_user_answer():
    from arete.agent.runtime.execution import _is_answer_text

    stream = StreamProjection()
    stream.events(token("Réponse du coach", "answer"))
    assert (
        stream.events(token("Résumé interne", "summary", lc_source="summarization"))
        == []
    )
    assert stream.done()["message"]["content"] == "Réponse du coach"
    assert "summary" not in stream.texts
    assert not _is_answer_text(
        token("Résumé interne", "summary", lc_source="summarization")
    )
    assert _is_answer_text(token("Réponse", "answer"))


@pytest.mark.parametrize("text", [None, "", " ", "x" * 301, "🏃" * 301])
def test_invalid_optional_suggestion_preserves_the_answer(text, caplog):
    stream = StreamProjection()
    stream.events(token("Réponse", "answer"))
    assert (
        stream.events({"type": "custom", "data": {"type": "suggestion", "text": text}})
        == []
    )
    assert stream.done()["message"]["content"] == "Réponse"
    assert "draft omitted" not in caplog.text


def test_suggestion_limit_counts_unicode_code_points():
    stream = StreamProjection()
    event = {"type": "suggestion", "text": "🏃" * 300}
    assert stream.events({"type": "custom", "data": event}) == []


@pytest.mark.parametrize(
    "result",
    [
        ToolMessage(content='{"error":"Invalid date"}', tool_call_id="t"),
        ToolMessage(content="Failure", status="error", tool_call_id="t"),
        Command(
            update={
                "messages": [
                    ToolMessage(content='{"error":"Unknown toolkit"}', tool_call_id="t")
                ]
            }
        ),
        ToolMessage(content="Error: File missing", tool_call_id="t"),
    ],
)
def test_error_results_are_not_successful_tool_events(result):
    event = tool_result_event(result, call_id="t", name="tool", elapsed_ms=12)
    assert event["status"] == "error"
    assert event["id"] == "t"
    assert event["output"]["text"]


def test_preview_marks_omitted_content():
    result = preview("x" * (MAX_TOOL_PREVIEW_CHARS + 10))
    assert result["truncated"] is True
    assert len(result["text"]) == MAX_TOOL_PREVIEW_CHARS


@pytest.mark.parametrize("async_mode", [False, True])
def test_tool_exception_emits_failure_and_propagates(async_mode):
    events = []
    request = SimpleNamespace(tool_call={"id": "t", "name": "tool", "args": {}})

    def fail(_request):
        raise RuntimeError("Failed operation")

    async def afail(_request):
        return fail(_request)

    middleware = ToolEventMiddleware()
    with (
        patch("langgraph.config.get_stream_writer", return_value=events.append),
        pytest.raises(RuntimeError, match="Failed operation"),
    ):
        if async_mode:
            asyncio.run(middleware.awrap_tool_call(request, afail))
        else:
            middleware.wrap_tool_call(request, fail)
    assert [e["type"] for e in events] == ["tool_start", "tool_end"]
    assert events[-1]["status"] == "error"
    assert events[-1]["id"] == "t"


@pytest.mark.parametrize("async_mode", [False, True])
def test_system_skill_catalog_and_loaded_instructions_reach_every_model_call(
    monkeypatch, tmp_path, async_mode
):
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    from arete.agent.capabilities.registry import CAPABILITIES
    from arete.agent.profiles.catalog import get_profile
    from arete.agent.prompts.coach import SYSTEM_SKILL
    from arete.agent.runtime.context import AgentContext
    from arete.coaching import get_agent

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "isolated.duckdb"))
    from arete.dataio.init_duckdb import main as init_db

    init_db()  # Exercise the real schema now that missing facts cannot be hidden.
    seen = []
    bound_tools = []

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            bound_tools.append({t.name for t in tools})
            return self

        def _generate(self, messages, *args, **kwargs):
            seen.append(messages[0].text)
            return super()._generate(messages, *args, **kwargs)

    model = Model(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "load",
                            "name": "list_planned",
                            "args": {},
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="Les outils sont prêts."),
            ]
        )
    )
    get_agent.cache_clear()
    try:
        with patch("arete.coaching.build_chat_model", return_value=model):
            graph = get_agent()
        args = ({"messages": [{"role": "user", "content": "Charge analytics"}]},)
        kwargs = {
            "context": AgentContext(source={}),
            "config": {"recursion_limit": 100},
        }
        if async_mode:
            asyncio.run(graph.ainvoke(*args, **kwargs))
        else:
            graph.invoke(*args, **kwargs)
    finally:
        get_agent.cache_clear()
    assert len(seen) == 2
    for prompt in seen:
        assert SYSTEM_SKILL in prompt
        assert prompt.count("Skills système disponibles") == 1
        assert "/skills/system/document-planning/SKILL.md" in prompt
    for capability in get_profile("chat").capabilities:
        assert all(CAPABILITIES[capability].instructions in prompt for prompt in seen)
    assert CAPABILITIES["calendar"].instructions not in seen[0]
    assert all(
        "read_file" in tools and "list_planned" in tools for tools in bound_tools
    )


def test_real_graph_sse_delivers_correlated_tools_and_final_snapshot(client):
    import json

    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    from arete.agent.capabilities.discovery import authorized_tools
    from arete.agent.middlewares.capabilities import ToolkitMiddleware

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    graph = create_agent(
        Model(
            # GenericFake streaming omits native tool_calls. Completed messages
            # exercise the same graph and the non-streaming-provider fallback.
            disable_streaming=True,
            messages=iter(
                [
                    AIMessage(
                        content="Je charge les outils.",
                        tool_calls=[
                            {
                                "id": "t1",
                                "name": "list_planned",
                                "args": {},
                                "type": "tool_call",
                            }
                        ],
                    ),
                    AIMessage(content="## Prêt\n\n- **Analyser** ta forme."),
                ]
            ),
        ),
        tools=authorized_tools("chat"),
        middleware=[ToolEventMiddleware(), ToolkitMiddleware()],
    )
    with patch("arete.api.agent.get_agent", return_value=graph):
        response = client.post(
            "/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "Charge analytics"}]},
        )
    events = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    starts = [e for e in events if e["type"] == "tool_start"]
    ends = [e for e in events if e["type"] == "tool_end"]
    assert len(starts) == len(ends) == 1, events
    assert starts[0]["id"] == ends[0]["id"] == "t1"
    assert ends[0]["status"] == "done"
    snapshots = [e for e in events if e["type"] == "message"]
    assert len(snapshots) == 2
    assert snapshots[0]["id"] != snapshots[1]["id"]
    assert events[-1]["message"]["content"] == "## Prêt\n\n- **Analyser** ta forme."


@pytest.mark.parametrize("streaming", [False, True])
def test_answer_uses_no_auxiliary_model_even_for_old_clients(
    monkeypatch, tmp_path, router_client, streaming
):
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    from arete.api.agent import router
    from arete.coaching import get_agent

    calls = []

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, *args, **kwargs):
            calls.append(True)
            return super()._generate(*args, **kwargs)

    monkeypatch.setattr("arete.services.memory.memory_root", lambda: tmp_path)
    monkeypatch.setattr(
        "arete.coaching.build_chat_model",
        lambda **kwargs: Model(
            messages=iter([AIMessage(content="Bonjour.")]), disable_streaming=True
        ),
    )
    get_agent.cache_clear()
    try:
        response = router_client(router).post(
            "/agent/chat/stream" if streaming else "/agent/chat",
            json={
                "messages": [{"role": "user", "content": "Bonjour"}],
                "supports_suggestions": True,
            },
        )
        assert response.status_code == 200
        assert "Bonjour." in response.text
        assert "suggestion" not in response.text
        assert calls == [True]
    finally:
        get_agent.cache_clear()
