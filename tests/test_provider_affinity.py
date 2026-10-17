"""Inspect real SDK HTTP bodies across turns, fallback and concurrent runs."""

import asyncio
import hashlib
import json
from dataclasses import replace

import httpx2
import pytest
from agent_clock import CLOCK
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.runtime import Runtime

from arete.agent.factory import build_agent
from arete.agent.middlewares.provider_affinity import ProviderAffinityMiddleware
from arete.agent.models.registry import OPENROUTER_FREE_ONLY, OPENROUTER_GLM_FLASH
from arete.agent.profiles.catalog import get_profile
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.execution import invoke_agent, run_config, stream_agent
from arete.dataio.init_duckdb import main as init_schema
from arete.services.athlete_scope import athlete_scope
from arete.services.users import upsert_user


@pytest.fixture
def provider():
    bodies = []

    def respond(request):
        body = json.loads(request.content)
        bodies.append(body)
        if body["model"] == "unavailable":
            return httpx2.Response(503, json={"error": {"message": "Unavailable"}})
        message = {"role": "assistant", "content": "Planning consulté."}
        if not any(m["role"] == "tool" for m in body["messages"]):
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "read",
                        "type": "function",
                        "function": {
                            "name": "list_planned",
                            "arguments": "{}",
                        },
                    }
                ],
            }
        return httpx2.Response(
            200,
            json={
                "id": "completion",
                "object": "chat.completion",
                "created": 1,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": "tool_calls"
                        if "tool_calls" in message
                        else "stop",
                    }
                ],
            },
        )

    sync_client = httpx2.Client(transport=httpx2.MockTransport(respond))
    async_client = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))

    def model(name="glm", url="https://openrouter.ai/api/v1", paid=True):
        return ChatOpenAI(
            model=name,
            base_url=url,
            api_key="fake-key",
            temperature=0.3,
            max_completion_tokens=4096,
            timeout=60,
            max_retries=0,
            http_client=sync_client,
            http_async_client=async_client,
            disable_streaming=True,
            extra_body={
                "provider": OPENROUTER_GLM_FLASH if paid else OPENROUTER_FREE_ONLY,
                "reasoning": {"effort": "low"},
            }
            if url.startswith("https://openrouter.ai/")
            else None,
        )

    yield model, bodies
    sync_client.close()
    asyncio.run(async_client.aclose())


def graph(model, fallbacks=()):
    return build_agent(
        replace(get_profile("chat"), journal_tools=False, filesystem_tools=False),
        model=model,
        fallback_models=fallbacks,
        filesystem=AgentMiddleware(),
        context_tokens=65536,
        output_tokens=4096,
    )


@pytest.mark.parametrize("mode", ["sync", "async", "stream"])
def test_sdk_sends_stable_hash_and_keeps_caps_on_each_fallback_attempt(provider, mode):
    model, bodies = provider
    primary = model("unavailable", paid=False)
    fallback = model()
    agent = graph(primary, (fallback,))
    state = {"messages": [HumanMessage("Consulte mon planning.")]}

    async def stream(context):
        async for _ in stream_agent(agent, state, context=context):
            pass

    for _ in range(2):
        context = AgentContext(thread_id="stable-thread")
        if mode == "sync":
            agent.invoke(state, context=context, config=run_config(context=context))
        elif mode == "async":
            asyncio.run(invoke_agent(agent, state, context=context))
        else:
            asyncio.run(stream(context))
    keys = {body["session_id"] for body in bodies}
    assert len(keys) == 1
    assert keys == {
        hashlib.sha256(
            b'["arete-provider-affinity-v1",1,"chat","stable-thread"]'
        ).hexdigest()
    }
    assert {body["model"] for body in bodies} == {"unavailable", "glm"}
    assert any(any(m["role"] == "tool" for m in body["messages"]) for body in bodies)
    for body in bodies:
        assert "extra_body" not in body  # SDK flattened the wire body correctly.
        assert "tools" in body
        assert body["provider"]["sort"] == "latency"
        assert "order" not in body["provider"]
        assert body["provider"]["max_price"] == (
            {"prompt": 0, "completion": 0}
            if body["model"] == "unavailable"
            else {"prompt": 0.15, "completion": 0.5}
        )
        assert body["reasoning"] == {"effort": "low"}
    assert "session_id" not in primary.extra_body
    assert "session_id" not in fallback.extra_body


def test_concurrent_conversations_do_not_share_affinity(
    provider, tmp_path, monkeypatch
):
    # Live journal views require a provisioned athlete. A hard-coded id 2 only
    # worked when an earlier test happened to create it in the shared database.
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "affinity.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    init_schema()
    second = upsert_user("affinity-second", "affinity@example.test").athlete_id
    assert second is not None and second != 1
    conversations = ((1, "same"), (second, "same"), (1, "different"))
    model, bodies = provider
    agent = graph(model())

    async def run(athlete, thread):
        with athlete_scope(athlete):
            await invoke_agent(
                agent,
                {"messages": [HumanMessage("Lis le planning.")]},
                context=AgentContext(current_datetime=CLOCK, thread_id=thread),
            )

    async def concurrent():
        await asyncio.gather(
            *(run(athlete, thread) for athlete, thread in conversations)
        )

    asyncio.run(concurrent())
    assert len(bodies) == 6
    keys = [body["session_id"] for body in bodies]
    assert set(keys) == {
        hashlib.sha256(
            json.dumps(
                ["arete-provider-affinity-v1", athlete, "chat", thread],
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        for athlete, thread in conversations
    }
    assert all(keys.count(key) == 2 for key in keys)


def test_without_thread_affinity_is_per_run_and_missions_are_separate(provider):
    model, _ = provider
    shared = model()
    middleware = ProviderAffinityMiddleware()

    def prepare(context):
        request = ModelRequest(
            model=shared,
            messages=[],
            runtime=Runtime(context=context),
            model_settings={"extra_body": {"usage": {"include": True}}, "seed": 7},
        )
        updated = middleware._request(request)
        assert request.model_settings == {
            "extra_body": {"usage": {"include": True}},
            "seed": 7,
        }
        assert updated.model_settings["seed"] == 7
        assert updated.model_settings["extra_body"]["usage"] == {"include": True}
        return updated.model_settings["extra_body"]["session_id"]

    job = AgentContext(profile="briefing")
    assert prepare(job) == prepare(job)
    assert prepare(job) != prepare(AgentContext(profile="briefing"))
    assert prepare(AgentContext(thread_id="same")) != prepare(
        AgentContext(thread_id="same", profile="review")
    )


@pytest.mark.parametrize(
    "url", ["http://localhost:11434/v1", "https://models.inference.ai.azure.com"]
)
def test_other_providers_receive_no_openrouter_parameters(provider, url):
    model, bodies = provider
    agent = graph(model(url=url))
    asyncio.run(
        invoke_agent(
            agent,
            {"messages": [HumanMessage("Lis le planning.")]},
            context=AgentContext(thread_id="private-thread"),
        )
    )
    assert bodies
    for body in bodies:
        assert "session_id" not in body
        assert "provider" not in body
