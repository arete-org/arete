"""Durable human pauses survive a new saver and never replay an effect."""

import json
from unittest.mock import patch

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langgraph.types import Command

from arete.agent.middlewares.human_input import (
    ChatBudgetMiddleware,
    ChatEffectsMiddleware,
    ChatRequestBudgetMiddleware,
    HumanQuestionMiddleware,
    chat_hitl,
)
from arete.agent.runtime.checkpoints import AutomationSaver
from arete.agent.runtime.context import AgentContext
from arete.agent.tools.automations import ask_athlete
from arete.services import coaching_runs as runs
from arete.services.automations import Conflict
from arete.services.human_input import QuestionField, response_model


@pytest.fixture(autouse=True)
def clear_chat_executions():
    from arete.dataio.db import db_connection
    from arete.dataio.run_schema import TABLES

    with db_connection() as con:
        for table in TABLES:
            con.execute(f"DELETE FROM app.{table}")


class Model(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def test_interactive_chat_graph_marks_middleware_tools_reviewable():
    # The production chat graph: a checkpointer makes build_agent interactive.
    # Tool-less middlewares must compile, and middleware-provided tools
    # (the filesystem's delete) carry the review flag like bound tools.
    from arete.agent.factory import build_agent
    from arete.agent.profiles.catalog import get_profile
    from arete.coaching import build_agent_filesystem

    graph = build_agent(
        get_profile("chat"),
        model=Model(responses=[]),
        context_tokens=65536,
        output_tokens=4096,
        filesystem=build_agent_filesystem(),
        checkpointer=AutomationSaver(family="chat"),
    )

    tools = graph.nodes["tools"].bound.tools_by_name
    for name in ("delete", "delete_planned_session"):
        assert "requires_review" in tools[name].get_input_schema().model_fields


def test_question_types_are_validated():
    model = response_model(
        [
            QuestionField(
                key="rpe", label="Ressenti", kind="number", minimum=0, maximum=10
            ),
            QuestionField(key="day", label="Date", kind="date"),
        ]
    )
    with pytest.raises(ValueError):
        model.model_validate({"rpe": 11, "day": "2026-10-23"})
    with pytest.raises(ValueError):
        model.model_validate({"rpe": 5, "day": "bad"})
    assert model.model_validate({"rpe": 5, "day": "2026-10-23"}).rpe == 5


@pytest.mark.anyio
async def test_question_resumes_after_reloading_saver():
    from langchain.agents.middleware import AgentMiddleware

    from arete.agent.middlewares.fact_memory import FactMemoryMiddleware
    from arete.agent.middlewares.policy import ProfilePolicyMiddleware
    from arete.agent.profiles.catalog import get_profile

    profile = get_profile("chat")
    calendar = object()
    memory_model = object()

    class CheckDependencies(AgentMiddleware):
        async def awrap_tool_call(self, request, handler):
            assert request.runtime.context.resolved_profile is profile
            assert request.runtime.context.calendar is calendar
            assert request.runtime.context.memory_model is memory_model
            assert request.runtime.context.memory_source_message == "Débrief"
            return await handler(request)

    identifier = runs.create("thread-a", {})
    from arete.agent.runtime.context import read_athlete_clock

    context = AgentContext(
        execution_id=identifier,
        thread_id="thread-a",
        account_id="verified-account",
        current_datetime=await read_athlete_clock(),
    )
    model = Model(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "q",
                        "name": "ask_athlete",
                        "args": {
                            "question": "Quel ressenti ?",
                            "fields": [
                                {
                                    "key": "rpe",
                                    "label": "Ressenti",
                                    "kind": "number",
                                    "minimum": 0,
                                    "maximum": 10,
                                }
                            ],
                        },
                    }
                ],
            ),
            AIMessage(content="Merci"),
        ]
    )

    def graph():
        return create_agent(
            model,
            tools=[ask_athlete],
            context_schema=AgentContext,
            checkpointer=AutomationSaver(family="chat"),
            middleware=[
                ProfilePolicyMiddleware(
                    "chat", profile=profile, calendar=lambda account: calendar
                ),
                FactMemoryMiddleware(model=memory_model),
                CheckDependencies(),
                ChatBudgetMiddleware(),
                ChatRequestBudgetMiddleware(),
                chat_hitl(),
                HumanQuestionMiddleware(),
                ChatEffectsMiddleware(),
            ],
        )

    cfg = {"configurable": {"thread_id": identifier}}
    first = graph()
    await first.ainvoke(
        {"messages": [{"role": "user", "content": "Débrief"}]}, cfg, context=context
    )
    saved = await first.aget_state(cfg)
    interrupts = list(saved.interrupts)
    assert len(interrupts) == 1
    item = interrupts[0]
    runs.finish(
        identifier,
        1,
        [{"id": item.id, "value": item.value, "schema": item.response_schema}],
    )
    with pytest.raises(Exception, match="greater than|maximum"):
        runs.decide(identifier, item.id, 1, {"rpe": 11})
    runs.decide(identifier, item.id, 1, {"rpe": 6})
    runs.decide(identifier, item.id, 1, {"rpe": 6})
    with pytest.raises(Conflict):
        runs.decide(identifier, item.id, 1, {"rpe": 7})
    runs.claim(identifier)
    with pytest.raises(Conflict):
        runs.claim(identifier)
    second = graph()
    context = AgentContext(
        execution_id=identifier,
        thread_id="thread-a",
        account_id="verified-account",
        current_datetime=await read_athlete_clock(),
    )
    result = await second.ainvoke(
        Command(resume={item.id: {"rpe": 6}}), cfg, context=context
    )
    assert result["messages"][-1].text == "Merci"
    assert runs.get(identifier)["model_turns"] == 2
    assert runs.get(identifier)["tool_calls"] == 1
    assert runs.finish(identifier, 1) == "completed"
    assert (await second.aget_state(cfg)).values == {}


def test_uncertain_write_is_not_replayed():
    identifier = runs.create("thread-b", {})
    call = {"id": "w", "name": "save_workout", "args": {}}
    runs.prepare_call(identifier, call, write=True)
    assert runs.begin_effect(identifier, call) is None
    with pytest.raises(Conflict, match="incertain"):
        runs.begin_effect(identifier, call)
    assert runs.finish(identifier, 1) == "failed"


def test_interactive_http_question(client):
    model = Model(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "q",
                        "name": "ask_athlete",
                        "args": {
                            "question": "Prêt ?",
                            "fields": [
                                {"key": "ready", "label": "Prêt", "kind": "boolean"}
                            ],
                        },
                    }
                ],
            ),
            AIMessage(content="Merci"),
        ]
    )
    graph = create_agent(
        model,
        tools=[ask_athlete],
        context_schema=AgentContext,
        checkpointer=AutomationSaver(family="chat"),
        middleware=[
            ChatBudgetMiddleware(),
            ChatRequestBudgetMiddleware(),
            chat_hitl(),
            HumanQuestionMiddleware(),
            ChatEffectsMiddleware(),
        ],
    )
    with patch("arete.api.agent._interactive_graph", return_value=graph):
        response = client.post(
            "/agent/chat/stream",
            json={
                "thread_id": "00000000-0000-0000-0000-000000000067",
                "stream_version": 2,
                "messages": [{"role": "user", "content": "Salut"}],
            },
        )
        events = [
            json.loads(line[6:])
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]
        assert events[-1]["type"] == "run_status", events
        assert events[-1]["state"] == "waiting", events
        identifier = events[-1]["run_id"]
        item = next(e["interrupt"] for e in events if e["type"] == "interrupt")
        before = model.i
        observed = client.get(f"/agent/runs/{identifier}/events")
        assert observed.status_code == 200 and "snapshot" in observed.text
        assert model.i == before
        assert "Salut" not in observed.text
        assert (
            client.post(
                f"/agent/runs/{identifier}/interrupts/{item['id']}",
                json={"revision": item["revision"], "decision": {"ready": True}},
            ).status_code
            == 200
        )
        resumed = client.post(f"/agent/runs/{identifier}/resume")
        assert "Merci" in resumed.text, resumed.text
        assert client.get(f"/agent/runs/{identifier}").json()["state"] == "completed"


@pytest.mark.anyio
async def test_review_edited_arguments_execute_once():
    from langchain_core.tools import tool

    from arete.agent.middlewares.human_input import reviewable
    from arete.agent.runtime.context import read_athlete_clock

    calls = []

    @tool
    def delete_automation(automation_id: int) -> str:
        """Delete an automation."""
        calls.append(automation_id)
        return "removed"

    identifier = runs.create("review-thread", {})
    context = AgentContext(
        execution_id=identifier,
        thread_id="review-thread",
        current_datetime=await read_athlete_clock(),
    )
    model = Model(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "delete",
                        "name": "delete_automation",
                        "args": {"automation_id": 42, "requires_review": True},
                    }
                ],
            ),
            AIMessage(content="Terminé"),
        ]
    )
    graph = create_agent(
        model,
        tools=[reviewable(delete_automation)],
        context_schema=AgentContext,
        checkpointer=AutomationSaver(family="chat"),
        middleware=[
            ChatBudgetMiddleware(),
            ChatRequestBudgetMiddleware(),
            chat_hitl(),
            ChatEffectsMiddleware(),
        ],
    )
    cfg = {"configurable": {"thread_id": identifier}}
    # Baselines are separately covered by domain revision tests.
    with patch("arete.services.automation_execution._snapshot", return_value={}):
        output = await graph.ainvoke(
            {"messages": [{"role": "user", "content": "Suggestion"}]},
            cfg,
            context=context,
        )
        assert not calls
        item = output["__interrupt__"][0]
        runs.finish(
            identifier,
            1,
            [{"id": item.id, "value": item.value, "schema": item.response_schema}],
        )
        from jsonschema import ValidationError

        with pytest.raises(ValidationError):
            runs.decide(
                identifier,
                item.id,
                1,
                {
                    "type": "edit",
                    "edited_action": {
                        "name": "another_tool",
                        "args": {"automation_id": 43},
                    },
                },
            )
        decision = {
            "type": "edit",
            "edited_action": {
                "name": "delete_automation",
                "args": {"automation_id": 43},
            },
        }
        runs.decide(identifier, item.id, 1, decision)
        runs.claim(identifier)
        output = await graph.ainvoke(
            Command(resume={item.id: decision}), cfg, context=context
        )
        assert calls == [43], output
        receipt = runs.begin_effect(
            identifier,
            {
                "name": "delete_automation",
                "args": {"automation_id": 43},
                "id": "delete",
                "type": "tool_call",
            },
        )
        assert "removed" in receipt
        assert calls == [43]


def test_public_stream_fixture_matches_python_schema():
    from pathlib import Path

    from arete.api.agent_protocol import EVENT

    fixture = json.loads(
        (Path(__file__).parent / "data/agent-stream-v2.json").read_text()
    )
    for event in fixture:
        EVENT.validate_python(event)
    with pytest.raises(ValueError):
        EVENT.validate_python(
            {**fixture[0], "messages": [{"role": "system", "content": "private"}]}
        )


def test_chat_quota_expiry_and_owner_are_enforced():
    from arete.dataio.db import db_connection

    identifiers = [runs.create(f"thread-{i}", {}) for i in range(runs.MAX_WAITING_RUNS)]
    with pytest.raises(Conflict):
        runs.create("overflow", {})
    with pytest.raises(Conflict):
        runs.create("thread-0", {})
    from arete.services.athlete_scope import athlete_scope

    with athlete_scope(999), pytest.raises(LookupError):
        runs.get(identifiers[0])
    runs.cancel(identifiers[0])
    runs.create("replacement", {})
    with db_connection() as con:
        con.execute(
            "UPDATE app.chat_runs SET state='waiting',expires_at=now()-INTERVAL 1 SECOND WHERE id=?",
            [identifiers[1]],
        )
    runs.cleanup()
    assert runs.get(identifiers[1])["state"] == "expired"
    with pytest.raises(Conflict):
        runs.claim(identifiers[1])


@pytest.mark.anyio
async def test_activity_snapshot_writes_are_throttled_and_terminal_is_immediate(
    monkeypatch,
):
    from arete.agent.runtime.activity import RunRecorder

    writes = []
    monkeypatch.setattr(runs, "publish", lambda *args: writes.append(args))
    monkeypatch.setattr("arete.agent.runtime.activity.monotonic", lambda: 10)
    recorder = RunRecorder("run", "chat", "thread")
    for _ in range(500):
        await recorder.record({"type": "token", "id": "m", "text": "a"})
    assert len(writes) == 1
    await recorder.record({"type": "run_status", "state": "completed"})
    assert len(writes) == 2
    assert writes[-1][3]["events"][0]["text"] == "a" * 500


@pytest.mark.anyio
async def test_generation_success_does_not_invent_a_persistence_success():
    from anyio import to_thread

    from arete.agent.runtime.generation import observed
    from arete.coaching import _run_mission

    graph = create_agent(
        Model(responses=[AIMessage(content="Texte provisoire")]),
        context_schema=AgentContext,
    )

    @observed("briefing")
    def owner():
        assert _run_mission(graph, "briefing", "Facts", 100) == "Texte provisoire"
        assert runs.latest("briefing", "current")["state"] == "running"
        raise OSError("save failed")

    with pytest.raises(OSError, match="save failed"):
        await to_thread.run_sync(owner)
    snapshot = runs.latest("briefing", "current")
    assert snapshot["state"] == "failed"
    assert not any(
        e.get("label") == "Résultat enregistré"
        for e in snapshot["projection"]["events"]
    )


@pytest.mark.anyio
async def test_rules_fallback_replaces_provisional_feedback():
    from types import SimpleNamespace

    from arete.agent.runtime.generation import current_generation, observed

    @observed("feedback", lambda: "actual:42")
    def owner():
        recorder = current_generation()
        recorder.record_sync(
            {"type": "message", "id": "partial", "text": "Unfinished speculation"}
        )
        return SimpleNamespace(
            feedback="Feedback confirmed from metrics", source="rules"
        )

    owner()
    snapshot = runs.latest("feedback", "actual:42")
    assert snapshot["state"] == "completed"
    texts = [
        event["text"]
        for event in snapshot["projection"]["events"]
        if event["type"] == "message"
    ]
    assert texts == ["Feedback confirmed from metrics"]


@pytest.mark.anyio
async def test_current_generation_observer_waits_past_previous_result(monkeypatch):
    from unittest.mock import AsyncMock

    from arete.api import agent_runs

    snapshots = iter(
        [
            {"id": "yesterday", "revision": 2, "state": "completed"},
            {"id": "today", "revision": 1, "state": "running"},
            {"id": "today", "revision": 2, "state": "completed"},
        ]
    )
    monkeypatch.setattr(runs, "latest", lambda *_: next(snapshots))
    monkeypatch.setattr(agent_runs.asyncio, "sleep", AsyncMock())
    request = AsyncMock()
    request.is_disconnected.return_value = False
    response = await agent_runs.observe_generation(request, "briefing", "current")
    frames = [
        json.loads(frame.removeprefix("data: "))
        async for frame in response.body_iterator
    ]
    assert [(frame["id"], frame["state"]) for frame in frames] == [
        ("yesterday", "completed"),
        ("today", "running"),
        ("today", "completed"),
    ]


def test_two_tabs_cannot_claim_the_same_resume():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from arete.services.athlete_scope import athlete_scope

    identifier = runs.create("two-tabs", {})
    runs.finish(
        identifier,
        1,
        [
            {
                "id": "question",
                "value": {"tool_call_id": "q"},
                "schema": {"type": "object"},
            }
        ],
    )
    runs.decide(identifier, "question", 1, {})
    barrier = Barrier(2, timeout=5)

    def claim():
        with athlete_scope(1):
            barrier.wait()
            try:
                return runs.claim(identifier)
            except Conflict:
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(claim) for _ in range(2)]
        outcomes = [future.result(timeout=10) for future in futures]
    assert sum(outcome is not None for outcome in outcomes) == 1
    assert runs.get(identifier)["resumes"] == 1
