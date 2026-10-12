"""Exercise the real Decisions HTTP adapter and its invocation envelope offline."""

import asyncio
import json
import logging
from time import monotonic
from types import SimpleNamespace

import httpx
import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import SecretStr

from arete.agent.middlewares.fact_memory import FactMemoryMiddleware
from arete.agent.middlewares.limits import execution_limits
from arete.agent.middlewares.observability import ModelTelemetryMiddleware
from arete.agent.middlewares.policy import ProfilePolicyMiddleware
from arete.agent.models.jev import (
    JEV_MAX_REQUEST_BYTES,
    JEV_MODEL,
    JevClient,
    JevError,
)
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.execution import invoke_agent
from arete.agent.runtime.fact_memory import MAX_MEMORY_DECISIONS, classify_memory
from arete.dataio.db import db_connection
from arete.services import athlete_facts as facts

CHOICES = {"create": "New fact", "duplicate_1": "Equivalent to fact 1"}


def payload(choices=CHOICES):
    return {
        "model": JEV_MODEL,
        "answers": {
            "memory": {
                "type": "choice",
                "choice": "create",
                "confidence": 1.0,
                "probabilities": {
                    key: 1.0 if key == "create" else 0.0 for key in choices
                },
            }
        },
        "usage": {"input_tokens": 300, "output_tokens": 10, "cost": 0.0000126},
    }


def client(handler, timeout=1):
    return JevClient(
        api_key=SecretStr("test-secret"),
        model=JEV_MODEL,
        timeout=timeout,
        max_retries=0,
        transport=httpx.MockTransport(handler),
    )


def test_wire_contract_price_cap_and_no_chat_only_parameters():
    calls = []

    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://openrouter.ai/api/alpha/decisions"
        assert request.headers["authorization"] == "Bearer test-secret"
        body = json.loads(request.content)
        assert body["model"] == JEV_MODEL
        assert body["provider"]["max_price"] == {"prompt": 0.05, "completion": 0}
        assert not body["provider"]["allow_fallbacks"]
        assert "temperature" not in body and "max_tokens" not in body
        assert body["questions"]["memory"]["criteria"] == CHOICES
        return httpx.Response(200, json=payload())

    model = client(handler)
    result = asyncio.run(
        model.decide({"new_fact": "Matin"}, CHOICES, session_id="opaque")
    )
    assert result["usage"]["input_tokens"] == 300
    assert len(calls) == 1
    assert "test-secret" not in repr(model)


@pytest.mark.parametrize(
    "mutation", ["unknown", "missing", "nan", "sum", "choice", "type", "json"]
)
def test_malformed_decisions_are_errors(mutation):
    def handler(request):
        body = payload()
        answer = body["answers"]["memory"]
        if mutation == "unknown":
            answer["probabilities"]["delete_all"] = 0.0
        elif mutation == "missing":
            del answer["probabilities"]["duplicate_1"]
        elif mutation == "nan":
            return httpx.Response(
                200,
                content=b'{"answers":{"memory":{"type":"choice","choice":"create","confidence":1,"probabilities":{"create":NaN}}}}',
            )
        elif mutation == "sum":
            answer["probabilities"]["create"] = 0.5
        elif mutation == "choice":
            answer["choice"] = "duplicate_1"
        elif mutation == "type":
            answer["type"] = "noul"
        else:
            return httpx.Response(200, content=b"invalid")
        return httpx.Response(200, json=body)

    with pytest.raises(JevError):
        asyncio.run(client(handler).decide({}, CHOICES, session_id="test"))


@pytest.mark.parametrize("status", [302, 401, 402, 429, 500])
def test_http_failures_never_retry_or_follow_redirects(status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, headers={"location": "https://example.com"})

    with pytest.raises(JevError, match=f"HTTP {status}"):
        asyncio.run(client(handler).decide({}, CHOICES, session_id="test"))
    assert len(calls) == 1


def test_payload_bound_rejects_unicode_without_truncating_or_calling():
    def handler(request):
        raise AssertionError("Oversized request must not leave process")

    with pytest.raises(JevError, match="volumineux"):
        asyncio.run(
            client(handler).decide(
                {"text": "😀" * (JEV_MAX_REQUEST_BYTES // 4)},
                CHOICES,
                session_id="test",
            )
        )


def test_response_bound_and_total_deadline():
    with pytest.raises(JevError, match="volumineuse"):
        asyncio.run(
            client(lambda _: httpx.Response(200, content=b"x" * 17000)).decide(
                {}, CHOICES, session_id="test"
            )
        )

    async def slow(request):
        await asyncio.sleep(0.05)
        return httpx.Response(200, json=payload())

    with pytest.raises(JevError, match="délai"):
        asyncio.run(client(slow, timeout=0.01).decide({}, CHOICES, session_id="test"))


def test_concurrent_decisions_share_budget_and_count_successes_and_failures(caplog):
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    calls = []

    async def handler(request):
        calls.append(request)
        await asyncio.sleep(0)
        return httpx.Response(
            503 if len(calls) == MAX_MEMORY_DECISIONS else 200, json=payload()
        )

    context = AgentContext()
    context.memory_model = client(handler)

    async def run():
        return await asyncio.gather(
            *[
                classify_memory({}, CHOICES, context=context, completed_calls=1)
                for _ in range(MAX_MEMORY_DECISIONS + 2)
            ],
            return_exceptions=True,
        )

    results = asyncio.run(run())
    assert len(calls) == MAX_MEMORY_DECISIONS
    assert context.stats.model_calls == MAX_MEMORY_DECISIONS
    assert context.stats.memory_decision_calls == MAX_MEMORY_DECISIONS
    assert sum(isinstance(result, JevError) for result in results) >= 2
    assert "test-secret" not in caplog.text
    other = AgentContext()
    assert other.memory_calls == 0


def test_final_answer_reservation_and_expired_deadline_prevent_requests():
    context = AgentContext()
    context.memory_model = client(lambda _: pytest.fail("No request allowed"))
    with pytest.raises(JevError, match="Budget"):
        asyncio.run(classify_memory({}, CHOICES, context=context, completed_calls=23))
    context.deadline = monotonic() - 1
    with pytest.raises(JevError, match="Délai"):
        asyncio.run(classify_memory({}, CHOICES, context=context, completed_calls=1))
    assert context.stats.model_calls == 0


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def test_native_tool_jev_and_answer_share_accounting_and_source_context(caplog):
    caplog.set_level(logging.INFO, logger="arete.observability.agent")
    with db_connection() as con:
        con.execute("DELETE FROM app.athlete_facts")
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json=payload(
                json.loads(request.content)["questions"]["memory"]["criteria"]
            ),
        )

    facts.add_fact("preference", "Matin", evidence="explicit")
    graph = create_agent(
        Model(
            messages=iter(
                [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "remember_fact",
                                "id": "save",
                                "args": {
                                    "kind": "preference",
                                    "text": "Courir en forêt",
                                    "evidence": "explicit",
                                    "source_ref": "Je préfère la forêt",
                                },
                            }
                        ],
                    ),
                    AIMessage(content="C’est mémorisé."),
                ]
            )
        ),
        tools=[],
        middleware=[
            ProfilePolicyMiddleware("chat"),
            FactMemoryMiddleware(model=client(handler)),
            *execution_limits(),
            ModelTelemetryMiddleware(),
        ],
        context_schema=AgentContext,
    )
    context = AgentContext(thread_id="my-thread")
    try:
        result = asyncio.run(
            invoke_agent(
                graph,
                {"messages": [HumanMessage("Je préfère la forêt")]},
                context=context,
            )
        )
        receipt = json.loads(result["messages"][-2].content)
        assert receipt["action"] == "created"
        assert receipt["fact"]["source_ref"].startswith("chat:")
        assert context.stats.model_calls == 3  # main + Jev + answer
        assert context.memory_charged_calls == 1
        assert "memory_decision_calls=1" in caplog.text
        assert len(calls) == 1
    finally:
        with db_connection() as con:
            con.execute("DELETE FROM app.athlete_facts")


def test_classifier_charge_is_applied_once():
    context = AgentContext()
    context.memory_calls = 2
    middleware = FactMemoryMiddleware(model=None)
    runtime = SimpleNamespace(context=context)
    assert middleware.before_model({"run_model_call_count": 20}, runtime) == {
        "run_model_call_count": 22
    }
    assert middleware.before_model({"run_model_call_count": 22}, runtime) is None


def test_memory_calls_reduce_main_turns_and_preserve_final_answer():
    from langchain.agents.middleware import AgentMiddleware
    from langchain.tools import ToolRuntime
    from langchain_core.tools import tool

    from arete.agent.middlewares.context import ContextBuilderMiddleware
    from arete.agent.runtime.budget import MAX_MODEL_CALLS

    requests = []

    @tool
    async def check_memory(runtime: ToolRuntime) -> str:
        """Use the shared classifier budget until its own bound is reached."""
        context = runtime.context
        if context.memory_calls < MAX_MEMORY_DECISIONS:
            await classify_memory(
                {},
                CHOICES,
                context=context,
                completed_calls=runtime.state.get("run_model_call_count", 0),
            )
        return "checked"

    class Capture(AgentMiddleware):
        async def awrap_model_call(self, request, handler):
            requests.append(request)
            return await handler(request)

    main_calls = MAX_MODEL_CALLS - MAX_MEMORY_DECISIONS
    responses = [
        AIMessage(
            content="", tool_calls=[{"name": "check_memory", "args": {}, "id": str(i)}]
        )
        for i in range(main_calls - 1)
    ] + [AIMessage(content="Fin")]
    graph = create_agent(
        Model(messages=iter(responses * 2)),
        tools=[check_memory],
        middleware=[
            FactMemoryMiddleware(
                model=client(lambda _: httpx.Response(200, json=payload())),
            ),
            *execution_limits(),
            ContextBuilderMiddleware(),
            Capture(),
            ModelTelemetryMiddleware(),
        ],
        context_schema=AgentContext,
    )
    for _ in range(2):
        context = AgentContext()
        result = asyncio.run(
            invoke_agent(
                graph, {"messages": [HumanMessage("Continue")]}, context=context
            )
        )
        assert result["messages"][-1].text == "Fin"
        assert context.stats.model_calls == MAX_MODEL_CALLS
        assert context.memory_calls == MAX_MEMORY_DECISIONS
        assert requests[-1].tools == []
        assert "Dernier appel du budget" in requests[-1].system_message.text


def test_cancellation_is_counted_and_propagates():
    async def run():
        started = asyncio.Event()

        async def handler(request):
            started.set()
            await asyncio.sleep(5)
            return httpx.Response(200, json=payload())

        context = AgentContext()
        context.memory_model = client(handler, timeout=10)
        task = asyncio.create_task(
            classify_memory({}, CHOICES, context=context, completed_calls=1)
        )
        async with asyncio.timeout(2):
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert context.stats.memory_decision_calls == 1
        assert context.stats.model_calls == 1

    asyncio.run(run())
