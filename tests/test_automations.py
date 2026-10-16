"""Scheduling and native durable HITL contracts, without provider/network I/O."""

from datetime import UTC, datetime, timedelta

import pytest

from arete.dataio.automation_schema import TABLES
from arete.dataio.db import db_connection
from arete.services import automations as service
from arete.services.athlete_scope import athlete_scope
from arete.services.automation_schedule import AutomationInput, next_due


@pytest.fixture(autouse=True)
def clean_automations():
    with db_connection() as con:
        con.execute(
            "UPDATE app.automation_worker_slots SET run_id=NULL,lease_until=NULL"
        )
        for table in TABLES:
            con.execute(f"DELETE FROM app.{table}")
    yield


def spec(trigger=None):
    return AutomationInput(
        title="Bilan",
        mission="Examiner la récupération",
        timezone="Europe/Paris",
        trigger=trigger or {"kind": "daily", "time": "08:00"},
    )


def started():
    now = datetime.now(UTC)
    item = service.create(
        spec({"kind": "once", "at": now - timedelta(minutes=1)}),
        activate=True,
        now=now - timedelta(minutes=2),
    )
    service.prepare(now)
    run = service.runs(item["id"])["items"][0]
    return service.claim(run["id"], now)


def test_dst_and_missed_occurrences():
    spring = spec({"kind": "daily", "time": "02:30"})
    assert next_due(spring, datetime(2026, 3, 28, 12, tzinfo=UTC)) == datetime(
        2026, 3, 29, 1, 30, tzinfo=UTC
    )
    fall = datetime(2026, 10, 25, 0, 30, tzinfo=UTC)
    assert next_due(spring, datetime(2026, 10, 24, 12, tzinfo=UTC)) == fall
    assert next_due(spring, fall) == datetime(2026, 10, 26, 1, 30, tzinfo=UTC)
    item = service.create(spec(), activate=True, now=datetime(2026, 1, 1, tzinfo=UTC))
    service.prepare(datetime(2026, 1, 4, 9, tzinfo=UTC))
    records = service.runs(item["id"])["items"]
    assert [r["state"] for r in records] == ["queued", "missed", "missed", "missed"]
    service.prepare(datetime(2026, 1, 4, 10, tzinfo=UTC))
    assert len(service.runs(item["id"])["items"]) == 4


def test_claim_revision_scope_suspend_and_abandoned():
    run = started()
    assert run and service.claim(run["id"]) is None
    with athlete_scope(999), pytest.raises(LookupError):
        service.run_detail(run["id"])
    service.prepare(datetime.now(UTC) + timedelta(minutes=4))
    assert service.run_detail(run["id"])["state"] == "interrupted"
    assert service.claim(run["id"]) is None
    item = service.get(run["automation_id"])
    service.set_state(item["id"], item["revision"], "paused")
    with pytest.raises(service.Conflict):
        service.set_state(item["id"], item["revision"], "active")


def test_budgets_survive_segments_and_unknown_effect_never_replays():
    from arete.services import automation_execution as execution

    run = started()
    for _ in range(8):
        execution.charge(run["id"], "model_turns")
    with pytest.raises(RuntimeError, match="Budget"):
        execution.charge(run["id"], "model_turns")
    call = {"name": "save_workout", "args": {"text": "Squat"}, "id": "effect-1"}
    execution.propose(run["id"], call)
    assert execution.begin_effect(run["id"], call) is None
    with pytest.raises(service.Conflict, match="incertaine"):
        execution.begin_effect(run["id"], call)


def test_decision_validation_double_click_and_expiry(monkeypatch):
    from arete.services import automation_execution as execution

    monkeypatch.setattr("arete.services.inbox.publish", lambda *args: None)
    run = started()
    interruption = {
        "id": "question",
        "value": {
            "name": "ask_athlete",
            "tool_call_id": "q",
            "args": {"question": "Fatigue ?"},
        },
        "schema": {
            "type": "object",
            "properties": {
                "type": {"const": "respond"},
                "message": {"type": "string", "minLength": 1},
            },
            "required": ["type", "message"],
            "additionalProperties": False,
        },
    }
    execution.finish(run["id"], seconds=1, interrupts=[interruption])
    with pytest.raises(ValueError, match="invalide"):
        service.decide(run["id"], "question", 1, {"type": "approve"})
    decision = {"type": "respond", "message": "Bonne récupération"}
    service.decide(run["id"], "question", 1, decision)
    service.decide(run["id"], "question", 1, decision)
    with pytest.raises(service.Conflict):
        service.decide(
            run["id"], "question", 1, {"type": "respond", "message": "Autre"}
        )
    resumed = service.claim(run["id"])
    assert resumed["resumes"] == 1 and resumed["active_seconds"] == 1


@pytest.mark.anyio
async def test_native_per_call_interrupts_resume_after_new_saver(monkeypatch):
    from langchain.agents import create_agent
    from langchain.agents.middleware import HumanInTheLoopMiddleware
    from langchain_core.language_models.fake_chat_models import (
        FakeMessagesListChatModel,
    )
    from langchain_core.messages import AIMessage
    from langchain_core.tools import tool
    from langgraph.types import Command

    from arete.agent.runtime.checkpoints import AutomationSaver

    class Model(FakeMessagesListChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    called = []

    @tool
    def write(value: int) -> str:
        """A side effect that must wait for independent approval."""
        called.append(value)
        return str(value)

    def graph():
        model = Model(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "write", "args": {"value": 1}, "id": "one"},
                        {"name": "write", "args": {"value": 2}, "id": "two"},
                    ],
                ),
                AIMessage(content="Terminé"),
            ]
        )
        return create_agent(
            model,
            tools=[write],
            middleware=[
                HumanInTheLoopMiddleware(
                    interrupt_on={"write": True}, interrupt_mode="per_call"
                )
            ],
            checkpointer=AutomationSaver(),
        )

    run = started()
    cfg = {"configurable": {"thread_id": run["id"]}}
    first = graph()
    await first.ainvoke({"messages": [{"role": "user", "content": "Tester"}]}, cfg)
    state = await first.aget_state(cfg)
    interrupts = [i for task in state.tasks for i in task.interrupts]
    assert len(interrupts) == 2 and called == []
    second = graph()
    await second.ainvoke(Command(resume={interrupts[0].id: {"type": "approve"}}), cfg)
    assert called == [1]
    third = graph()
    # Stop on the second pending task without rerunning the completed sibling.
    await third.ainvoke(
        Command(resume={interrupts[1].id: {"type": "reject", "message": "Non"}}), cfg
    )
    assert called == [1]


@pytest.fixture
def anyio_backend():
    return "asyncio"
