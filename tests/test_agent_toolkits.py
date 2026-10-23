"""Native binding, versioned planning patches and provider-facing schemas."""

import asyncio
import json
from datetime import date, timedelta
from uuid import uuid4

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.utils.function_calling import convert_to_openai_tool

from arete.agent.capabilities.discovery import authorized_tools
from arete.agent.middlewares.capabilities import ToolkitMiddleware
from arete.agent.middlewares.context import ContextBuilderMiddleware
from arete.agent.runtime.context import AgentContext
from arete.agent.tools.planning import (
    create_planned_session,
    preview_plan_changes,
    set_session_prescription,
    update_planned_session,
)
from arete.garmin.models import PlannedSession
from arete.garmin.repository import GarminRepository
from arete.garmin.workouts import convert
from arete.services import planning
from arete.services.garmin_export import inspect_session
from arete.services.prescriptions import Prescription, strength_prescription
from arete.services.settings import athlete_today

# The chat binds every planning tool on each model call; ARE-171 measured 49,844.
CHAT_SCHEMA_CHARS_MAX = 33_000


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


def set_steps(session, prescription):
    return json.loads(
        set_session_prescription.invoke(
            {
                "session_id": session["id"],
                "revision": session["revision"],
                "prescription": prescription,
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
    updated = set_steps(session, prescription)["session"]
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
    bad = set_steps(session, {"steps": [{"kind": "repeat", "duration_kind": "meters"}]})
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
    updated = set_steps(session, {"steps": steps})
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
    for tool in (create_planned_session, update_planned_session, preview_plan_changes):
        wire = json.dumps(convert_to_openai_tool(tool))
        assert '"prescription"' not in wire
    params = convert_to_openai_tool(set_session_prescription)["function"]["parameters"]
    assert '"title"' not in json.dumps(params["properties"]["prescription"])
    assert params["additionalProperties"] is False
    assert params["required"] == ["session_id", "revision", "prescription"]
    step = params["properties"]["prescription"]["properties"]["steps"]["items"]
    for _ in range(2):
        assert step["properties"]["repeat"]["maximum"] == 100
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


def test_chat_tool_schemas_fit_their_budget():
    sizes = {
        tool.name: len(json.dumps(convert_to_openai_tool(tool), ensure_ascii=False))
        for tool in authorized_tools("chat")
    }
    listing = "\n".join(
        f"{size:>7} {name}" for name, size in sorted(sizes.items(), key=lambda x: -x[1])
    )
    assert sum(sizes.values()) <= CHAT_SCHEMA_CHARS_MAX, listing


def repeat(count, *children, **extra):
    return {"kind": "repeat", "repeat": count, "steps": list(children), **extra}


def meters(kind, value, **extra):
    return {"kind": kind, "duration_kind": "meters", "value": value, **extra}


def seconds(kind, value, **extra):
    return {"kind": kind, "duration_kind": "seconds", "value": value, **extra}


def target(kind, low, high=None):
    return {"kind": kind, "low": low, "high": high or low}


SQUAT = "Squat 3x10 20kg r1'30"
# Steps the coach sets after creation, one per sport and step feature it can carry.
PRESCRIPTIONS = [
    (
        "running",
        "intervals",
        {
            "steps": [
                {"kind": "warmup"},
                repeat(20, meters("effort", 300), meters("recovery", 100)),
                {"kind": "cooldown"},
            ]
        },
    ),
    (
        "running",
        "tempo",
        {
            "steps": [
                seconds(
                    "effort",
                    1200,
                    target=target("pace_sec_km", 230, 240),
                    secondary_target=target("heart_rate_bpm", 160, 170),
                )
            ]
        },
    ),
    (
        "running",
        "intervals",
        {
            "steps": [
                repeat(
                    2,
                    repeat(
                        4,
                        seconds("effort", 60),
                        seconds("recovery", 60),
                        skip_last_recovery=True,
                    ),
                    seconds("rest", 180),
                )
            ]
        },
    ),
    (
        "running",
        "endurance",
        {
            "steps": [
                {"kind": "effort", "target": target("hr_zone", 2)},
            ]
        },
    ),
    (
        "cycling",
        "intervals",
        {
            "steps": [
                seconds("warmup", 900),
                repeat(
                    3,
                    seconds("effort", 600, target=target("power_w", 250, 270)),
                    seconds("recovery", 300),
                ),
            ]
        },
    ),
    (
        "cycling",
        "tempo",
        {
            "steps": [
                seconds("effort", 1800, target=target("cadence_rpm", 85, 95)),
            ]
        },
    ),
    (
        "swimming",
        "intervals",
        {
            "pool_length_m": 25,
            "steps": [
                meters("warmup", 200, stroke="mixed"),
                repeat(8, meters("effort", 50, stroke="free"), seconds("rest", 20)),
            ],
        },
    ),
    ("hiking", "endurance", {"steps": [seconds("effort", 7200, notes="Dénivelé")]}),
]


def strength_steps():
    """The grammar's sets regrouped as the coach would for Garmin."""
    effort, rest = strength_prescription(SQUAT, None).model_dump()["steps"][:2]
    effort["garmin_exercise"] = "BARBELL_BACK_SQUAT"
    return {"steps": [repeat(3, effort, rest)]}


def stored(session_id):
    return GarminRepository().get_planned_session(session_id).prescription


def old_create(day, sport, session_type, prescription, strength_text):
    return planning.create_planned_session(
        day.isoformat(),
        session_type,
        sport=sport,
        prescription=Prescription.model_validate(prescription),
        strength_text=strength_text,
    )


def old_update(session, prescription, strength_text):
    changes = {"prescription": prescription}
    if strength_text:
        changes["strength_text"] = strength_text
    return planning.update_planned_session(
        session["id"],
        session["revision"],
        planning.SessionChanges.model_validate(changes),
    )


def old_preview(session, prescription, strength_text):
    changes = {"prescription": prescription}
    if strength_text:
        changes["strength_text"] = strength_text
    preview = planning.preview_plan_changes(
        planning.PlanChangeSet.model_validate(
            {"items": [{**session_ref(session), "changes": changes}]}
        )
    )
    return planning.apply_plan_changes(preview["id"], preview["revision"], str(uuid4()))


def session_ref(session):
    return {"session_id": session["id"], "revision": session["revision"]}


@pytest.mark.parametrize(
    "sport,session_type,prescription",
    [*PRESCRIPTIONS, ("strength", "strength", None)],
)
@pytest.mark.parametrize("old_path", ["create", "update", "preview"])
def test_set_session_prescription_stores_what_the_structured_argument_stored(
    sport, session_type, prescription, old_path
):
    prescription = prescription or strength_steps()
    strength_text = SQUAT if sport == "strength" else ""
    day = athlete_today() + timedelta(days=1)

    def blank():
        return json.loads(
            planning.create_planned_session(
                day.isoformat(),
                session_type,
                sport=sport,
                strength_text=strength_text,
            )
        )["session"]

    if old_path == "create":
        old = json.loads(
            old_create(day, sport, session_type, prescription, strength_text)
        )["session"]
    elif old_path == "update":
        old = blank()
        assert "error" not in json.loads(old_update(old, prescription, strength_text))
    else:
        old = blank()
        assert old_preview(old, prescription, strength_text)["applied"]
    new = blank()
    assert set_steps(new, prescription)["updated"]
    assert stored(new["id"]) == stored(old["id"])
    assert stored(new["id"]) == Prescription.model_validate(prescription).model_dump(
        mode="json"
    )


def test_set_session_prescription_with_a_stale_revision_writes_nothing():
    session = create(target_duration_min=45)
    steps = {"steps": [seconds("effort", 1800)]}
    assert set_steps(session, steps)["updated"]
    replay = set_steps(session, {"steps": [seconds("effort", 600)]})
    assert "error" in replay
    saved = GarminRepository().get_planned_session(session["id"])
    assert saved.revision == session["revision"] + 1
    assert saved.prescription == Prescription.model_validate(steps).model_dump(
        mode="json"
    )


@pytest.mark.parametrize(
    "from_text,change",
    [(True, {"value": 12}), (True, {"kind": "warmup"}), (False, {"value": 12})],
)
def test_strength_steps_cannot_replace_the_sets_the_grammar_read(from_text, change):
    day = athlete_today() + timedelta(days=2)
    if from_text:
        session = json.loads(
            planning.create_planned_session(
                day.isoformat(), "strength", sport="strength", strength_text=SQUAT
            )
        )["session"]
    else:
        identifier = GarminRepository().create_planned_session(
            PlannedSession(date=day, sport="strength", session_type="strength")
        )
        session = {"id": identifier, "revision": 1}
    before = stored(session["id"])
    grouped = strength_steps()
    grouped["steps"][0]["steps"][0].update(change)
    assert "strength_text" in set_steps(session, grouped)["error"]
    saved = GarminRepository().get_planned_session(session["id"])
    assert saved.revision == session["revision"] and saved.prescription == before
