"""Retry safety and error status through the production middleware composition."""

import asyncio
import json
from dataclasses import replace
from unittest.mock import Mock

import pytest
from agent_clock import CLOCK
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command
from requests.exceptions import Timeout as RequestsTimeout

from arete.agent.factory import build_agent
from arete.agent.profiles.catalog import get_profile
from arete.agent.runtime.budget import MAX_TOOL_CALLS
from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.events import enforce_tool_status
from arete.agent.runtime.execution import invoke_agent, run_config, stream_agent
from arete.services import garmin_export


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def graph_for(name, args):
    return build_agent(
        replace(get_profile("chat"), journal_tools=False, filesystem_tools=False),
        model=Model(
            disable_streaming=True,
            messages=iter(
                [
                    AIMessage(
                        content="",
                        tool_calls=[{"name": name, "args": args, "id": "call"}],
                    ),
                    AIMessage(content="Fin."),
                ]
            ),
        ),
        context_tokens=65536,
        output_tokens=4096,
        filesystem=AgentMiddleware(),
    )


def run(graph, async_mode, context=None):
    context = context or AgentContext()
    state = {"messages": [HumanMessage("Vérifie.")]}
    if async_mode:
        return asyncio.run(invoke_agent(graph, state, context=context))
    return graph.invoke(state, context=context, config=run_config(context=context))


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize("exhausted", [False, True])
@pytest.mark.parametrize("failure", [ConnectionError, RequestsTimeout])
def test_transient_read_retries_once_without_extra_model_call(
    monkeypatch, async_mode, exhausted, failure
):
    devices = Mock(
        side_effect=[
            failure("offline"),
            TimeoutError("still offline") if exhausted else [],
        ]
    )
    monkeypatch.setattr(garmin_export, "devices", devices)
    context = AgentContext()
    result = run(graph_for("list_garmin_devices", {}), async_mode, context)
    message = next(m for m in result["messages"] if m.type == "tool")
    assert devices.call_count == context.stats.tool_calls == 2
    assert context.stats.model_calls == 2
    assert message.status == ("error" if exhausted else "success")
    if exhausted:
        assert "still offline" in message.content
    else:
        assert json.loads(message.content) == []


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.parametrize(
    "name,args",
    [
        ("get_workload", {"days": 5}),
        ("list_planned", {"start_date": "invalid"}),
        (
            "create_planned_session",
            {"date_str": "invalid", "session_type": "endurance"},
        ),
    ],
)
def test_domain_and_static_tool_errors_are_visible_to_model(async_mode, name, args):
    context = AgentContext()
    result = run(graph_for(name, args), async_mode, context)
    message = next(m for m in result["messages"] if m.type == "tool")
    assert message.status == "error"
    assert json.loads(message.content)["error"]
    assert context.stats.tool_calls == 1


def _planned_on(monkeypatch, day):
    monkeypatch.setattr(
        garmin_export,
        "inspect_session",
        lambda session_id, include_steps=True: {"session": {"date": day}},
    )


@pytest.mark.parametrize("async_mode", [False, True])
def test_partial_garmin_write_is_not_replayed_or_discarded(monkeypatch, async_mode):
    _planned_on(monkeypatch, "2999-01-01")
    payload = {
        "results": [{"session_id": 113, "state": "uncertain"}],
        "blocked": 113,
        "error": "Réponse perdue",
        "not_attempted": [114],
    }
    export = Mock(return_value=payload)
    monkeypatch.setattr(garmin_export, "export_batch", export)
    result = run(
        graph_for("export_garmin_sessions", {"session_ids": [113, 114]}), async_mode
    )
    message = next(m for m in result["messages"] if m.type == "tool")
    assert message.status == "error"
    assert json.loads(message.content) == payload
    assert export.call_count == 1


@pytest.mark.parametrize("async_mode", [False, True])
def test_unhandled_write_timeout_is_never_replayed(monkeypatch, async_mode):
    from arete.agent.tools.garmin import export_garmin_sessions

    write = Mock(side_effect=TimeoutError("committed remotely"))

    def fail(session_ids, runtime, device_id=None):
        return write(session_ids)

    monkeypatch.setattr(export_garmin_sessions, "func", fail)
    with pytest.raises(TimeoutError, match="committed remotely"):
        run(graph_for("export_garmin_sessions", {"session_ids": [113]}), async_mode)
    assert write.call_count == 1


@pytest.mark.parametrize("async_mode", [False, True])
def test_retry_cannot_exceed_execution_budget(monkeypatch, async_mode):
    devices = Mock(side_effect=ConnectionError("offline"))
    monkeypatch.setattr(garmin_export, "devices", devices)
    context = AgentContext()
    context.stats.tool_calls = MAX_TOOL_CALLS - 1
    with pytest.raises(ToolCallLimitExceededError):
        run(graph_for("list_garmin_devices", {}), async_mode, context)
    assert devices.call_count == 1
    assert context.stats.tool_calls == MAX_TOOL_CALLS


def test_reconciliation_error_keeps_card_and_emits_failed_tool_event(monkeypatch):
    state = {"state": "uncertain", "error": "Date Garmin absente"}
    view = {"session": {"id": 113, "revision": 1}, "export": state}
    reconcile = Mock(return_value=state)
    monkeypatch.setattr(garmin_export, "reconcile", reconcile)
    monkeypatch.setattr(garmin_export, "inspect_session", lambda *a, **k: dict(view))

    async def collect():
        from arete.agent.runtime.streaming import StreamProjection

        projection = StreamProjection()
        events = []
        async for part in stream_agent(
            graph_for("reconcile_garmin_session", {"session_id": 113}),
            {"messages": [HumanMessage("Vérifie.")]},
            context=AgentContext(current_datetime=CLOCK),
        ):
            events.extend(projection.events(part))
        return events

    events = asyncio.run(collect())
    assert reconcile.call_count == 1
    assert next(e for e in events if e["type"] == "tool_end")["status"] == "error"
    card = next(e for e in events if e["type"] == "workout_update")
    assert card["session"] == view["session"] and card["export"] == state


def test_error_command_preserves_other_state_and_original_payload():
    message = ToolMessage(content='{"error":"invalid"}', tool_call_id="call")
    command = Command(update={"messages": [message], "files": {}}, goto="model")
    result = enforce_tool_status(command)
    assert result.update["messages"][0].status == "error"
    assert result.update["messages"][0].content == message.content
    assert result.update["files"] == {} and result.goto == "model"
    assert message.status == "success"


def test_run_deadline_cancels_retry_backoff(monkeypatch):
    monkeypatch.setattr("arete.agent.factory.READ_TOOL_RETRY_DELAY_SECONDS", 1)
    devices = Mock(side_effect=ConnectionError("offline"))
    monkeypatch.setattr(garmin_export, "devices", devices)
    graph = graph_for("list_garmin_devices", {})

    async def cancel_during_backoff():
        task = asyncio.create_task(
            invoke_agent(
                graph,
                {"messages": [HumanMessage("lis")]},
                context=AgentContext(current_datetime=CLOCK),
            )
        )
        # Bound the test wait, and cancel only after the first attempt failed.
        async with asyncio.timeout(5):
            for _ in range(500):
                if devices.call_count:
                    break
                await asyncio.sleep(0.01)
            assert devices.call_count == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_during_backoff())
    assert devices.call_count == 1


@pytest.mark.parametrize("async_mode", [False, True])
def test_garmin_sync_gets_the_run_deadline_and_refreshes_the_page(
    monkeypatch, async_mode
):
    from arete.services import garmin_sync

    sync = Mock(return_value={"complete": True, "sessions": [{"id": 42}]})
    monkeypatch.setattr(garmin_sync, "sync_recent", sync)
    context = AgentContext()
    context.page_section = "stale page"
    result = run(graph_for("sync_garmin_activities", {}), async_mode, context)
    message = next(m for m in result["messages"] if m.type == "tool")
    assert json.loads(message.content)["sessions"] == [{"id": 42}]
    assert (context.deadline is not None) is async_mode  # set by invoke_agent
    assert sync.call_args.kwargs["deadline"] == context.deadline
    assert context.page_section != "stale page"


@pytest.mark.parametrize("async_mode", [False, True])
def test_garmin_sync_failure_is_never_replayed(monkeypatch, async_mode):
    from arete.services import garmin_sync

    sync = Mock(side_effect=ConnectionError("garmin offline"))
    monkeypatch.setattr(garmin_sync, "sync_recent", sync)
    with pytest.raises(ConnectionError):
        run(graph_for("sync_garmin_activities", {}), async_mode)
    assert sync.call_count == 1


@pytest.mark.parametrize("async_mode", [False, True])
def test_a_past_session_is_never_exported(monkeypatch, async_mode):
    _planned_on(monkeypatch, "2000-01-01")
    export = Mock()
    monkeypatch.setattr(garmin_export, "export_batch", export)
    result = run(graph_for("export_garmin_sessions", {"session_ids": [21]}), async_mode)
    message = next(m for m in result["messages"] if m.type == "tool")
    assert message.status == "error"
    assert "[21]" in json.loads(message.content)["error"]
    export.assert_not_called()
