"""Fallback retries only model boundaries and preserves completed operations."""

import asyncio
import logging
from dataclasses import replace

import pytest
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGenerationChunk

from arete.agent.capabilities.registry import CAPABILITIES
from arete.agent.factory import build_agent
from arete.agent.models.responses import (
    EmptyModelResponseError,
    TruncatedModelResponseError,
)
from arete.agent.profiles.catalog import get_profile
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.execution import invoke_agent, run_config, stream_agent
from arete.agent.runtime.streaming import StreamProjection


def reasoning_only():
    # Reproduce the exhausted completion from the October 10 document trace,
    # including metadata concatenated by the streaming provider adapter.
    return AIMessage(
        content="",
        response_metadata={
            "finish_reason": "lengthlength",
            "model_name": "reasonerreasoner",
        },
        usage_metadata={
            "input_tokens": 20228,
            "output_tokens": 4096,
            "total_tokens": 24324,
            "output_token_details": {"reasoning": 4096},
        },
    )


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        result = super()._generate(
            messages, stop=stop, run_manager=run_manager, **kwargs
        )
        if result.generations[0].message.content == "FAIL":
            raise ConnectionError("Provider unavailable")
        return result


def graph_for(primary, fallbacks, *, context_tokens=65536):
    return build_agent(
        replace(get_profile("chat"), journal_tools=False),
        model=Model(messages=iter(primary), disable_streaming=True),
        fallback_models=tuple(
            Model(messages=iter(items), disable_streaming=True) for items in fallbacks
        ),
        journal=AgentMiddleware(),
        context_tokens=context_tokens,
        output_tokens=4096,
    )


def run(graph, mode, context):
    state = {"messages": [HumanMessage("Effectue ma demande.")]}

    async def stream():
        projection = StreamProjection()
        async for part in stream_agent(graph, state, context=context):
            projection.events(part)
        return projection.done()["message"]["content"]

    if mode == "stream":
        return asyncio.run(stream())
    result = (
        asyncio.run(invoke_agent(graph, state, context=context))
        if mode == "async"
        else graph.invoke(state, context=context, config=run_config(context=context))
    )
    return result["messages"][-1].text


@pytest.mark.parametrize("mode", ["sync", "async", "stream"])
@pytest.mark.parametrize(
    "failure",
    [
        AIMessage(content="FAIL"),
        reasoning_only(),
        AIMessage(
            content="Je vais créer", response_metadata={"finish_reason": "lengthlength"}
        ),
    ],
)
def test_fallback_after_write_does_not_replay_tool_and_counts_attempts(
    monkeypatch, mode, failure
):
    writes = []
    writer = next(
        t for t in CAPABILITIES["planning"].tools if t.name == "create_planned_session"
    )
    monkeypatch.setattr(
        writer, "func", lambda **kwargs: writes.append(kwargs) or '{"id": 12}'
    )
    graph = graph_for(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "create_planned_session",
                        "args": {"date_str": "2099-01-01", "session_type": "tempo"},
                        "id": "write",
                    }
                ],
            ),
            failure,
        ],
        [[AIMessage(content="Séance créée.")]],
    )
    context = AgentContext()
    assert run(graph, mode, context) == "Séance créée."
    assert len(writes) == 1
    assert context.stats.model_calls == 3
    assert context.stats.tool_calls == 1


@pytest.mark.parametrize("mode", ["sync", "async", "stream"])
@pytest.mark.parametrize(
    "empty",
    [
        reasoning_only(),
        AIMessage(content=" \n", response_metadata={"finish_reason": "stop"}),
        AIMessage(content=[{"type": "reasoning", "reasoning": "Still thinking"}]),
    ],
)
def test_empty_completion_uses_next_candidate(mode, empty):
    graph = graph_for([empty], [[AIMessage(content="Voici la séance.")]])
    context = AgentContext()
    assert run(graph, mode, context) == "Voici la séance."
    assert context.stats.model_calls == 2
    assert context.stats.tool_calls == 0


@pytest.mark.parametrize("mode", ["sync", "async", "stream"])
@pytest.mark.parametrize("fallback_count", [0, 2])
def test_empty_candidates_fail_explicitly_and_retain_usage(
    mode, fallback_count, caplog
):
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    graph = graph_for(
        [reasoning_only()], [[reasoning_only()] for _ in range(fallback_count)]
    )
    context = AgentContext()
    with pytest.raises(EmptyModelResponseError, match="ni réponse ni appel"):
        run(graph, mode, context)
    assert context.stats.model_calls == 1 + fallback_count
    assert context.stats.served_models == ["reasoner"] * (1 + fallback_count)
    calls = [r.message for r in caplog.records if "Agent model call:" in r.message]
    assert len(calls) == 1 + fallback_count
    assert all("error=EmptyModelResponseError" in line for line in calls)
    assert all("'reasoning': 4096" in line for line in calls)


def test_reasoning_only_stream_falls_back_before_completing():
    class ReasoningStream(Model):
        def _stream(self, messages, stop=None, run_manager=None, **kwargs):
            empty = reasoning_only()
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    id="empty",
                    response_metadata=empty.response_metadata,
                    usage_metadata=empty.usage_metadata,
                )
            )

    graph = build_agent(
        replace(get_profile("chat"), journal_tools=False),
        model=ReasoningStream(messages=iter([])),
        fallback_models=(Model(messages=iter([AIMessage(content="Séance lue.")])),),
        journal=AgentMiddleware(),
        context_tokens=65536,
        output_tokens=4096,
    )
    context = AgentContext()
    assert run(graph, "stream", context) == "Séance lue."
    assert context.stats.model_calls == 2


@pytest.mark.parametrize("mode", ["sync", "async", "stream"])
def test_exhausted_fallbacks_propagate_last_error(mode):
    graph = graph_for(
        [AIMessage(content="FAIL")],
        [[AIMessage(content="FAIL")], [AIMessage(content="FAIL")]],
    )
    context = AgentContext()
    with pytest.raises(ConnectionError, match="Provider unavailable"):
        run(graph, mode, context)
    assert context.stats.model_calls == 3


def test_context_failure_does_not_call_any_candidate():
    graph = graph_for(
        [AIMessage(content="Unexpected")],
        [[AIMessage(content="Unexpected")]],
        context_tokens=8192,
    )
    context = AgentContext()
    with pytest.raises(ValueError, match="context|contexte|tokens"):
        graph.invoke(
            {"messages": [HumanMessage("large " * 30000)]},
            context=context,
            config=run_config(),
        )
    assert context.stats.model_calls == 0


def test_failed_partial_stream_does_not_pollute_the_final_answer():
    class Interrupted(Model):
        def _stream(self, messages, stop=None, run_manager=None, **kwargs):
            yield ChatGenerationChunk(
                message=AIMessageChunk(content="Réponse interrompue", id="failed")
            )
            raise ConnectionError("Stream interrupted")

    graph = build_agent(
        replace(get_profile("chat"), journal_tools=False),
        model=Interrupted(messages=iter([])),
        fallback_models=(
            Model(messages=iter([AIMessage(content="Réponse complète", id="success")])),
        ),
        journal=AgentMiddleware(),
        context_tokens=65536,
        output_tokens=4096,
    )
    context = AgentContext()
    assert run(graph, "stream", context) == "Réponse complète"
    assert context.stats.model_calls == 2


def test_cancellation_does_not_start_a_fallback():
    started = asyncio.Event()
    fallbacks = []

    class Cancelled(Model):
        async def _agenerate(self, messages, **kwargs):
            started.set()
            await asyncio.Event().wait()

    class Fallback(Model):
        def _generate(self, messages, *args, **kwargs):
            fallbacks.append(True)
            return super()._generate(messages, *args, **kwargs)

    graph = build_agent(
        replace(get_profile("chat"), journal_tools=False),
        model=Cancelled(messages=iter([]), disable_streaming=True),
        fallback_models=(Fallback(messages=iter([AIMessage(content="Unexpected")])),),
        journal=AgentMiddleware(),
        context_tokens=65536,
        output_tokens=4096,
    )

    async def cancel():
        async with asyncio.timeout(5):
            task = asyncio.create_task(
                invoke_agent(
                    graph,
                    {"messages": [HumanMessage("Vérifie.")]},
                    context=AgentContext(),
                )
            )
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(cancel())
    assert not fallbacks


@pytest.mark.parametrize("mode", ["sync", "async", "stream"])
def test_truncated_tool_call_is_not_executed_and_keeps_usage(monkeypatch, mode, caplog):
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    writer = next(
        t for t in CAPABILITIES["planning"].tools if t.name == "create_planned_session"
    )
    writes = []
    monkeypatch.setattr(writer, "func", lambda **kw: writes.append(kw))
    response = reasoning_only().model_copy(
        update={
            "content": "Je prépare",
            "tool_calls": [
                {
                    "name": "create_planned_session",
                    "args": {
                        "date_str": "2099-01-01",
                        "session_type": "tempo",
                    },
                    "id": "incomplete",
                    "type": "tool_call",
                }
            ],
        }
    )
    graph = graph_for([response], [])
    with pytest.raises(TruncatedModelResponseError, match="incomplète"):
        run(graph, mode, AgentContext())
    assert writes == []
    calls = [r.message for r in caplog.records if "Agent model call:" in r.message]
    assert len(calls) == 1
    assert "'reasoning': 4096" in calls[0]
