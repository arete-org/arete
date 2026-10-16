"""Native offloading preserves searchable evidence and complete domain events."""

import asyncio
import json
from dataclasses import replace
from unittest.mock import Mock

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from arete.agent.factory import build_agent
from arete.agent.profiles.catalog import get_profile
from arete.agent.runtime.context import AgentContext
from arete.coaching import build_agent_filesystem


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def call(name, args, ident="result"):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": ident}])


def graph_for(*responses, offload=True):
    return build_agent(
        replace(
            get_profile("chat"),
            personal_context=False,
            fact_memory_tools=False,
            journal_tools=False,
        ),
        model=Model(messages=iter(responses), disable_streaming=True),
        context_tokens=65536,
        output_tokens=4096,
        filesystem=build_agent_filesystem(offload_tool_results=offload),
    )


def run(graph, async_mode):
    state = {"messages": [HumanMessage("Vérifie les résultats.")]}
    kwargs = {"context": AgentContext(), "config": {"recursion_limit": 30}}
    return (
        asyncio.run(graph.ainvoke(state, **kwargs))
        if async_mode
        else graph.invoke(state, **kwargs)
    )


@pytest.mark.parametrize("async_mode", [False, True])
def test_large_result_is_complete_searchable_and_read_only(monkeypatch, async_mode):
    payload = {
        "rows": [
            {"id": i, "date": "2026-10-14", "description": f"séance numéro {i}"}
            for i in range(1600)
        ]
    }
    query = Mock(return_value=json.dumps(payload, ensure_ascii=False, indent=2))
    monkeypatch.setattr("arete.services.planning.list_planned", query)
    graph = graph_for(
        call("list_planned", {}),
        call("grep", {"path": "/large_tool_results/", "pattern": '"id": 80,'}, "grep"),
        call(
            "read_file",
            {"file_path": "/large_tool_results/result", "offset": 402, "limit": 5},
            "read",
        ),
        call("delete", {"file_path": "/large_tool_results/result"}, "delete"),
        AIMessage(content="Fin."),
        # A second invocation of the same cached graph cannot read old evidence.
        call("read_file", {"file_path": "/large_tool_results/result"}, "old"),
        AIMessage(content="Absent."),
    )
    result = run(graph, async_mode)
    messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert "/large_tool_results/result" in messages[0].content
    assert len(messages[0].content) < len(json.dumps(payload)) / 2
    assert "/large_tool_results/result:" in messages[1].content
    assert '404:       "id": 80,' in messages[1].content
    assert '"description": "séance numéro 80"' in messages[2].content
    assert messages[3].status == "error"
    assert (
        json.loads(result["files"]["/large_tool_results/result"]["content"]) == payload
    )
    later = run(graph, async_mode)
    assert (
        next(m for m in later["messages"] if isinstance(m, ToolMessage)).status
        == "error"
    )
    assert not later.get("files")
    assert query.call_count == 1


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("size,offload", [(100, True), (80_000, True), (80_001, False)])
def test_small_results_and_disabled_offloading_stay_inline(
    monkeypatch, async_mode, size, offload
):
    raw = "x" * size
    monkeypatch.setattr("arete.services.planning.list_planned", lambda **kw: raw)
    result = run(
        graph_for(call("list_planned", {}), AIMessage(content="Fin."), offload=offload),
        async_mode,
    )
    assert (
        next(m for m in result["messages"] if isinstance(m, ToolMessage)).content == raw
    )
    assert not result.get("files")


def test_large_error_still_emits_workout_card_and_error_status(monkeypatch):
    from arete.services import garmin_export

    session = {"id": 113, "revision": 1}
    state = {
        "state": "uncertain",
        "error": "Date Garmin absente",
        "details": "x" * 90_000,
    }
    reconcile = Mock(return_value=state)
    monkeypatch.setattr(garmin_export, "reconcile", reconcile)
    monkeypatch.setattr(
        garmin_export,
        "inspect_session",
        lambda *a, **k: {"session": session, "export": state},
    )
    graph = graph_for(
        call("reconcile_garmin_session", {"session_id": 113}), AIMessage(content="Fin.")
    )

    async def collect():
        return [
            part
            async for part in graph.astream(
                {"messages": [HumanMessage("Vérifie.")]},
                context=AgentContext(),
                config={"recursion_limit": 20},
                stream_mode=["custom", "values"],
            )
        ]

    parts = asyncio.run(collect())
    events = [data for mode, data in parts if mode == "custom"]
    result = [data for mode, data in parts if mode == "values"][-1]
    message = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert message.status == "error" and "/large_tool_results/result" in message.content
    assert next(e for e in events if e["type"] == "tool_end")["status"] == "error"
    card = next(e for e in events if e["type"] == "workout_update")
    assert card["session"] == session and card["export"] == state
    assert json.loads(result["files"]["/large_tool_results/result"]["content"])["error"]
    assert reconcile.call_count == 1


@pytest.mark.parametrize("async_mode", [False, True])
def test_native_summarization_preserves_raw_history_and_current_objective(async_mode):
    from deepagents.backends.utils import file_data_to_string

    from arete.agent.middlewares.summarization import ContextSummarizationMiddleware

    captured = []

    class Capture(Model):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            captured.append(messages)
            return super()._generate(
                messages, stop=stop, run_manager=run_manager, **kwargs
            )

    model = Capture(
        messages=iter(
            [
                AIMessage(content="Résumé des échanges précédents."),
                AIMessage(content="Réponse finale."),
            ]
        ),
        profile={"max_input_tokens": 12_000},
        disable_streaming=True,
    )
    filesystem = build_agent_filesystem()
    graph = build_agent(
        replace(
            get_profile("chat"),
            capabilities=(),
            personal_context=False,
            fact_memory_tools=False,
            journal_tools=False,
            page_context=False,
        ),
        model=model,
        context_tokens=12_000,
        output_tokens=4096,
        filesystem=filesystem,
        summarization=ContextSummarizationMiddleware(model, filesystem.backend),
    )
    history = [
        message
        for i in range(24)
        for message in (
            HumanMessage(f"question-{i}: " + "x" * 1000),
            AIMessage(f"réponse-{i}: " + "y" * 1000),
        )
    ]
    objective = HumanMessage(
        "Compare les deux dernières semaines sans modifier mon plan."
    )
    state = {"messages": [*history, objective]}
    kwargs = {"context": AgentContext(), "config": {"recursion_limit": 20}}
    result = (
        asyncio.run(graph.ainvoke(state, **kwargs))
        if async_mode
        else graph.invoke(state, **kwargs)
    )
    assert len(captured) == 2  # One native summary, then the answer.
    assert [m.content for m in result["messages"][:-1]] == [
        m.content for m in [*history, objective]
    ]
    assert captured[-1][-1].text.startswith(objective.text + "\n\n<server_datetime>")
    assert len(captured[-1]) < len(history)
    path = next(
        path for path in result["files"] if path.startswith("/conversation_history/")
    )
    assert path.startswith("/conversation_history/")
    archived = file_data_to_string(result["files"][path])
    assert "question-0:" in archived and "réponse-0:" in archived
    assert path in captured[-1][1].content


@pytest.mark.parametrize("async_mode", [False, True])
def test_native_human_eviction_preserves_content_in_default_backend(async_mode):
    text = "x" * 200_001  # Native 50,000-token threshold, four chars/token.
    graph = graph_for(AIMessage(content="Document reçu."))
    state = {"messages": [HumanMessage(text)]}
    kwargs = {"context": AgentContext(), "config": {"recursion_limit": 10}}
    result = (
        asyncio.run(graph.ainvoke(state, **kwargs))
        if async_mode
        else graph.invoke(state, **kwargs)
    )
    human = result["messages"][0]
    assert human.content == text
    path = human.additional_kwargs["lc_evicted_to"]
    assert path.startswith("/conversation_history/")
    assert result["files"][path]["content"] == text
