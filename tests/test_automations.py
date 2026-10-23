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


def test_concurrent_connections_claim_an_occurrence_once():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    now = datetime.now(UTC)
    item = service.create(
        spec({"kind": "once", "at": now - timedelta(minutes=1)}),
        activate=True,
        now=now - timedelta(minutes=2),
    )
    service.prepare(now)
    identifier = service.runs(item["id"])["items"][0]["id"]
    barrier = Barrier(2, timeout=5)

    def claim():
        with athlete_scope(1):
            barrier.wait()
            return service.claim(identifier, now)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(claim) for _ in range(2)]
        outcomes = [future.result(timeout=10) for future in futures]
    assert sum(outcome is not None for outcome in outcomes) == 1
    assert service.run_detail(identifier)["state"] == "running"
    with db_connection() as con:
        assert (
            con.execute(
                "SELECT count(*) FROM app.automation_worker_slots WHERE run_id=?",
                [identifier],
            ).fetchone()[0]
            == 1
        )


@pytest.mark.parametrize(
    "recorded_before_activation,prepare_before_link",
    [(False, False), (False, True), (True, False)],
)
def test_linked_strength_import_is_one_occurrence_without_rpg(
    recorded_before_activation, prepare_before_link
):
    from arete.garmin.models import ActualSession
    from arete.garmin.repository import GarminRepository
    from arete.strength.models import StrengthSession
    from arete.strength.repository import StrengthRepository

    now = datetime.now(UTC)
    day = (now - timedelta(days=10)).date()  # Late imports use registration time.
    strength = StrengthRepository()
    garmin = GarminRepository()
    strength_id = strength.create_session(StrengthSession(date=day))
    actual_id = None
    try:
        activated = (
            now + timedelta(minutes=1)
            if recorded_before_activation
            else now - timedelta(minutes=1)
        )
        item = service.create(
            spec({"kind": "session", "sport": "strength", "delay_minutes": 30}),
            activate=True,
            now=activated,
        )
        if prepare_before_link:
            service.prepare(now + timedelta(minutes=2))
        actual_id = garmin.create_actual_session(
            ActualSession(date=day, sport="strength", duration_sec=1200)
        )
        assert strength.link_to_actual_session(strength_id, actual_id)
        # Do not run the RPG projection: the real activity link owns identity.
        service.prepare(now + timedelta(minutes=2))
        service.prepare(now + timedelta(minutes=3))
        runs = service.runs(item["id"])["items"]
        assert len(runs) == (0 if recorded_before_activation else 1)
        if runs:
            due = datetime.fromisoformat(runs[0]["due_at"])
            assert now + timedelta(minutes=29) < due < now + timedelta(minutes=31)
            if runs[0]["session_key"] == f"strength:{strength_id}":
                strength.delete_session(strength_id)
            else:
                garmin.delete_actual_session(actual_id)
            assert service.claim(runs[0]["id"], due + timedelta(seconds=1)) is None
            deleted = service.run_detail(runs[0]["id"])
            assert deleted["state"] == "failed"
            assert "séance" in deleted["error"]
    finally:
        with db_connection() as con:
            con.execute("DELETE FROM app.strength_sessions WHERE id=?", [strength_id])
            if actual_id is not None:
                con.execute("DELETE FROM app.actual_sessions WHERE id=?", [actual_id])
            con.execute(
                "DELETE FROM app.game_events WHERE source_key IN (?,?)",
                [f"strength:{strength_id}", f"actual:{actual_id}"],
            )


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
    execution.finish(
        run["id"], seconds=1, interrupts=[{**interruption, "id": "next-question"}]
    )
    service.prepare(datetime.now(UTC) + timedelta(hours=49))
    assert service.run_detail(run["id"])["state"] == "expired"
    with pytest.raises(service.Conflict):
        service.decide(run["id"], "next-question", 1, decision)
    assert service.claim(run["id"]) is None


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


@pytest.mark.anyio
async def test_composed_mission_waits_and_resumes_with_cumulative_budgets(monkeypatch):
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from arete import coaching

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    model = Model(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "feeling",
                            "name": "ask_athlete",
                            "args": {"question": "Comment te sens-tu ?"},
                        }
                    ],
                ),
                AIMessage(content="Ressenti reçu, aucune séance modifiée."),
            ]
        )
    )
    monkeypatch.setattr(coaching, "build_chat_model", lambda **kwargs: model)
    monkeypatch.setattr("arete.services.inbox.publish", lambda *args: None)
    run = started()
    await coaching._run_automation(run)
    waiting = service.run_detail(run["id"])
    assert waiting["state"] == "waiting", waiting.get("error")
    assert waiting["model_requests"] == 1 and waiting["tool_calls"] == 1
    question = waiting["interrupts"][0]
    service.decide(
        run["id"],
        question["id"],
        question["revision"],
        {"type": "respond", "message": "Bien récupéré."},
    )
    await coaching._run_automation(service.claim(run["id"]))
    done = service.run_detail(run["id"])
    assert done["state"] == "completed", done.get("error")
    assert (
        done["resumes"] == 1 and done["model_requests"] == 2 and done["tool_calls"] == 1
    )
    assert done["effects"] == []


@pytest.mark.anyio
async def test_a_segment_composes_off_the_event_loop(monkeypatch):
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage
    from worker_only import worker_only

    from arete import coaching
    from arete.dataio import db
    from arete.services.feature_flags import FeatureFlags

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    model = Model(messages=iter([AIMessage(content="Bilan disponible.")]))
    monkeypatch.setattr(coaching, "build_chat_model", lambda **kwargs: model)
    monkeypatch.setattr("arete.services.inbox.publish", lambda *args: None)
    run = started()
    # The rollout flag, the route record and the compile all block.
    connect = db.db_connection
    monkeypatch.setattr(coaching, "get_feature_flags", worker_only(FeatureFlags))
    monkeypatch.setattr(db, "db_connection", worker_only(connect))
    monkeypatch.setattr(coaching, "_assemble", worker_only(coaching._assemble))
    await coaching._run_automation(run)
    monkeypatch.setattr(db, "db_connection", connect)
    done = service.run_detail(run["id"])
    assert done["state"] == "completed", done.get("error")


@pytest.mark.anyio
async def test_a_failed_clock_read_still_finishes_the_run(monkeypatch):
    from arete import coaching

    def unreadable():
        raise ConnectionError("settings unavailable")

    monkeypatch.setattr("arete.services.settings.athlete_now", unreadable)
    run = started()
    await coaching._run_automation(run)
    failed = service.run_detail(run["id"])
    assert failed["state"] != "running"
    assert "settings unavailable" in (failed.get("error") or "")


def test_failed_push_keeps_completed_mission_and_inbox(monkeypatch):
    from arete.services import automation_execution as execution
    from arete.services import inbox, notifications

    def unavailable(*args, **kwargs):
        raise ConnectionError("provider unavailable")

    monkeypatch.setattr(notifications, "notify", unavailable)
    run = started()
    execution.finish(run["id"], seconds=1, result="Bilan disponible.")
    assert service.run_detail(run["id"])["state"] == "completed"
    notice = inbox.listing()["items"][0]
    assert notice["push"]["skipped_reason"] == "delivery_failed"
    assert notice["reference"]["id"] == run["id"]
    inbox.mark(notice["id"], read=True)
    assert inbox.listing()["items"] == []
    assert service.run_detail(run["id"])["state"] == "completed"


@pytest.mark.anyio
async def test_grouped_preview_needs_no_approval_but_application_waits_once(
    monkeypatch,
):
    import json

    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage, ToolMessage

    from arete import coaching
    from arete.garmin.models import PlannedSession, SessionType
    from arete.garmin.repository import GarminRepository
    from arete.services import planning
    from arete.services.settings import athlete_today

    repo = GarminRepository()
    ids = [
        repo.create_planned_session(
            PlannedSession(
                date=athlete_today() + timedelta(days=2),
                session_type=SessionType.ENDURANCE,
                target_duration_min=40,
            )
        )
        for _ in range(2)
    ]

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

        async def _agenerate(self, messages, **kwargs):
            previews = [
                message
                for message in messages
                if isinstance(message, ToolMessage)
                and message.name == "preview_plan_changes"
            ]
            if previews and not any(
                isinstance(message, ToolMessage)
                and message.name == "apply_plan_changes"
                for message in messages
            ):
                preview = json.loads(previews[-1].content)
                self.messages = iter(
                    [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "id": "apply-group",
                                    "name": "apply_plan_changes",
                                    "args": {
                                        "preview_id": preview["id"],
                                        "revision": 1,
                                        "operation_id": preview["id"],
                                    },
                                }
                            ],
                        )
                    ]
                )
            return await super()._agenerate(messages, **kwargs)

    model = Model(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "preview-group",
                            "name": "preview_plan_changes",
                            "args": {
                                "items": [
                                    {
                                        "session_id": identifier,
                                        "revision": 1,
                                        "changes": {"target_duration_min": 30},
                                    }
                                    for identifier in ids
                                ]
                            },
                        }
                    ],
                ),
                AIMessage(content="Planning enregistré."),
            ]
        )
    )
    monkeypatch.setattr(coaching, "build_chat_model", lambda **kwargs: model)
    monkeypatch.setattr("arete.services.inbox.publish", lambda *args: None)
    run = started()
    await coaching._run_automation(run)
    waiting = service.run_detail(run["id"])
    assert waiting["state"] == "waiting", waiting.get("error")
    assert len(waiting["interrupts"]) == 1
    interrupt = waiting["interrupts"][0]
    assert interrupt["payload"]["name"] == "apply_plan_changes"
    from arete.services.coaching_attention import projection

    subject = f"plan_change_set:{interrupt['payload']['args']['preview_id']}"
    priorities = [
        item for item in projection()["items"] if item["subject_key"] == subject
    ]
    assert len(priorities) == 1
    assert priorities[0]["source_ref"] == f"automation_run:{run['id']}"
    assert all(repo.get_planned_session(identifier).revision == 1 for identifier in ids)
    service.decide(
        run["id"], interrupt["id"], interrupt["revision"], {"type": "approve"}
    )
    # A fresh model for the resumed invocation, as with a worker/process restart.
    monkeypatch.setattr(
        coaching,
        "build_chat_model",
        lambda **kwargs: Model(
            messages=iter([AIMessage(content="Planning enregistré.")])
        ),
    )
    await coaching._run_automation(service.claim(run["id"]))
    done = service.run_detail(run["id"])
    assert done["state"] == "completed", done.get("error")
    assert all(
        repo.get_planned_session(identifier).target_duration_min == 30
        for identifier in ids
    )
    assert (
        planning.get_plan_changes(interrupt["payload"]["args"]["preview_id"])["state"]
        == "applied"
    )


def test_a_claim_racing_a_deletion_never_starts_the_cancelled_run(monkeypatch):
    """ARE-150: the deletion's cancel commits inside the claim's snapshot."""
    from write_race import race

    now = datetime.now(UTC)
    item = service.create(
        spec({"kind": "once", "at": now - timedelta(minutes=1)}),
        activate=True,
        now=now - timedelta(minutes=2),
    )
    service.prepare(now)
    run = service.runs(item["id"])["items"][0]

    def deleted():
        service.delete(item["id"], service.get(item["id"])["revision"])

    with race(monkeypatch, r"SET state='running'", deleted):
        assert service.claim(run["id"], now) is None
    assert service.run_detail(run["id"])["state"] == "cancelled"


@pytest.fixture
def evening_routine(monkeypatch):
    """An opted-in athlete, one upcoming session and one saved evening answer."""
    from zoneinfo import ZoneInfo

    from arete.garmin.models import PlannedSession, SessionType
    from arete.garmin.repository import GarminRepository
    from arete.services import coaching_attention

    now = datetime.now(UTC)
    day = now.astimezone(ZoneInfo("Europe/Paris")).date()
    monkeypatch.setattr(coaching_attention, "enabled", lambda *args: True)
    with db_connection() as con:
        athlete = con.execute(
            "INSERT INTO app.athletes (id) VALUES (nextval('app.athletes_seq')) RETURNING id"
        ).fetchone()[0]
    with athlete_scope(athlete):
        item = service.create(
            spec({"kind": "evening"}), activate=True, now=now - timedelta(minutes=2)
        )
        session = GarminRepository().create_planned_session(
            PlannedSession(
                date=day + timedelta(days=1),
                session_type=SessionType.ENDURANCE,
                target_duration_min=45,
            )
        )
        with db_connection() as con:
            message = con.execute(
                "INSERT INTO app.coach_evening_messages (date,status,question,text,created_at,answer,answered_at) "
                "VALUES (?,'ok','Quel temps as-tu demain ?','Une séance demain. Quel temps as-tu demain ?',?,?,?) RETURNING id",
                [
                    day,
                    now.replace(tzinfo=None),
                    "Demain, seulement 25 minutes.",
                    (now - timedelta(minutes=1)).replace(tzinfo=None),
                ],
            ).fetchone()[0]
        yield {
            "now": now,
            "day": day,
            "item": item,
            "message": message,
            "session": session,
            "athlete": athlete,
        }


def test_evening_queue_is_opted_in_idempotent_and_athlete_scoped(
    evening_routine, monkeypatch
):
    from arete.services import coaching_attention

    data = evening_routine
    monkeypatch.setattr(coaching_attention, "enabled", lambda *args: False)
    service.prepare_evening_replies(data["now"])
    assert not service.runs(data["item"]["id"])["items"]
    monkeypatch.setattr(coaching_attention, "enabled", lambda *args: True)
    service.prepare_evening_replies(data["now"])
    service.prepare_evening_replies(data["now"])
    service.prepare(data["now"])
    runs = service.runs(data["item"]["id"])["items"]
    assert len(runs) == 1
    assert runs[0]["definition"]["source"]["sessions"][0]["id"] == data["session"]
    assert service.evening_followup(data["message"])["id"] == runs[0]["id"]
    with athlete_scope(1):
        assert service.evening_followup(data["message"]) is None
    with pytest.raises(ValueError, match="routine suit déjà"):
        service.create(spec({"kind": "evening"}), activate=True, now=data["now"])


def test_evening_queue_excludes_old_consent_and_late_replies(evening_routine):
    data = evening_routine
    service.prepare(data["now"], sessions_since=data["now"])
    assert not service.runs(data["item"]["id"])["items"]
    service.prepare(data["now"] + timedelta(days=3))
    assert not service.runs(data["item"]["id"])["items"]


def test_evening_expiry_uses_the_source_day_not_the_routines_device_zone(
    evening_routine,
):
    from zoneinfo import ZoneInfo

    data = evening_routine
    with db_connection() as con:
        con.execute(
            "UPDATE app.automations SET timezone='Pacific/Kiritimati' WHERE id=?",
            [data["item"]["id"]],
        )
    service.prepare_evening_replies(data["now"])
    run = service.runs(data["item"]["id"])["items"][0]
    expected = datetime.combine(
        data["day"] + timedelta(days=2), datetime.min.time(), ZoneInfo("Europe/Paris")
    )
    assert datetime.fromisoformat(run["expires_at"]) == expected


def test_evening_queue_concurrency_and_expiry(evening_routine):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    import duckdb

    data = evening_routine
    barrier = Barrier(2, timeout=5)

    def enqueue():
        with athlete_scope(data["athlete"]):
            barrier.wait()
            try:
                service.prepare_evening_replies(data["now"])
            except duckdb.TransactionException:
                return "other worker won"
            return "queued"

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(enqueue) for _ in range(2)]
        assert "queued" in [future.result(timeout=10) for future in futures]
    records = service.runs(data["item"]["id"])["items"]
    assert len(records) == 1
    service.prepare(data["now"] + timedelta(days=3))
    assert service.run_detail(records[0]["id"])["state"] == "expired"
    assert service.claim(records[0]["id"]) is None


def test_evening_answer_reuse_requires_the_exact_session_revision(evening_routine):
    from arete.garmin.repository import GarminRepository
    from arete.services import automation_execution as execution
    from arete.services.coaching_attention import coordinate_question

    data = evening_routine
    service.prepare_evening_replies(data["now"])
    run = service.claim(service.runs(data["item"]["id"])["items"][0]["id"])
    execution.record_evening_decision(
        run["id"], {"action": "propose", "availability": True}
    )
    subject = {
        "kind": "availability",
        "source": "plan",
        "id": data["session"],
        "revision": 1,
    }
    answer = coordinate_question(run["id"], "availability", subject)
    assert answer["state"] == "answered"
    assert answer["answer"] == "Demain, seulement 25 minutes."
    assert answer["reference"] == f"evening:{data['message']}"
    GarminRepository().update_planned_session_fields(
        data["session"], description="Changed elsewhere"
    )
    with pytest.raises(ValueError, match="planning a changé"):
        coordinate_question(run["id"], "availability", subject)
    with pytest.raises(ValueError, match="planning a changé"):
        execution.validate_evening_source(run["id"])
    assert (
        coordinate_question(run["id"], "new-question", {**subject, "revision": 2})
        is None
    )


def test_evening_replies_before_renewed_consent_are_not_recovered(
    evening_routine, monkeypatch, give_consent
):
    from arete.services import consent

    data = evening_routine
    monkeypatch.setattr(consent, "required", lambda: True)
    service.prepare_evening_replies()
    assert service.runs(data["item"]["id"])["items"] == []
    give_consent(data["athlete"])
    service.prepare_evening_replies()
    assert service.runs(data["item"]["id"])["items"] == []


def test_switch_off_prevents_a_queued_evening_run_from_starting(
    evening_routine, monkeypatch
):
    from arete.services import coaching_attention

    data = evening_routine
    service.prepare_evening_replies(data["now"])
    run = service.runs(data["item"]["id"])["items"][0]
    monkeypatch.setattr(coaching_attention, "enabled", lambda *args: False)
    assert service.claim(run["id"]) is None
    assert service.run_detail(run["id"])["model_requests"] == 0


@pytest.mark.anyio
@pytest.mark.parametrize("action", ["record_only", "clarify", "propose", "failure"])
async def test_evening_decision_is_once_and_uses_the_durable_request_budget(
    evening_routine, monkeypatch, action
):
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from arete import coaching
    from arete.services.jev import JevResponse, JevService

    requests = []

    async def decide(self, request, **kwargs):
        requests.append(request)
        assert kwargs["langsmith_extra"]["metadata"] == {
            "thread_id": run["id"],
            "profile": "automation",
            "source_ref": f"evening:{evening_routine['message']}",
        }
        if action == "failure":
            raise TimeoutError("Classifier unavailable")
        return JevResponse.model_validate(
            {
                "model": self.model,
                "answers": {
                    "action": {"type": "choice", "choice": action},
                    "availability": {"type": "choice", "choice": "yes"},
                },
                "usage": {"input_tokens": 400, "output_tokens": 20},
            }
        )

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    script = (
        [AIMessage(content="Ressenti reçu.")]
        if action != "clarify"
        else [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "clarify",
                        "name": "ask_athlete",
                        "args": {"question": "Quel créneau te conviendrait ?"},
                    }
                ],
            )
        ]
    )
    monkeypatch.setattr(JevService, "decide", decide)
    monkeypatch.setattr(
        coaching, "build_chat_model", lambda **kwargs: Model(messages=iter(script))
    )
    notices = []
    monkeypatch.setattr(
        "arete.services.inbox.publish", lambda *args: notices.append(args)
    )
    service.prepare_evening_replies(evening_routine["now"])
    run = service.claim(service.runs(evening_routine["item"]["id"])["items"][0]["id"])
    await coaching._run_automation(run)
    result = service.run_detail(run["id"])
    assert len(requests) == 1
    assert result["model_requests"] == (
        1 if action in {"failure", "record_only"} else 2
    )
    if action == "record_only":
        assert result["state"] == "completed"
        assert not notices
    elif action == "failure":
        assert result["state"] == "failed"
        assert "Classifier unavailable" in result["error"]
        assert service.claim(run["id"]) is None
    elif action == "clarify":
        assert result["state"] == "waiting", result["error"]
        interrupt = result["interrupts"][0]
        service.decide(
            run["id"],
            interrupt["id"],
            interrupt["revision"],
            {"type": "respond", "message": "À midi."},
        )
        monkeypatch.setattr(
            coaching,
            "build_chat_model",
            lambda **kwargs: Model(
                messages=iter([AIMessage(content="Réponse reçue.")])
            ),
        )
        await coaching._run_automation(service.claim(run["id"]))
        assert len(requests) == 1
        assert service.run_detail(run["id"])["model_requests"] == 3
    else:
        assert result["state"] == "completed", result["error"]


@pytest.mark.anyio
async def test_evening_reply_preview_approval_receipt_and_resume(
    evening_routine, monkeypatch
):
    """Exercise the real graph and domain tools; only provider inference is fake."""
    import json

    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage, ToolMessage

    from arete import coaching
    from arete.garmin.repository import GarminRepository
    from arete.services.jev import JevResponse, JevService

    data = evening_routine
    calls = []

    async def decide(self, request, **kwargs):
        calls.append(request)
        return JevResponse.model_validate(
            {
                "model": self.model,
                "answers": {
                    "action": {"type": "choice", "choice": "propose"},
                    "availability": {"type": "choice", "choice": "yes"},
                },
                "usage": {"input_tokens": 400, "output_tokens": 20},
            }
        )

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

        async def _agenerate(self, messages, **kwargs):
            receipts = {m.name: m for m in messages if isinstance(m, ToolMessage)}
            if "apply_plan_changes" in receipts:
                answer = AIMessage(
                    content="Ta séance de demain dure maintenant 25 minutes. Le suivi après la séance reste disponible."
                )
            elif "preview_plan_changes" in receipts:
                preview = json.loads(receipts["preview_plan_changes"].content)
                answer = AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "apply-evening",
                            "name": "apply_plan_changes",
                            "args": {
                                "preview_id": preview["id"],
                                "revision": 1,
                                "operation_id": preview["id"],
                            },
                        }
                    ],
                )
            else:
                answer = AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "preview-evening",
                            "name": "preview_plan_changes",
                            "args": {
                                "items": [
                                    {
                                        "session_id": data["session"],
                                        "revision": 1,
                                        "changes": {"target_duration_min": 25},
                                    }
                                ],
                            },
                        }
                    ],
                )
            self.messages = iter([answer])
            return await super()._agenerate(messages, **kwargs)

    monkeypatch.setattr(JevService, "decide", decide)
    monkeypatch.setattr(
        coaching, "build_chat_model", lambda **kwargs: Model(messages=iter([]))
    )
    monkeypatch.setattr("arete.services.inbox.publish", lambda *args: None)
    service.prepare_evening_replies(data["now"])
    run = service.claim(service.runs(data["item"]["id"])["items"][0]["id"])
    await coaching._run_automation(run)
    waiting = service.run_detail(run["id"])
    assert waiting["state"] == "waiting", waiting["error"]
    assert waiting["model_requests"] == 3
    assert (
        GarminRepository().get_planned_session(data["session"]).target_duration_min
        == 45
    )
    interrupt = waiting["interrupts"][0]
    assert interrupt["payload"]["name"] == "apply_plan_changes"
    service.decide(
        run["id"], interrupt["id"], interrupt["revision"], {"type": "approve"}
    )
    await coaching._run_automation(service.claim(run["id"]))
    done = service.run_detail(run["id"])
    assert done["state"] == "completed", done["error"]
    assert len(calls) == 1
    assert done["model_requests"] == 4
    assert (
        GarminRepository().get_planned_session(data["session"]).target_duration_min
        == 25
    )
    assert "25 minutes" in done["result"]
    assert any(effect["state"] == "completed" for effect in done["effects"])
    assert service.claim(run["id"]) is None
