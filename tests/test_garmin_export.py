"""Outbound Garmin contracts with a stateful fake, including lost responses."""

import copy
import json
from datetime import date
from unittest.mock import patch

import pytest

from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main
from arete.garmin.repository import GarminRepository
from arete.garmin.workout_structure import NotPushable
from arete.garmin.workouts import convert
from arete.services import garmin_export as service
from arete.services.documents import DocumentError
from arete.services.prescriptions import Prescription, Step, Target


class Garmin:
    def __init__(self):
        self.calls = []
        self.workouts = {}
        self.schedules = {}
        self.fail = None
        self.on_create = None
        self.schedule_date_key = "calendarDate"
        self.nested_schedule_workout = True

    def workout_request(self, method, path, *, timeout, payload=None):
        assert 0 < timeout <= 15
        self.calls.append((method, path, copy.deepcopy(payload)))
        if self.fail == "read":
            raise ConnectionError("offline")
        if path == "/device-service/deviceregistration/devices":
            return [{"deviceId": 10, "displayName": "fēnix 8"}]
        if path.startswith("/workout-service/workouts?"):
            return list(self.workouts.values())
        if path.startswith("/calendar-service"):
            return {"calendarItems": list(self.schedules.values())}
        if path == "/workout-service/workout" and method == "POST":
            if self.on_create:
                self.on_create()
            identifier = len(self.workouts) + 1
            self.workouts[identifier] = {
                **copy.deepcopy(payload),
                "workoutId": identifier,
            }
            if self.fail == "create":
                self.fail = None
                raise TimeoutError("response lost after committed creation")
            return {"workoutId": identifier}
        if path.startswith("/workout-service/workout/"):
            identifier = int(path.rsplit("/", 1)[1])
            if identifier not in self.workouts:
                raise LookupError("404")
            if method == "GET":
                return copy.deepcopy(self.workouts[identifier])
            if method == "PUT":
                self.workouts[identifier] = copy.deepcopy(payload)
                return copy.deepcopy(payload)
            if method == "DELETE":
                del self.workouts[identifier]
                if self.fail == "delete":
                    self.fail = None
                    raise TimeoutError("deleted remotely")
                return {}
        if path.startswith("/workout-service/schedule/"):
            identifier = int(path.rsplit("/", 1)[1])
            if method == "POST":
                schedule_id = len(self.schedules) + 100
                record = {
                    "workoutId": identifier,
                    "workoutScheduleId": schedule_id,
                    "date": payload["date"],
                }
                self.schedules[schedule_id] = record
                if self.fail == "schedule":
                    self.fail = None
                    raise TimeoutError("response lost after committed schedule")
                return record
            if identifier not in self.schedules:
                raise LookupError("404")
            if method == "GET":
                record = copy.deepcopy(self.schedules[identifier])
                record[self.schedule_date_key] = record.pop("date")
                if self.nested_schedule_workout:
                    record["workout"] = {"workoutId": record.pop("workoutId")}
                return record
            if method == "DELETE":
                del self.schedules[identifier]
                return {}
        if path == "/device-service/devicemessage/messages":
            return {"accepted": True}
        raise AssertionError((method, path))


@pytest.fixture
def planned(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "export.duckdb"))
    main()
    prescription = Prescription(
        steps=[Step(kind="effort", duration_kind="seconds", value=1800)]
    )
    with db_connection() as con:
        identifier = con.execute(
            "INSERT INTO app.planned_sessions (date,sport,session_type,description,prescription) VALUES ('2027-01-12','running','endurance','Footing',?) RETURNING id",
            [prescription.model_dump_json()],
        ).fetchone()[0]
    return identifier


@pytest.mark.parametrize(
    "sport,identifier",
    [
        ("running", 1),
        ("cycling", 2),
        ("swimming", 4),
        ("strength", 5),
        ("walking", 17),
        ("hiking", 18),
    ],
)
def test_sport_conversion_preserves_workout_units(sport, identifier):
    step = Step(kind="effort", duration_kind="meters", value=400)
    if sport == "strength":
        step = Step(
            kind="effort",
            duration_kind="reps",
            value=8,
            exercise="Barbell Bench Press",
            weight_kg=60,
        )
    prescription = Prescription(
        steps=[step], pool_length_m=25 if sport == "swimming" else None
    )
    payload = convert(42, "Test", sport, prescription)
    assert payload["sportType"]["sportTypeId"] == identifier
    converted = payload["workoutSegments"][0]["workoutSteps"][0]
    assert converted["endConditionValue"] == (8 if sport == "strength" else 400)
    if sport == "strength":
        assert converted["weightValue"] == 60_000
        assert converted["stepOrder"] == 1
    if sport == "swimming":
        assert payload["poolLength"] == 25


def test_repeats_pace_and_secondary_targets():
    prescription = Prescription(
        steps=[
            Step(
                kind="repeat",
                repeat=6,
                steps=[
                    Step(
                        kind="effort",
                        duration_kind="meters",
                        value=400,
                        target=Target(kind="pace_sec_km", low=270, high=290),
                        secondary_target=Target(
                            kind="heart_rate_bpm", low=150, high=170
                        ),
                    ),
                    Step(kind="recovery", duration_kind="seconds", value=90),
                ],
            )
        ]
    )
    payload = convert(1, "6 x 400", "running", prescription)
    group = payload["workoutSegments"][0]["workoutSteps"][0]
    assert group["numberOfIterations"] == 6
    effort = group["workoutSteps"][0]
    assert effort["targetValueOne"] == pytest.approx(1000 / 290)
    assert effort["targetValueTwo"] == pytest.approx(1000 / 270)
    assert effort["secondaryTargetValueOne"] == 150


def test_export_and_repeat_do_not_duplicate_workout_or_date(planned):
    garmin = Garmin()
    result = service.export(planned, client=garmin)
    assert result["state"] == "scheduled", result
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    assert len(garmin.workouts) == len(garmin.schedules) == 1
    assert sum(method == "POST" for method, _, _ in garmin.calls) == 2


@pytest.mark.parametrize("date_key", ["calendarDate", "scheduledDate", "date"])
@pytest.mark.parametrize("nested", [True, False])
def test_schedule_response_variants_reconcile_without_duplicate(
    planned, date_key, nested
):
    garmin = Garmin()
    garmin.schedule_date_key = date_key
    garmin.nested_schedule_workout = nested
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    # Reproduce the persisted state left by the old date-only verifier.
    with db_connection() as con:
        con.execute(
            "UPDATE app.garmin_exports SET state='uncertain',remote_date=NULL,error=? WHERE session_id=?",
            ["'date'", planned],
        )
    count = len(garmin.calls)
    result = service.reconcile(planned, client=garmin)
    assert result["state"] == "ready", result
    assert result["remote_date"] == date(2027, 1, 12)
    assert result["error"] is None
    assert all(method == "GET" for method, _, _ in garmin.calls[count:])
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    assert sum(method == "POST" for method, _, _ in garmin.calls) == 2


@pytest.mark.parametrize("action", ["export", "reconcile", "remove"])
@pytest.mark.parametrize(
    "response,error",
    [
        ({"workoutId": 1}, "Date de programmation Garmin absente"),
        (
            {"workoutId": 1, "calendarDate": "bad"},
            "Date de programmation Garmin invalide",
        ),
        ({"workoutId": 1, "calendarDate": 123}, "Date de programmation Garmin absente"),
        ({"workoutId": 2, "calendarDate": "2027-01-12"}, "ne correspond pas"),
        (
            {"workoutId": 1, "workout": {"workoutId": 2}, "date": "2027-01-12"},
            "ne correspond pas",
        ),
        (
            {"workoutId": 1, "calendarDate": "2027-01-12", "date": "2027-01-13"},
            "Dates de programmation Garmin contradictoires",
        ),
    ],
)
def test_unverifiable_schedule_never_allows_remote_mutation(
    planned, monkeypatch, action, response, error
):
    garmin = Garmin()
    service.export(planned, client=garmin)
    if action == "remove":
        GarminRepository().delete_planned_session(planned)
    original = garmin.workout_request

    def readback(method, path, **kwargs):
        result = original(method, path, **kwargs)
        if method == "GET" and path.startswith(service.SCHEDULE):
            return response
        return result

    monkeypatch.setattr(garmin, "workout_request", readback)
    count = len(garmin.calls)
    result = getattr(service, action)(planned, client=garmin)
    assert result["state"] in {"failed", "uncertain"}
    assert error in result["error"]
    assert all(method == "GET" for method, _, _ in garmin.calls[count:])
    assert len(garmin.workouts) == len(garmin.schedules) == 1


@pytest.mark.parametrize("verified_before", [True, False])
@pytest.mark.parametrize("phase", ["scheduled", "unscheduling", "removing"])
def test_reconcile_preserves_real_remote_date_conflict(planned, verified_before, phase):
    garmin = Garmin()
    service.export(planned, client=garmin)
    garmin.schedules[100]["date"] = "2027-01-13"
    with db_connection() as con:
        con.execute(
            "UPDATE app.garmin_exports SET state='conflict',phase=? WHERE session_id=?",
            [phase, planned],
        )
        if not verified_before:
            con.execute(
                "UPDATE app.garmin_exports SET remote_date=NULL WHERE session_id=?",
                [planned],
            )
    count = len(garmin.calls)
    assert service.reconcile(planned, client=garmin)["state"] == "conflict"
    assert all(method == "GET" for method, _, _ in garmin.calls[count:])


@pytest.mark.parametrize("phase", ["create", "schedule"])
def test_lost_write_response_requires_reconciliation(planned, phase):
    garmin = Garmin()
    garmin.fail = phase
    result = service.export(planned, client=garmin)
    assert result["state"] == "uncertain"
    count = len(garmin.calls)
    with pytest.raises(DocumentError, match="indéterminé"):
        service.export(planned, client=garmin)
    assert len(garmin.calls) == count
    assert service.reconcile(planned, client=garmin)["state"] == "ready"
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    assert len(garmin.workouts) == len(garmin.schedules) == 1


def test_remote_conflict_never_overwrites(planned):
    garmin = Garmin()
    service.export(planned, client=garmin)
    garmin.workouts[1]["workoutName"] = "Changed in Connect"
    assert service.export(planned, client=garmin)["state"] == "conflict"
    assert garmin.workouts[1]["workoutName"] == "Changed in Connect"
    assert not any(method == "PUT" for method, _, _ in garmin.calls)


def test_changed_date_updates_same_workout_and_replaces_only_its_schedule(planned):
    garmin = Garmin()
    service.export(planned, client=garmin)
    prescription = Prescription(
        steps=[Step(kind="effort", duration_kind="seconds", value=2400)]
    )
    service.update_session(planned, 1, date(2027, 1, 13), "40 minutes", prescription)
    assert service.statuses()[0]["state"] == "dirty"
    result = service.export(planned, client=garmin)
    assert result["state"] == "scheduled", result
    assert len(garmin.workouts) == len(garmin.schedules) == 1
    assert next(iter(garmin.schedules.values()))["date"] == "2027-01-13"


def test_deleted_session_keeps_explicit_removal_task(planned):
    garmin = Garmin()
    service.export(planned, client=garmin)
    GarminRepository().delete_planned_session(planned)
    assert service.statuses()[0]["state"] == "pending_removal"
    assert garmin.workouts
    assert service.remove(planned, client=garmin)["state"] == "removed"
    assert not garmin.workouts and not garmin.schedules


def test_concurrent_export_cannot_create_second_workout(planned):
    garmin = Garmin()

    def attempt_duplicate():
        with pytest.raises(DocumentError, match="déjà en cours"):
            service.export(planned, client=garmin)

    garmin.on_create = attempt_duplicate
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    assert len(garmin.workouts) == 1


def test_model_is_not_used_and_transfer_does_not_claim_delivery(planned):
    garmin = Garmin()
    result = service.export(planned, device_id=10, client=garmin)
    assert result["state"] == "transfer_requested"
    assert len(garmin.calls) <= service.MAX_EXPORT_REQUESTS


def test_invalid_or_unrepresentable_prescription_has_no_remote_write(planned):
    garmin = Garmin()
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET sport='other' WHERE id=?", [planned]
        )
    with pytest.raises(ValueError, match="exportable"):
        service.export(planned, client=garmin)
    assert garmin.calls == []


def test_api_preserves_structured_planned_fields(planned):
    session = GarminRepository().get_planned_session(planned)
    assert session.prescription["steps"][0]["value"] == 1800
    assert session.revision == 1
    assert json.dumps(session.prescription)


def test_repeated_transfer_never_pushes_again_without_a_change(planned):
    garmin = Garmin()
    for _ in range(3):
        assert (
            service.export(planned, device_id=10, client=garmin)["state"]
            == "transfer_requested"
        )
    assert (
        sum(
            path == "/device-service/devicemessage/messages"
            for _, path, _ in garmin.calls
        )
        == 1
    )


def test_timeout_after_deletion_reconciles_without_a_second_delete(planned):
    garmin = Garmin()
    service.export(planned, client=garmin)
    GarminRepository().delete_planned_session(planned)
    garmin.fail = "delete"
    assert service.remove(planned, client=garmin)["state"] == "uncertain"
    with pytest.raises(DocumentError, match="indéterminé"):
        service.remove(planned, client=garmin)
    assert service.reconcile(planned, client=garmin)["state"] == "removed"
    assert not garmin.workouts and not garmin.schedules


def test_swim_main_and_butterfly_preserve_connect_enumerations():
    prescription = Prescription(
        pool_length_m=25,
        steps=[
            Step(kind="effort", duration_kind="meters", value=100, stroke="butterfly")
        ],
    )
    payload = convert(1, "Papillon", "swimming", prescription)
    step = payload["workoutSegments"][0]["workoutSteps"][0]
    assert step["stepType"] == {"stepTypeId": 8, "stepTypeKey": "main"}
    assert step["strokeType"] == {"strokeTypeId": 5, "strokeTypeKey": "fly"}
    prescription.steps[0].stroke = "mixed"
    with pytest.raises(ValueError, match="ordre"):
        convert(1, "Mixed", "swimming", prescription)


def test_reconciliation_fences_the_previous_worker(planned):
    old = service._claim(planned)
    with db_connection() as con:
        con.execute(
            "UPDATE app.garmin_exports SET updated_at=current_timestamp-INTERVAL '5 minutes' WHERE session_id=?",
            [planned],
        )
    new = service._claim(planned, reconcile=True)
    assert old["operation_id"] != new["operation_id"]
    with pytest.raises(DocumentError, match="récente"):
        service._update(planned, old["operation_id"], state="scheduled")
    exchange = service.Exchange(Garmin())
    exchange.reservation = (planned, old["operation_id"])
    with pytest.raises(DocumentError, match="réservation"):
        exchange.call("POST", service.WORKOUT, {})
    assert exchange.client.calls == []


def test_reviewed_prescription_bypasses_adaptation_but_reaches_the_watch(
    planned, monkeypatch
):
    from arete.services import plan_adaptation

    monkeypatch.setattr(plan_adaptation, "auto_adapt_enabled", lambda: True)
    monkeypatch.setattr(
        plan_adaptation, "get_user_settings", lambda: {"push_to_garmin_enabled": True}
    )
    assert plan_adaptation.adapt_today(date(2027, 1, 12)) == []
    garmin = Garmin()
    assert (
        plan_adaptation.push_today(garmin, date(2027, 1, 12))
        == "1 sent, 0 skipped, 0 failed"
    )
    # Its push time and ids, like any other session's: the card reads them.
    session = GarminRepository().get_planned_session(planned)
    assert session.prescription is not None and session.garmin_pushed_at is not None
    assert (session.garmin_workout_id, session.garmin_schedule_id) == ("1", "100")


def test_coach_move_marks_export_dirty_without_rewriting_prescription(planned):
    from arete.services import planning

    garmin = Garmin()
    service.export(planned, client=garmin)
    result = json.loads(
        planning.update_planned_session(
            planned, 1, planning.SessionChanges(date_str="2027-01-13")
        )
    )
    assert result["updated"]
    session = GarminRepository().get_planned_session(planned)
    assert session.date == date(2027, 1, 13)
    assert session.revision == 2
    assert service.statuses()[0]["state"] == "dirty"
    result = json.loads(
        planning.update_planned_session(
            planned, 2, planning.SessionChanges(target_duration_min=40)
        )
    )
    assert "prescription" in result["error"]
    assert (
        GarminRepository()
        .get_planned_session(planned)
        .prescription["steps"][0]["value"]
        == 1800
    )


def test_coach_skip_keeps_verified_export_instead_of_asking_a_resend(planned):
    from arete.services import planning

    garmin = Garmin()
    service.export(planned, client=garmin)
    result = json.loads(
        planning.update_planned_session(
            planned, 1, planning.SessionChanges(status="skipped")
        )
    )
    assert result["session"]["status"] == "skipped"
    assert not result["session"]["exportable"]
    assert result["export"]["state"] == "scheduled"
    assert result["export"]["error"] is None
    calls = len(garmin.calls)
    assert service.reconcile(planned, client=garmin)["state"] == "ready"
    assert not any(method != "GET" for method, _, _ in garmin.calls[calls:])


def test_daily_session_cannot_change_steps_during_upload(planned):
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET prescription=NULL,target_duration_min=30 WHERE id=?",
            [planned],
        )
    garmin = Garmin()

    def concurrent_edit():
        with pytest.raises(DocumentError, match="Réconcilie l’export"):
            service.update_session(
                planned,
                1,
                date(2027, 1, 12),
                "Test",
                Prescription(
                    steps=[Step(kind="effort", duration_kind="seconds", value=1800)]
                ),
            )

    garmin.on_create = concurrent_edit
    assert service.export(planned, client=garmin)["state"] == "scheduled"


def test_incomplete_daily_export_cannot_create_second_copy(planned):
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET garmin_workout_id='100' WHERE id=?",
            [planned],
        )
    garmin = Garmin()
    result = service.export(planned, client=garmin)
    assert result["state"] == "failed"
    assert "incomplet" in result["error"]
    assert garmin.calls == []


def test_conversation_creates_structured_session_without_import(planned):
    from arete.services import planning

    result = json.loads(
        planning.create_planned_session(
            "2027-01-14",
            "intervals",
            "6 × 400 m",
            prescription=Prescription.model_validate(
                {
                    "version": 1,
                    "steps": [
                        {
                            "kind": "repeat",
                            "repeat": 6,
                            "steps": [
                                {
                                    "kind": "effort",
                                    "duration_kind": "meters",
                                    "value": 400,
                                },
                                {
                                    "kind": "recovery",
                                    "duration_kind": "seconds",
                                    "value": 90,
                                },
                            ],
                        }
                    ],
                }
            ),
        )
    )
    identifier = result["session"]["id"]
    saved = GarminRepository().get_planned_session(identifier)
    assert saved.source == "coach" and saved.prescription and not saved.provenance
    view = service.inspect_session(identifier)
    assert view["session"]["exportable"] and not view["session"]["derived"]
    assert "400 m" in view["session"]["summary"]
    garmin = Garmin()
    updates = []
    result = service.export_batch(
        [identifier], client=garmin, on_progress=updates.append
    )
    assert result["results"][0]["state"] == "scheduled"
    assert updates[0]["export"]["state"] == "working"
    assert updates[-1]["export"]["state"] == "scheduled"
    assert all(e["session"]["id"] == identifier for e in updates)
    assert len(garmin.workouts) == len(garmin.schedules) == 1


def test_legacy_adoption_checks_content_and_reuses_copy(planned):
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET prescription=NULL,target_duration_min=30,garmin_workout_id='1',garmin_schedule_id='100' WHERE id=?",
            [planned],
        )
    garmin = Garmin()
    payload, day, _, _ = service._payload(planned)
    garmin.workouts[1] = {**payload, "description": "Ancien résumé", "workoutId": 1}
    garmin.schedules[100] = {
        "workoutId": 1,
        "workoutScheduleId": 100,
        "date": day.isoformat(),
    }
    result = service.export(planned, client=garmin)
    assert result["state"] == "scheduled"
    assert not any(method == "POST" for method, _, _ in garmin.calls)
    assert garmin.workouts[1]["description"] == f"ARETE_SESSION:{planned}"


def test_batch_stops_after_lost_response_and_reports_remaining(planned):
    from arete.services import planning

    next_id = json.loads(
        planning.create_planned_session(
            "2027-01-15", "endurance", target_duration_min=30
        )
    )["session"]["id"]
    garmin = Garmin()
    garmin.fail = "create"
    result = service.export_batch([planned, next_id], client=garmin)
    assert result["blocked"] == planned and result["not_attempted"] == [next_id]
    assert result["results"][0]["state"] == "uncertain"
    assert len(garmin.workouts) == 1
    count = len(garmin.calls)
    again = service.export_batch([planned, next_id], client=garmin)
    assert again["error"] and len(garmin.calls) == count


def test_stale_revision_and_expired_batch_never_write(planned):
    from time import monotonic

    garmin = Garmin()
    result = service.export_batch([planned], revisions=[2], client=garmin)
    assert result["error"] and not garmin.calls
    result = service.export_batch([planned], deadline=monotonic() - 1, client=garmin)
    assert result["error"] and not garmin.calls


@pytest.mark.parametrize("ids", [[], [1, 1], list(range(1, 7)), [-1]])
def test_invalid_batch_is_rejected_before_remote_io(ids, planned):
    garmin = Garmin()
    with pytest.raises(DocumentError):
        service.export_batch(ids, client=garmin)
    assert not garmin.calls


def test_prescription_edit_checks_revision_and_dirties_export(planned):
    garmin = Garmin()
    service.export(planned, client=garmin)
    from arete.agent.tools.planning import update_planned_session

    args = dict(
        session_id=planned,
        revision=1,
        date_str="2027-01-13",
        description="40 minutes",
        prescription={
            "steps": [{"kind": "effort", "duration_kind": "seconds", "value": 2400}]
        },
    )
    result = json.loads(
        update_planned_session.invoke(
            {
                "session_id": args["session_id"],
                "revision": args["revision"],
                "changes": {
                    k: v for k, v in args.items() if k not in {"session_id", "revision"}
                },
            }
        )
    )
    assert result["session"]["revision"] == 2
    assert service.inspect_session(planned)["export"]["state"] == "dirty"
    count = len(garmin.calls)
    assert json.loads(
        update_planned_session.invoke(
            {
                "session_id": args["session_id"],
                "revision": args["revision"],
                "changes": {
                    k: v for k, v in args.items() if k not in {"session_id", "revision"}
                },
            }
        )
    )["error"]
    assert len(garmin.calls) == count


def test_daily_and_chat_share_export_reservation(planned, monkeypatch):
    from arete.services import plan_adaptation

    monkeypatch.setattr(
        plan_adaptation, "get_user_settings", lambda: {"push_to_garmin_enabled": True}
    )

    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET prescription=NULL,target_duration_min=30 WHERE id=?",
            [planned],
        )
    garmin = Garmin()

    def concurrent_push():
        # The morning run leaves an export in flight alone, without a request.
        calls = len(garmin.calls)
        assert plan_adaptation.push_today(garmin, date(2027, 1, 12)).startswith(
            "0 sent, 1 skipped"
        )
        assert len(garmin.calls) == calls
        with pytest.raises(DocumentError, match="déjà en cours"):
            service.export(planned, client=Garmin())
        from arete.services import planning

        result = json.loads(
            planning.update_planned_session(
                planned, 1, planning.SessionChanges(status="skipped")
            )
        )
        assert result["error"]

    garmin.on_create = concurrent_push
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    assert len(garmin.workouts) == 1


def test_skipped_daily_withdrawal_uses_same_reservation(planned):
    from arete.garmin.models import SessionStatus

    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET prescription=NULL,target_duration_min=30 WHERE id=?",
            [planned],
        )
    garmin = Garmin()
    service.export(planned, client=garmin)
    GarminRepository().update_planned_session_status(planned, SessionStatus.SKIPPED)
    assert service.withdraw_skipped(planned, client=garmin)["state"] == "removed"
    assert not garmin.workouts and not garmin.schedules


def test_strength_prescription_requires_grammar_source(planned):
    from arete.services import planning

    result = json.loads(
        planning.create_planned_session(
            "2027-01-15",
            "strength",
            sport="strength",
            prescription=Prescription(
                steps=[
                    Step(kind="effort", duration_kind="reps", value=8, exercise="Squat")
                ]
            ),
        )
    )
    assert "texte exact" in result["error"]


def test_graph_streams_domain_progress_before_final_answer(planned, monkeypatch):
    import asyncio

    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from arete.agent.capabilities.discovery import authorized_tools
    from arete.agent.middlewares.capabilities import ToolkitMiddleware
    from arete.agent.middlewares.events import ToolEventMiddleware
    from arete.agent.runtime.context import AgentContext
    from arete.agent.runtime.execution import stream_agent
    from arete.agent.runtime.streaming import StreamProjection

    garmin = Garmin()
    monkeypatch.setattr("arete.garmin.client.GarminClient", lambda: garmin)

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    async def run():
        graph = create_agent(
            Model(
                disable_streaming=True,
                messages=iter(
                    [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "export_garmin_sessions",
                                    "args": {"session_ids": [planned]},
                                    "id": "export-1",
                                    "type": "tool_call",
                                }
                            ],
                        ),
                        AIMessage(content="La séance est programmée."),
                    ]
                ),
            ),
            tools=authorized_tools("chat"),
            middleware=[ToolkitMiddleware(), ToolEventMiddleware()],
            context_schema=AgentContext,
        )
        projection = StreamProjection()
        events = []
        async for part in stream_agent(
            graph,
            {"messages": [{"role": "user", "content": "Envoie ma séance sur Garmin"}]},
            context=AgentContext(thread_id="test-workouts"),
        ):
            events.extend(projection.events(part))
        events.append(projection.done())
        return events

    events = asyncio.run(run())
    updates = [e for e in events if e["type"] == "workout_update"]
    assert updates and updates[0]["export"]["state"] == "working"
    assert updates[-1]["export"]["state"] == "scheduled"
    assert all(
        e["id"] == "export-1" and e["thread_id"] == "test-workouts" for e in updates
    )
    assert events.index(updates[-1]) < next(
        i
        for i, e in enumerate(events)
        if e["type"] == "message" and e["text"] == "La séance est programmée."
    )
    assert len(garmin.workouts) == 1


def test_workout_http_detail_and_batch_revision_contract(
    planned, router_client, monkeypatch
):
    from arete.api.garmin_export import router

    client = router_client(router)
    detail = client.get(f"/garmin/planned/{planned}/workout")
    assert detail.status_code == 200
    assert detail.json()["session"]["revision"] == 1
    assert detail.json()["session"]["prescription"]["version"] == 1
    garmin = Garmin()
    original = service.export_batch
    monkeypatch.setattr(
        service,
        "export_batch",
        lambda ids, device_id, **kwargs: original(
            ids, device_id, client=garmin, **kwargs
        ),
    )
    stale = client.post(
        "/garmin/exports/batch", json={"session_ids": [planned], "revisions": [2]}
    )
    assert stale.status_code == 200
    assert stale.json()["blocked"] == planned
    assert not garmin.calls
    valid = client.post(
        "/garmin/exports/batch", json={"session_ids": [planned], "revisions": [1]}
    )
    assert valid.status_code == 200
    result = valid.json()["results"][0]
    assert result["state"] == "scheduled"
    assert result["operation_id"] and result["updated_at"]
    assert "intended_payload" not in result
    oversized = client.post(
        "/garmin/exports/batch",
        json={"session_ids": list(range(1, 7)), "revisions": [1] * 6},
    )
    assert oversized.status_code == 422


def test_workout_cards_are_read_in_one_bounded_request(planned, router_client):
    from arete.api.garmin_export import router

    client = router_client(router)
    detail = client.get(f"/garmin/planned/{planned}/workout").json()
    batch = client.get("/garmin/workouts", params={"ids": [planned, 999_999, planned]})
    assert batch.status_code == 200
    # Duplicates collapse; a deleted session is reported without hiding the others.
    assert batch.json() == {
        "workouts": [detail],
        "errors": {"999999": "Cette séance n’existe plus."},
    }
    assert client.get("/garmin/workouts").status_code == 422
    assert client.get("/garmin/workouts", params={"ids": [0]}).status_code == 422
    oversized = {"ids": list(range(1, service.MAX_INSPECT_SESSIONS + 2))}
    assert client.get("/garmin/workouts", params=oversized).status_code == 422


def test_strength_text_creates_and_exports_sets_weights_and_rests(planned):
    from arete.services import planning

    result = json.loads(
        planning.create_planned_session(
            "2027-01-15",
            "strength",
            "Renfo jambes",
            sport="strength",
            strength_text="Squat 3x10 20kg r1'30\nFentes 2x12",
        )
    )
    assert result.get("created"), result
    identifier = result["session"]["id"]
    view = service.inspect_session(identifier)["session"]
    assert view["exportable"] and not view["derived"], view
    steps = view["prescription"]["steps"]
    assert [s["value"] for s in steps if s["kind"] == "rest"] == [90, 90, 90]
    garmin = Garmin()
    result = service.export_batch([identifier], client=garmin)
    assert result["results"][0]["state"] == "scheduled", result
    workout = next(iter(garmin.workouts.values()))
    assert workout["sportType"]["sportTypeKey"] == "strength_training"
    exported = workout["workoutSegments"][0]["workoutSteps"]
    efforts = [s for s in exported if s["endCondition"]["conditionTypeKey"] == "reps"]
    assert [s["endConditionValue"] for s in efforts] == [10, 10, 10, 12, 12]
    assert efforts[0]["exerciseName"] == "BARBELL_BACK_SQUAT"
    assert efforts[0]["weightValue"] == 20_000  # Garmin stores grams.
    assert efforts[-1].get("weightValue") is None
    assert not any(s["category"] == "RUNNING" for s in efforts)


@pytest.mark.parametrize(
    "text", ["", "Renfo jambes", "Squat 3x10 20kg\nExercice inventé 3x10"]
)
def test_incomplete_strength_creation_does_not_persist(planned, text):
    from arete.services import planning

    before = planning.list_planned("2027-01-01", "2027-01-31")
    result = json.loads(
        planning.create_planned_session(
            "2027-01-15",
            "strength",
            "Renfo jambes",
            sport="strength",
            strength_text=text,
        )
    )
    assert "error" in result
    assert planning.list_planned("2027-01-01", "2027-01-31") == before


def test_unstructured_strength_explains_missing_steps_not_unsupported_sport(planned):
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET sport='strength',prescription=NULL WHERE id=?",
            [planned],
        )
    view = service.inspect_session(planned)["session"]
    assert not view["exportable"]
    assert "exercices et séries" in view["reason"]
    garmin = Garmin()
    with pytest.raises(DocumentError, match="exercices et séries"):
        service.export(planned, client=garmin)
    assert not garmin.calls


@pytest.mark.parametrize("async_mode", [False, True])
def test_read_then_strength_action_only_emits_the_created_workout(
    planned, monkeypatch, async_mode
):
    import asyncio
    from dataclasses import replace

    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from arete.agent.context import sections
    from arete.agent.factory import build_agent
    from arete.agent.profiles.catalog import get_profile
    from arete.agent.runtime.context import PANEL_CONTEXT_KEY, AgentContext
    from arete.agent.runtime.execution import run_config
    from arete.services import planning

    page_reads = []

    def page_data(page, **kwargs):
        result = json.loads(planning.list_planned("2027-01-01", "2027-01-31"))
        page_reads.append(result)
        return result

    monkeypatch.setattr(sections, "get_page_data", page_data)
    seen_tools = []

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            seen_tools.append({t.name for t in tools})
            return self

    def call(name, args, identifier):
        return AIMessage(
            content="", tool_calls=[{"name": name, "args": args, "id": identifier}]
        )

    graph = build_agent(
        replace(get_profile("chat"), journal_tools=False, filesystem_tools=False),
        model=Model(
            disable_streaming=True,
            messages=iter(
                [
                    call(
                        "list_planned",
                        {"start_date": "2027-01-01", "end_date": "2027-01-31"},
                        "read",
                    ),
                    call("inspect_planned_session", {"session_id": planned}, "inspect"),
                    call(
                        "create_planned_session",
                        {
                            "date_str": "2027-01-15",
                            "session_type": "strength",
                            "sport": "strength",
                            "strength_text": "Squat 3x10 20kg",
                            "description": "Renfo jambes",
                        },
                        "create",
                    ),
                    AIMessage(content="Séance créée."),
                ]
            ),
        ),
        context_tokens=65536,
        output_tokens=4096,
        filesystem=AgentMiddleware(),
    )
    context = AgentContext(source={PANEL_CONTEXT_KEY: '{"page":"planning"}'})
    state = {"messages": [{"role": "user", "content": "Prépare une musculation"}]}
    config = run_config(context=context)

    async def collect():
        return [
            event
            async for event in graph.astream(
                state, context=context, config=config, stream_mode="custom"
            )
        ]

    events = (
        asyncio.run(collect())
        if async_mode
        else list(
            graph.stream(state, context=context, config=config, stream_mode="custom")
        )
    )
    updates = [e for e in events if e["type"] == "workout_update"]
    assert len(updates) == 1
    assert updates[0]["id"] == "create" and updates[0]["session"]["sport"] == "strength"
    assert updates[0]["session"]["id"] != planned
    assert len(page_reads) == 2  # Initial page plus one refresh after the write.
    assert len(page_reads[-1]["sessions"]) == len(page_reads[0]["sessions"]) + 1
    assert all("get_page_context" not in names for names in seen_tools)
    assert context.stats.model_calls == 4 and context.stats.tool_calls == 3


INTERVALS = "VMA — 12×400 @3'33 r1'. Échauffement 20-25' + 4-6 strides, retour 15'"
# The grammar reads READ for a run; UNREAD keeps a fragment it cannot.
READ = "Échauffement 20-25' + 4-6 strides, 12×400 @3'33 r1', retour 15'"
UNREAD = "VMA — 12×400 @3'33 r1'. Échauffement 20-25', puis à la sensation"


def _without_steps(planned, session_type, description, sport="running", structure=None):
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET sport=?,session_type=?,description=?,structure_json=?,prescription=NULL,target_duration_min=50 WHERE id=?",
            [sport, session_type, description, structure, planned],
        )


@pytest.mark.parametrize(
    "session_type,sport,description",
    [
        ("intervals", "running", UNREAD),
        # Only running notation is read: a cycling description stays blocked.
        ("tempo", "cycling", INTERVALS),
    ],
)
def test_described_structured_session_never_reaches_garmin_as_the_template(
    planned, router_client, monkeypatch, session_type, sport, description
):
    from arete.api.garmin_export import router
    from arete.services import plan_adaptation

    _without_steps(planned, session_type, description, sport)
    view = service.inspect_session(planned)["session"]
    # The template stays visible, labelled as an estimate, but cannot be sent.
    assert view["derived"] and view["needs_steps"] and view["prescription"]
    assert not view["exportable"]
    assert "prescription.steps via update_planned_session" in view["reason"]
    garmin = Garmin()
    with pytest.raises(DocumentError, match="Séance décrite sans étapes"):
        service.export(planned, client=garmin)
    monkeypatch.setattr(
        plan_adaptation, "get_user_settings", lambda: {"push_to_garmin_enabled": True}
    )
    assert plan_adaptation.push_today(garmin, date(2027, 1, 12)).startswith(
        "0 sent, 1 skipped"
    )
    original = service.export_batch
    monkeypatch.setattr(
        service,
        "export_batch",
        lambda ids, device_id, **kwargs: original(
            ids, device_id, client=garmin, **kwargs
        ),
    )
    response = router_client(router).post(
        "/garmin/exports/batch", json={"session_ids": [planned], "revisions": [1]}
    )
    assert response.json()["blocked"] == planned
    assert not garmin.calls


def test_read_description_exports_its_steps_instead_of_the_template(planned):
    from arete.services import plan_adaptation
    from arete.services.prescriptions import prescription_from_description

    _without_steps(planned, "intervals", READ)
    parsed = prescription_from_description(READ, "running")
    assert parsed is not None
    view = service.inspect_session(planned)["session"]
    assert view["parsed"] and not view["derived"] and not view["needs_steps"]
    assert view["exportable"] and view["reason"] is None
    assert view["prescription"] == parsed.model_dump(mode="json")
    garmin = Garmin()
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    (workout,) = garmin.workouts.values()
    assert workout == {
        **convert(planned, READ, "running", parsed),
        "workoutId": workout["workoutId"],
    }
    strides = workout["workoutSegments"][0]["workoutSteps"][1]
    assert strides["numberOfIterations"] == 4
    assert [
        (s["endCondition"]["conditionTypeKey"], "endConditionValue" in s)
        for s in strides["workoutSteps"]
    ] == [("lap.button", False), ("lap.button", False)]
    # The daily push finds Garmin holding these steps: no second request.
    calls = len(garmin.calls)
    with patch.object(
        plan_adaptation,
        "get_user_settings",
        return_value={"push_to_garmin_enabled": True},
    ):
        assert plan_adaptation.push_today(garmin, date(2027, 1, 12)).startswith(
            "0 sent, 1 skipped"
        )
    assert len(garmin.calls) == calls
    # The athlete's steps, once saved, take over from the description.
    service.update_session(planned, 1, date(2027, 1, 12), READ, parsed)
    view = service.inspect_session(planned)["session"]
    assert not view["parsed"] and not view["derived"]


def test_completed_steps_export_instead_of_the_template(planned):
    _without_steps(planned, "intervals", INTERVALS)
    steps = Prescription(
        steps=[
            Step(
                kind="repeat",
                repeat=12,
                steps=[
                    Step(kind="effort", duration_kind="meters", value=400),
                    Step(kind="recovery", duration_kind="seconds", value=60),
                ],
            )
        ]
    )
    service.update_session(planned, 1, date(2027, 1, 12), INTERVALS, steps)
    view = service.inspect_session(planned)["session"]
    assert view["exportable"] and not view["derived"] and not view["needs_steps"]
    garmin = Garmin()
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    (workout,) = garmin.workouts.values()
    assert workout == {
        **convert(planned, INTERVALS, "running", steps),
        "workoutId": workout["workoutId"],
    }


@pytest.mark.parametrize(
    "session_type,description,structure",
    [
        ("endurance", None, None),
        ("endurance", "Footing", None),
        ("intervals", None, None),
        ("intervals", INTERVALS, '[{"kind": "interval", "duration_sec": 600}]'),
    ],
)
def test_template_still_exports_when_nothing_contradicts_it(
    planned, session_type, description, structure
):
    _without_steps(planned, session_type, description, structure=structure)
    view = service.inspect_session(planned)["session"]
    assert view["exportable"] and view["derived"] and not view["needs_steps"], view
    assert service.export(planned, client=Garmin())["state"] == "scheduled"


@pytest.mark.parametrize("sport", ["running", "cycling"])
def test_coach_cannot_create_structured_session_without_steps(planned, sport):
    from arete.services import planning

    before = planning.list_planned("2027-01-01", "2027-01-31")
    result = json.loads(
        planning.create_planned_session(
            "2027-01-15", "intervals", UNREAD, sport=sport, target_duration_min=50
        )
    )
    assert "prescription.steps" in result["error"]
    assert planning.list_planned("2027-01-01", "2027-01-31") == before
    # Without a description the template is the session itself.
    result = json.loads(
        planning.create_planned_session(
            "2027-01-15", "intervals", sport=sport, target_duration_min=50
        )
    )
    assert result["created"]
    # A run description the grammar reads entirely is its own steps.
    result = json.loads(
        planning.create_planned_session(
            "2027-01-15", "intervals", READ, sport=sport, target_duration_min=50
        )
    )
    assert ("created" in result) == (sport == "running"), result


@pytest.mark.parametrize(
    "description,changes,allowed",
    [
        (None, {"description": "Seuil : 3×10' en côte"}, False),
        (None, {"description": "Seuil : 3×10'"}, True),
        (None, {"target_duration_min": 60}, True),
        (UNREAD, {"description": ""}, True),
        (UNREAD, {"session_type": "endurance"}, True),
        (UNREAD, {"target_duration_min": 60}, False),
        # Moving a session that predates the rule does not require rewriting it.
        (UNREAD, {"date_str": "2027-01-13"}, True),
    ],
)
def test_coach_update_is_judged_on_the_session_it_would_save(
    planned, description, changes, allowed
):
    from arete.services import planning

    _without_steps(planned, "tempo", description)
    result = json.loads(
        planning.update_planned_session(planned, 1, planning.SessionChanges(**changes))
    )
    session = GarminRepository().get_planned_session(planned)
    if allowed:
        assert result["updated"], result
    else:
        assert "prescription.steps" in result["error"]
        assert session.description == description and session.revision == 1


@pytest.mark.parametrize("description", [UNREAD, READ])
def test_template_sent_before_the_guard_can_still_be_withdrawn(planned, description):
    from arete.dataio.settings import athlete_zone_model
    from arete.garmin.models import SessionStatus
    from arete.garmin.workout_structure import derive
    from arete.garmin.workouts import build_payload

    _without_steps(planned, "intervals", description)
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET garmin_workout_id='1',garmin_schedule_id='100' WHERE id=?",
            [planned],
        )
    session = GarminRepository().get_planned_session(planned)
    # What the daily push sent before the guard: the type's template.
    payload = build_payload(
        derive(session, athlete_zone_model(), None),
        name=f"Arete — {description}",
        description=f"ARETE_SESSION:{planned}",
        sport="running",
    )
    day = session.date
    garmin = Garmin()
    garmin.workouts[1] = {**payload, "workoutId": 1}
    garmin.schedules[100] = {
        "workoutId": 1,
        "workoutScheduleId": 100,
        "date": day.isoformat(),
    }
    if description == UNREAD:
        with pytest.raises(NotPushable):
            service._payload(planned)
    GarminRepository().update_planned_session_status(planned, SessionStatus.SKIPPED)
    assert service.withdraw_skipped(planned, client=garmin)["state"] == "removed"
    assert not garmin.workouts and not garmin.schedules


@pytest.mark.parametrize("source", ["explicit", "parsed"])
def test_a_skipped_session_is_withdrawn_whatever_its_steps(planned, source):
    from arete.garmin.models import SessionStatus

    if source == "parsed":
        _without_steps(planned, "intervals", READ)
    garmin = Garmin()
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    assert service.on_garmin(planned)
    GarminRepository().update_planned_session_status(planned, SessionStatus.SKIPPED)
    assert service.withdraw_skipped(planned, client=garmin)["state"] == "removed"
    assert not garmin.workouts and not garmin.schedules
    assert not service.on_garmin(planned)
    session = GarminRepository().get_planned_session(planned)
    assert session.garmin_workout_id is None and session.garmin_pushed_at is None


def test_only_a_skipped_session_is_withdrawn(planned):
    garmin = Garmin()
    service.export(planned, client=garmin)
    with pytest.raises(DocumentError, match="séances sautées"):
        service.withdraw_skipped(planned, client=garmin)
    assert len(garmin.workouts) == 1


@pytest.mark.parametrize("limit", ["requests", "deadline"])
def test_a_write_the_budget_refuses_is_failed_not_uncertain(planned, limit):
    from time import monotonic

    garmin = Garmin()
    exchange = (
        service.Exchange(garmin, max_calls=0)
        if limit == "requests"
        # Less than a write's whole timeout left: the write is never sent.
        else service.Exchange(
            garmin, deadline=monotonic() + service.REQUEST_TIMEOUT / 2
        )
    )
    state = service.export(planned, exchange=exchange)
    assert state["state"] == "failed" and "Limite" in state["error"]
    assert garmin.calls == []
    # Nothing was written: the next attempt simply sends it.
    assert service.export(planned, client=garmin)["state"] == "scheduled"
    assert len(garmin.workouts) == 1


def test_a_budget_refusal_after_a_sent_write_stays_uncertain(planned):
    garmin = Garmin()
    service.export(planned, client=garmin)
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET date='2027-01-13' WHERE id=?", [planned]
        )
    # Three reads, then the old schedule's DELETE is sent and its readback
    # refused: whether Garmin removed it is unverified.
    exchange = service.Exchange(garmin, max_calls=4)
    state = service.export(planned, exchange=exchange)
    assert state["state"] == "uncertain"
    assert [m for m, _, _ in garmin.calls[-4:]] == ["GET", "GET", "GET", "DELETE"]


def test_the_removal_route_withdraws_a_skipped_session_only(planned, router_client):
    from arete.api.garmin_export import router
    from arete.garmin.models import SessionStatus

    garmin = Garmin()
    service.export(planned, client=garmin)
    client = router_client(router)
    original = service.remove
    with patch.object(
        service, "remove", lambda session_id: original(session_id, client=garmin)
    ):
        with pytest.raises(DocumentError, match="supprimées ou sautées"):
            client.post(f"/garmin/exports/{planned}/remove")
        assert len(garmin.workouts) == 1
        GarminRepository().update_planned_session_status(planned, SessionStatus.SKIPPED)
        removed = client.post(f"/garmin/exports/{planned}/remove").json()
    assert removed["state"] == "removed"
    assert not garmin.workouts and not garmin.schedules


def _legacy_copy(planned) -> Garmin:
    """A template sent before the export table: ids on the session only."""
    from arete.dataio.settings import athlete_zone_model
    from arete.garmin.workout_structure import derive
    from arete.garmin.workouts import build_payload

    _without_steps(planned, "endurance", "Footing")
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET garmin_workout_id='1',garmin_schedule_id='100' WHERE id=?",
            [planned],
        )
    session = GarminRepository().get_planned_session(planned)
    payload = build_payload(
        derive(session, athlete_zone_model(), None),
        name="Arete — Footing",
        description=f"ARETE_SESSION:{planned}",
        sport="running",
    )
    garmin = Garmin()
    garmin.workouts[1] = {**payload, "workoutId": 1}
    garmin.schedules[100] = {
        "workoutId": 1,
        "workoutScheduleId": 100,
        "date": session.date.isoformat(),
    }
    return garmin


@pytest.mark.parametrize("row", ["none", "empty"])
def test_the_removal_route_withdraws_a_legacy_copy_of_a_skipped_session(
    planned, router_client, row
):
    from arete.api.garmin_export import router
    from arete.garmin.models import SessionStatus

    garmin = _legacy_copy(planned)
    GarminRepository().update_planned_session_status(planned, SessionStatus.SKIPPED)
    if row == "empty":  # left by a claim that sent nothing
        state = service._claim(planned)
        service._update(planned, state["operation_id"], state="failed")
    with patch("arete.garmin.client.GarminClient", return_value=garmin):
        removed = router_client(router).post(f"/garmin/exports/{planned}/remove")
    assert removed.json()["state"] == "removed"
    assert not garmin.workouts and not garmin.schedules
    assert ("DELETE", f"{service.WORKOUT}/1", None) in garmin.calls


def test_no_export_row_for_another_athletes_session(planned):
    from arete.services.athlete_scope import athlete_scope

    with db_connection() as con:
        con.execute("INSERT INTO app.athletes(id) VALUES (9001) ON CONFLICT DO NOTHING")
    with athlete_scope(9001), db_connection() as con:
        foreign = con.execute(
            "INSERT INTO app.planned_sessions (date,sport,session_type,target_duration_min) "
            "VALUES ('2027-01-12','running','endurance',30) RETURNING id"
        ).fetchone()[0]
    garmin = Garmin()
    for attempt in (
        lambda: service.remove(foreign, client=garmin),
        lambda: service.export(foreign, client=garmin),
        lambda: service._claim(foreign),
    ):
        with pytest.raises(DocumentError):
            attempt()
    with db_connection() as con:
        rows = con.execute(
            "SELECT count(*) FROM app.garmin_exports WHERE session_id=?", [foreign]
        ).fetchone()[0]
    assert rows == 0 and garmin.calls == []


def _moved(planned, garmin) -> None:
    """A sent session moved to another day: its old schedule must go."""
    service.export(planned, client=garmin)
    with db_connection() as con:
        con.execute(
            "UPDATE app.planned_sessions SET date='2027-01-13' WHERE id=?", [planned]
        )
    garmin.calls.clear()


def test_a_reservation_taken_before_a_write_sends_nothing(planned):
    garmin = Garmin()
    _moved(planned, garmin)
    answer = garmin.workout_request

    def overtaken(method, path, *, timeout, payload=None):
        result = answer(method, path, timeout=timeout, payload=payload)
        if len(garmin.calls) == 3:  # a reconcile claims it before the DELETE
            with db_connection() as con:
                con.execute(
                    "UPDATE app.garmin_exports SET operation_id='other' WHERE session_id=?",
                    [planned],
                )
        return result

    garmin.workout_request = overtaken
    # The stale worker may not write over the newer owner's state.
    with pytest.raises(DocumentError, match="plus récente"):
        service.export(planned, exchange=service.Exchange(garmin))
    assert [m for m, _, _ in garmin.calls] == ["GET", "GET", "GET"]
    state = service.export_state(planned)
    assert state["operation_id"] == "other" and state["state"] != "uncertain"


@pytest.mark.parametrize(
    ("refused", "expected"), [("GET", "failed"), ("DELETE", "uncertain")]
)
def test_a_permission_error_is_uncertain_only_once_a_write_left(
    planned, refused, expected
):
    garmin = Garmin()
    _moved(planned, garmin)
    answer = garmin.workout_request

    def forbidden(method, path, *, timeout, payload=None):
        if method == refused:
            garmin.calls.append((method, path, payload))
            raise PermissionError("403")
        return answer(method, path, timeout=timeout, payload=payload)

    garmin.workout_request = forbidden
    assert service.export(planned, client=garmin)["state"] == expected


def test_an_automatic_resend_follows_the_latest_manual_choice_of_watch(planned):
    garmin = Garmin()
    assert service.export(planned, 10, client=garmin)["state"] == "transfer_requested"
    stale = service.prepare(planned)  # read while the copy was on the watch
    assert stale[0]["export"]["device_id"] == 10
    assert service.export(planned, None, client=garmin)["state"] == "scheduled"
    garmin.calls.clear()
    result = service.export(planned, client=garmin, prepared=stale, keep_device=True)
    assert result["state"] == "scheduled" and result["device_id"] is None
    assert all("devicemessage" not in path for _, path, _ in garmin.calls)
