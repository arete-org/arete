"""Context telemetry observes the native decision; it never adds model calls."""

import asyncio
from unittest.mock import patch

import pytest
from deepagents.backends import StateBackend
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.summarization import SummarizationMiddleware
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.messages.utils import count_tokens_approximately

from arete.agent.middlewares.summarization import ContextSummarizationMiddleware
from arete.agent.runtime.streaming import StreamProjection


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def make_graph(model):
    backend = StateBackend()
    middleware = ContextSummarizationMiddleware(model, backend)
    return create_agent(
        model,
        system_prompt="Instructions du coach.",
        middleware=[FilesystemMiddleware(backend=backend), middleware],
    )


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("compact", [False, True])
def test_exact_native_count_state_and_progress(async_mode, compact):
    model = Model(
        messages=iter([AIMessage("Résumé"), AIMessage("Réponse")]),
        profile={"max_input_tokens": 6000},
        disable_streaming=True,
    )
    graph = make_graph(model)
    history = [
        message
        for _ in range(20 if compact else 1)
        for message in (HumanMessage("q" * 1000), AIMessage("a" * 1000))
    ]
    state = {"messages": [*history, HumanMessage("Objectif courant")]}
    decisions = []
    original = SummarizationMiddleware._should_summarize

    def observe(self, messages, total):
        decisions.append(total)
        return original(self, messages, total)

    async def collect():
        return [
            part
            async for part in graph.astream(state, stream_mode=["custom", "values"])
        ]

    with patch.object(SummarizationMiddleware, "_should_summarize", observe):
        parts = (
            asyncio.run(collect())
            if async_mode
            else list(graph.stream(state, stream_mode=["custom", "values"]))
        )
    result = [data for mode, data in parts if mode == "values"][-1]
    assert result["context_window_usage"] == {
        "used_tokens": decisions[-1],
        "window_tokens": 6000,
    }
    assert decisions[-1] > count_tokens_approximately(state["messages"])
    events = [data for mode, data in parts if mode == "custom"]
    assert events == (
        [{"type": "context_compaction", "phase": phase} for phase in ("start", "done")]
        if compact
        else []
    )
    assert len(result["messages"]) == len(state["messages"]) + 1
    assert result["messages"][-1].content == ("Réponse" if compact else "Résumé")
    if compact:
        assert any(
            path.startswith("/conversation_history/") for path in result["files"]
        )


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("error", [RuntimeError, asyncio.CancelledError])
def test_compaction_always_finishes_progress_on_failure(async_mode, error):
    model = Model(messages=iter([]), profile={"max_input_tokens": 6000})
    middleware = ContextSummarizationMiddleware(model, StateBackend())
    events = []
    with (
        patch(
            "arete.agent.middlewares.summarization.get_stream_writer",
            return_value=events.append,
        ),
        patch.object(
            SummarizationMiddleware, "_create_summary", side_effect=error("failed")
        ),
        patch.object(
            SummarizationMiddleware, "_acreate_summary", side_effect=error("failed")
        ),
        pytest.raises(error),
    ):
        if async_mode:
            asyncio.run(middleware._acreate_summary([HumanMessage("q")]))
        else:
            middleware._create_summary([HumanMessage("q")])
    assert [event["phase"] for event in events] == ["start", "done"]


def test_cached_graph_keeps_concurrent_measurements_local():
    async def run():
        barrier = asyncio.Barrier(2)
        measured = {}

        class ConcurrentModel(Model):
            async def _agenerate(self, messages, **kwargs):
                measured[messages[-1].content] = count_tokens_approximately(
                    messages, tools=[]
                )
                await asyncio.wait_for(barrier.wait(), timeout=3)
                return self._generate(messages)

        model = ConcurrentModel(
            messages=iter([AIMessage("A"), AIMessage("B")]),
            profile={"max_input_tokens": 6000},
            disable_streaming=True,
        )
        graph = create_agent(
            model,
            system_prompt="System",
            middleware=[ContextSummarizationMiddleware(model, StateBackend())],
        )
        prompts = ["a", "b" * 1000]
        results = await asyncio.gather(
            *(graph.ainvoke({"messages": [HumanMessage(text)]}) for text in prompts)
        )
        assert [r["context_window_usage"]["used_tokens"] for r in results] == [
            measured[p] for p in prompts
        ]

    asyncio.run(run())


def test_values_projection_exposes_only_counters_and_deduplicates():
    stream = StreamProjection()
    usage = {"used_tokens": 900, "window_tokens": 1000}
    part = {
        "type": "values",
        "data": {
            "context_window_usage": usage,
            "files": {"private": "secret"},
            "messages": ["private"],
        },
    }
    assert stream.events(part) == [{"type": "values", "context_window_usage": usage}]
    assert stream.events(part) == []
    assert stream.events({"type": "values", "data": {}}) == []


@pytest.mark.parametrize("used,window", [(-1, 100), (True, 100), (1, 0), (1, "100")])
def test_values_projection_rejects_bad_counters(used, window):
    with pytest.raises(ValueError, match="contexte"):
        StreamProjection().events(
            {
                "type": "values",
                "data": {
                    "context_window_usage": {
                        "used_tokens": used,
                        "window_tokens": window,
                    }
                },
            }
        )
