"""Native binding, versioned planning patches and provider-facing schemas."""

import asyncio
import json
from datetime import date

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.utils.function_calling import convert_to_openai_tool

from arete.agent.capabilities.discovery import authorized_tools
from arete.agent.middlewares.capabilities import ToolkitMiddleware
from arete.agent.middlewares.context import ContextBuilderMiddleware
from arete.agent.runtime.context import AgentContext
from arete.agent.tools.planning import create_planned_session, update_planned_session
from arete.garmin.repository import GarminRepository
from arete.garmin.workouts import convert
from arete.services import planning
from arete.services.garmin_export import inspect_session
from arete.services.prescriptions import Prescription


class Model(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def call(name, args, identifier="call"):
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": identifier}]
    )


def graph(*responses):
    return create_agent(
        Model(messages=iter(responses)),
        tools=authorized_tools("chat"),
        middleware=[ToolkitMiddleware(), ContextBuilderMiddleware()],
        context_schema=AgentContext,
    )


@pytest.mark.parametrize("async_mode", [False, True])
def test_native_validation_error_can_be_corrected_without_a_partial_write(async_mode):
    day = "2099-01-13" if async_mode else "2099-01-12"
    agent = graph(
        call(
            "create_planned_session",
            {"date_str": day, "session_type": "endurance", "invented": True},
            "bad",
        ),
        call(
            "create_planned_session",
            {"date_str": day, "session_type": "endurance"},
            "good",
        ),
        AIMessage(content="Séance créée."),
    )
    context = AgentContext()
    state = {"messages": [HumanMessage("Crée une séance.")]}
    result = (
        asyncio.run(agent.ainvoke(state, context=context))
        if async_mode
        else agent.invoke(state, context=context)
    )
    messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert [m.status for m in messages] == ["error", "success"]
    saved = GarminRepository().list_planned_sessions(
        start_date=date.fromisoformat(day), end_date=date.fromisoformat(day)
    )
    assert len(saved) == 1
    assert context.stats.tool_calls == 2


def create(**kwargs):
    return json.loads(
        planning.create_planned_session("2099-02-01", "endurance", **kwargs)
    )["session"]


def patch(session, **changes):
    return json.loads(
        update_planned_session.invoke(
            {
                "session_id": session["id"],
                "revision": session["revision"],
                "changes": changes,
            }
        )
    )


def test_one_patch_moves_changes_status_and_clears_targets():
    session = create(
        description="ancienne", target_duration_min=45, target_distance_km=8
    )
    result = patch(
        session,
        date_str="2099-02-02",
        status="skipped",
        description="",
        target_duration_min=0,
    )
    updated = result["session"]
    assert updated["id"] == session["id"] and updated["revision"] == 2
    assert updated["date"] == "2099-02-02" and updated["status"] == "skipped"
    assert updated["target_duration_min"] is None and updated["description"] is None
    assert updated["target_distance_km"] == 8
    assert "error" in patch(session, description="stale")
    assert GarminRepository().get_planned_session(session["id"]).description is None


def test_prescription_replaces_stale_targets_and_cannot_be_downgraded():
    session = create(target_duration_min=45)
    prescription = {
        "steps": [{"kind": "effort", "duration_kind": "seconds", "value": 1800}]
    }
    updated = patch(session, prescription=prescription)["session"]
    assert updated["structured"] and updated["target_duration_min"] is None
    assert "error" in patch(updated, target_duration_min=90)
    assert "error" in patch(updated, prescription=None)
    assert (
        GarminRepository().get_planned_session(session["id"]).revision
        == updated["revision"]
    )


@pytest.mark.parametrize("edge_seconds", [None, 600, 0])
def test_incomplete_repeat_is_correctable_without_losing_workout_steps(edge_seconds):
    """The failed trace dropped the prescription after this validation error.

    Replay its invalid argument, then a complete correction through native tools.
    This proves persistence/export, not the model's ability to choose the correction.
    """
    session = create(description="20x300")
    bad = patch(
        session,
        description="20x300 r100",
        prescription={"steps": [{"kind": "repeat", "duration_kind": "meters"}]},
    )
    assert "repeat (entier de 2 à 100)" in bad["error"]
    assert "steps (sous-étapes non vides)" in bad["error"]
    saved = GarminRepository().get_planned_session(session["id"])
    assert saved.revision == session["revision"]
    assert saved.description == "20x300" and saved.prescription is None

    steps = [
        {
            "kind": "repeat",
            "repeat": 20,
            "steps": [
                {"kind": "effort", "duration_kind": "meters", "value": 300},
                {"kind": "recovery", "duration_kind": "meters", "value": 100},
            ],
        }
    ]
    if edge_seconds != 0:
        duration = (
            {"duration_kind": "seconds", "value": edge_seconds}
            if edge_seconds
            else {"duration_kind": "lap"}
        )
        steps = [
            {"kind": "warmup", **duration},
            *steps,
            {"kind": "cooldown", **duration},
        ]
    expected = Prescription.model_validate({"steps": steps})
    updated = patch(session, description="20x300 r100", prescription={"steps": steps})
    assert updated["session"]["id"] == session["id"]
    assert updated["session"]["revision"] == session["revision"] + 1
    inspected = inspect_session(session["id"])["session"]
    assert inspected["structured"] and inspected["exportable"]
    assert inspected["target_duration_min"] is None
    assert Prescription.model_validate(inspected["prescription"]) == expected
    payload = convert(session["id"], "20x300 r100", "running", expected)
    exported = payload["workoutSegments"][0]["workoutSteps"]
    assert len(exported) == len(steps)
    group = exported[1 if edge_seconds != 0 else 0]
    assert group["numberOfIterations"] == 20
    assert [s["endConditionValue"] for s in group["workoutSteps"]] == [300, 100]
    assert all(
        s["endCondition"]["conditionTypeKey"] == "distance"
        for s in group["workoutSteps"]
    )
    if edge_seconds != 0:
        for edge in (exported[0], exported[-1]):
            assert edge["endCondition"]["conditionTypeKey"] == (
                "time" if edge_seconds else "lap.button"
            )


@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"date_str": "Monday"},
        {"target_duration_min": -1},
        {"target_distance_km": float("inf")},
        {"status": "validated"},
        {"unknown": "field"},
    ],
)
def test_invalid_patch_never_writes(changes):
    session = create()
    assert "error" in patch(session, **changes)
    assert GarminRepository().get_planned_session(session["id"]).revision == 1


def test_workout_tool_wire_schema_keeps_nested_intervals_typed():
    for tool in (create_planned_session, update_planned_session):
        params = convert_to_openai_tool(tool)["function"]["parameters"]
        properties = params["properties"]
        assert params["additionalProperties"] is False
        assert (
            not {"runtime", "config", "thread_id", "prescription_json"}
            & properties.keys()
        )
        if tool is update_planned_session:
            properties = properties["changes"]["properties"]
        prescription = properties["prescription"]["anyOf"][0]
        step = prescription["properties"]["steps"]["items"]
        for _ in range(2):
            assert step["properties"]["repeat"]["anyOf"][0]["maximum"] == 100
            assert "recovery" in step["properties"]["skip_last_recovery"]["description"]
            step = step["properties"]["steps"]["items"]
        assert "repeat" not in step["properties"]["kind"]["enum"]
        # No repeat at the leaf depth, so nothing to skip there either.
        assert step["properties"]["skip_last_recovery"] == {"type": "null"}
        assert step["properties"]["duration_kind"]["enum"] == [
            "seconds",
            "meters",
            "reps",
            "lap",
        ]


@pytest.mark.parametrize(
    "patch",
    [
        {"date_str": "Monday"},
        {"sport": "invented"},
        {"target_duration_min": -1},
        {"target_distance_km": float("inf")},
        {"prescription": '{"steps": []}'},
        {"surprise": True},
    ],
)
def test_typed_creation_rejects_bad_arguments_before_domain_write(monkeypatch, patch):
    def unexpected(**kwargs):
        pytest.fail("Invalid arguments reached persistence")

    monkeypatch.setattr(planning, "create_planned_session", unexpected)
    result = create_planned_session.invoke(
        {"date_str": "2026-10-12", "session_type": "intervals", **patch}
    )
    assert "error" in json.loads(result)


def test_clearable_targets_have_portable_schemas_and_strict_validation():
    from pydantic import ValidationError

    from arete.agent.tools.planning import SessionChangesInput

    assert (
        SessionChangesInput(target_intensity="", target_hr_zone="").target_hr_zone == ""
    )
    with pytest.raises(ValidationError):
        SessionChangesInput(target_intensity="maximal")
    for tool in (create_planned_session, update_planned_session):
        properties = convert_to_openai_tool(tool)["function"]["parameters"][
            "properties"
        ]
        if "changes" in properties:
            properties = properties["changes"]["properties"]
        field = properties["target_intensity"]
        field = field.get("anyOf", [field])[0]
        assert "enum" not in field and "pattern" in field
