"""One log line per run says what it cost: requests are the free tier's budget."""

import asyncio
import logging

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage

from arete.agent.capabilities.discovery import authorized_tools
from arete.agent.middlewares.capabilities import ToolkitMiddleware
from arete.agent.middlewares.context import ContextBuilderMiddleware
from arete.agent.middlewares.observability import ModelTelemetryMiddleware
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.execution import invoke_agent, stream_agent


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def _graph(*messages):
    return create_agent(
        Model(messages=iter(messages)),
        tools=authorized_tools("chat"),
        middleware=[
            ToolkitMiddleware(),
            ContextBuilderMiddleware(),
            ModelTelemetryMiddleware(),
        ],
        context_schema=AgentContext,
    )


def _search_then_answer():
    return _graph(
        AIMessage(
            content="",
            tool_calls=[{"name": "get_fitness", "args": {}, "id": "s"}],
        ),
        AIMessage(
            content="Ta forme remonte.",
            response_metadata={"model_name": "served/model:free"},
        ),
    )


def _run_lines(caplog):
    return [r.getMessage() for r in caplog.records if "Agent run:" in r.getMessage()]


def test_a_run_logs_its_model_and_tool_calls(caplog):
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    context = AgentContext()
    asyncio.run(
        invoke_agent(
            _search_then_answer(),
            {"messages": [HumanMessage("ma forme ?")]},
            context=context,
        )
    )
    (line,) = _run_lines(caplog)
    assert "profile=chat calls=2 tools=1" in line
    assert "models=['served/model:free']" in line
    assert "error=None" in line
    assert context.stats.first_result_ms is not None
    assert "first_result_ms=None" not in line


class Down(Model):
    def _generate(self, *args, **kwargs):
        raise ConnectionError("provider down")


def test_a_failed_run_still_logs_its_cost(caplog):
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    graph = create_agent(
        Down(messages=iter([])),
        tools=authorized_tools("chat"),
        middleware=[ModelTelemetryMiddleware()],
        context_schema=AgentContext,
    )
    with pytest.raises(ConnectionError):
        asyncio.run(
            invoke_agent(
                graph, {"messages": [HumanMessage("?")]}, context=AgentContext()
            )
        )
    (line,) = _run_lines(caplog)
    assert "calls=1" in line and "error=ConnectionError" in line
    assert "first_result_ms=None" in line


def test_streaming_records_the_time_to_the_first_answer_token(caplog):
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    context = AgentContext()

    async def consume():
        # The fake model cannot stream a tool call: a direct answer is enough.
        async for _ in stream_agent(
            _graph(AIMessage(content="Ta forme remonte.")),
            {"messages": [HumanMessage("ma forme ?")]},
            context=context,
        ):
            pass

    asyncio.run(consume())
    assert context.stats.first_token_ms is not None
    assert context.stats.first_result_ms is not None
    assert context.stats.first_result_ms >= context.stats.first_token_ms
    assert "ttft_ms=None" not in _run_lines(caplog)[0]


def test_a_streamed_model_name_is_not_repeated():
    from types import SimpleNamespace

    from arete.observability.agent import served_models

    name = "nvidia/nemotron-3-super-120b-a12b:free"
    message = SimpleNamespace(response_metadata={"model_name": name * 2})
    assert served_models(SimpleNamespace(result=[message])) == [name]
