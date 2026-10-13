"""The morning's decisions applied to the plan, once, and taken back."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest

from arete.dataio.db import connect
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import garmin_export, plan_adaptation
from arete.services.coaching_rules import RuleFacts

#: Far enough ahead that no other test's "today" reaches it.
DAY = date.today() + timedelta(days=700)


def _facts(readiness: float | None, source: str = "garmin_training") -> RuleFacts:
    return RuleFacts(
        acwr=1.0,
        tsb=-5.0,
        readiness_score=readiness,
        fatigue_threshold=85,
        fitness_goal="build",
        readiness_source=source,
        readiness_measured_on=DAY,
    )


@pytest.fixture
def tempo(monkeypatch):
    from arete.features.hr_zones import ZoneModel

    # Isolate athlete physiology from other tests editing the shared settings row.
    def zones():
        return ZoneModel.from_reference(lthr=170)

    monkeypatch.setattr("arete.dataio.settings.athlete_zone_model", zones)

    monkeypatch.setattr(plan_adaptation, "athlete_today", lambda: DAY)
    repo = GarminRepository()
    session_id = repo.create_planned_session(
        PlannedSession(
            date=DAY,
            sport="running",
            session_type=SessionType.TEMPO,
            target_duration_min=50,
            target_hr_zone="Z4",
            target_intensity="hard",
            # Undescribed: only then is the type's template the session itself.
        )
    )
    yield session_id
    con = connect()
    con.execute("DELETE FROM app.plan_decisions WHERE date = ?", [DAY])
    con.execute("DELETE FROM app.planned_sessions WHERE date = ?", [DAY])
    con.close()


def _adapt(readiness, **kwargs):
    with patch(
        "arete.services.coaching_rules.rule_facts", return_value=_facts(readiness)
    ):
        return plan_adaptation.adapt_today(DAY, **kwargs)


def test_a_middling_morning_eases_the_tempo_and_keeps_the_original(tempo):
    decisions = _adapt(70.0)
    assert [d.decision for d in decisions] == ["ease"]
    before = GarminRepository().get_planned_session(tempo)
    assert before.session_type == SessionType.TEMPO
    assert decisions[0].applied_at is None
    applied = plan_adaptation.respond(decisions[0].id, decisions[0].revision, "apply")
    assert applied.applied_at is not None
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None
    assert session.session_type == SessionType.ENDURANCE
    assert (session.target_hr_zone, session.target_duration_min) == ("Z2", 50)
    assert session.status == SessionStatus.MODIFIED
    assert decisions[0].original is not None
    assert decisions[0].original["session_type"] == "tempo"
    assert decisions[0].state == "pending"


def test_a_second_run_the_same_day_decides_nothing_new(tempo):
    _adapt(70.0)
    again = _adapt(30.0)  # a worse reading later must not stack a second decision
    assert [d.decision for d in again] == ["ease"]


def test_revert_restores_the_session(tempo):
    decision = _adapt(70.0)[0]
    plan_adaptation.respond(decision.id, decision.revision, "apply")
    reverted = plan_adaptation.revert(decision.id)
    assert reverted.reverted_at is not None
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None
    assert session.session_type == SessionType.TEMPO
    assert (session.target_hr_zone, session.status) == ("Z4", SessionStatus.PENDING)
    with pytest.raises(plan_adaptation.NothingToRevert):
        plan_adaptation.revert(decision.id)


def test_a_bad_morning_skips_the_session(tempo):
    proposal = _adapt(30.0)[0]
    assert proposal.decision == "rest"
    plan_adaptation.respond(proposal.id, proposal.revision, "apply")
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None and session.status == SessionStatus.SKIPPED


def test_a_low_day_with_two_sessions_keeps_one_recovery(tempo):
    endurance = GarminRepository().create_planned_session(
        PlannedSession(
            date=DAY,
            sport="running",
            session_type=SessionType.ENDURANCE,
            target_duration_min=60,
        )
    )
    decisions = {d.planned_session_id: d for d in _adapt(49.0)}
    assert decisions[tempo].decision == "replace_easy"
    assert decisions[endurance].decision == "rest"
    group = {d.id: d.revision for d in decisions.values()}
    plan_adaptation.respond(decisions[tempo].id, 1, "apply", group)
    repo = GarminRepository()
    recovery = repo.get_planned_session(tempo)
    assert recovery is not None and recovery.session_type == SessionType.RECOVERY
    assert recovery.target_duration_min == 30
    rested = repo.get_planned_session(endurance)
    assert rested is not None and rested.status == SessionStatus.SKIPPED


def test_the_switch_off_writes_nothing_unless_asked(tempo):
    with patch.object(plan_adaptation, "auto_adapt_enabled", return_value=False):
        assert [d.state for d in _adapt(30.0, respect_setting=True)] == ["pending"]
        assert [d.decision for d in _adapt(30.0, respect_setting=False)] == ["rest"]


def test_no_readiness_writes_nothing(tempo):
    assert _adapt(None) == []
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None and session.status == SessionStatus.PENDING


def test_an_adapted_session_still_matches_the_run(tempo):
    from arete.garmin.models import ActualSession
    from arete.garmin.sync import auto_match

    _adapt(70.0)
    run = ActualSession(date=DAY, sport="running", duration_sec=50 * 60)
    repo = GarminRepository()
    actual_id = repo.create_actual_session(run)
    try:
        assert auto_match(repo, actual_id, run) == tempo
    finally:
        con = connect()
        con.execute("DELETE FROM app.actual_sessions WHERE id = ?", [actual_id])
        con.close()


def test_the_old_api_refuses_implicit_application(tempo, router_client):
    from arete.api.plan import router

    client = router_client(router)
    assert client.post("/plan/today/adapt").status_code == 409
    proposal = _adapt(50.0)[0]
    assert client.post(f"/plan/decisions/{proposal.id}/revert").status_code == 409
    plan_adaptation.respond(proposal.id, proposal.revision, "apply")
    assert client.post(f"/plan/decisions/{proposal.id}/revert").status_code == 200
    assert client.post(f"/plan/decisions/{proposal.id}/revert").status_code == 409
    assert client.post("/plan/decisions/999999/revert").status_code == 404


@pytest.mark.parametrize(
    ("readiness", "decision", "description"),
    [
        (70.0, "ease", "Endurance 50' Z2 (séance d'origine : 3x10' au seuil)"),
        (
            50.0,
            "replace_easy",
            "Récupération 30' Z1 (séance d'origine : 3x10' au seuil)",
        ),
    ],
)
def test_an_eased_described_tempo_becomes_exportable_as_what_it_now_is(
    tempo, readiness, decision, description
):
    con = connect()
    con.execute(
        "UPDATE app.planned_sessions SET description=? WHERE id=?",
        ["3x10' au seuil", tempo],
    )
    con.close()
    # Read from the description first, then the adapted session's own template.
    assert garmin_export.inspect_session(tempo)["session"]["parsed"]
    proposal = _adapt(readiness)[0]
    assert proposal.decision == decision
    plan_adaptation.respond(proposal.id, proposal.revision, "apply")
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None and session.description == description
    view = garmin_export.inspect_session(tempo)["session"]
    assert view["exportable"] and view["derived"]
    assert garmin_export.export(tempo, client=_garmin())["workout_id"] == 1


def _garmin():
    from unittest.mock import MagicMock

    from test_garmin_export import Garmin

    client = Garmin()
    client.has_tokens = MagicMock(return_value=True)
    return client


def _writes(client) -> list[tuple[str, str]]:
    return [(m, path) for m, path, _ in client.calls if m != "GET"]


def _pushing(enabled: bool = True):
    return patch(
        "arete.services.plan_adaptation.get_user_settings",
        return_value={"push_to_garmin_enabled": enabled},
    )


def _session(session_type: SessionType, description: str | None = None, **fields):
    return GarminRepository().create_planned_session(
        PlannedSession(
            date=DAY,
            sport="running",
            session_type=session_type,
            target_duration_min=45,
            description=description,
            **fields,
        )
    )


def _explicit() -> int:
    from arete.services.prescriptions import Prescription, Step

    steps = Prescription(
        steps=[Step(kind="effort", duration_kind="seconds", value=600)]
    )
    return _session(
        SessionType.TEMPO, "Seuil 10'", prescription=steps.model_dump(mode="json")
    )


#: The ARE-98 acceptance session: its steps come from the description.
VMA = "VMA — 12×400 @3'33 r1'. Échauffement 20-25' + 4-6 strides, retour 15'"


def test_the_push_time_is_a_utc_instant_under_a_paris_session(
    tempo, monkeypatch, router_client
):
    from contextlib import contextmanager
    from datetime import UTC, datetime

    from arete.api.garmin import router
    from arete.dataio.db import db_connection

    # The Docker stack runs with TZ=Europe/Paris, which DuckDB adopts as its
    # session TimeZone. ICU caches the process zone, so set it on the session.
    @contextmanager
    def paris_connection(*args, **kwargs):
        with db_connection(*args, **kwargs) as con:
            con.execute("SET TimeZone='Europe/Paris'")
            yield con

    monkeypatch.setattr(garmin_export, "db_connection", paris_connection)
    monkeypatch.setattr(
        garmin_export, "utc_now", lambda: datetime(2026, 10, 9, 23, 1, tzinfo=UTC)
    )
    assert garmin_export.export(tempo, client=_garmin())["state"] == "scheduled"

    def listed() -> datetime:
        response = router_client(router).get(
            "/garmin/planned", params={"start_date": DAY, "end_date": DAY}
        )
        (session,) = [s for s in response.json() if s["id"] == tempo]
        # The browser reads an offset-less string as local time.
        wire = session["garmin_pushed_at"]
        assert wire.endswith(("Z", "+00:00")), wire
        return datetime.fromisoformat(wire)

    assert listed() == datetime(2026, 10, 9, 23, 1, tzinfo=UTC)
    # Rows pushed before this fix from Vercel hold naive UTC; Docker-pushed ones
    # (TZ=Europe/Paris) hold Paris time and read 1-2 h off, as accepted.
    con = connect()
    con.execute(
        "UPDATE app.planned_sessions SET garmin_pushed_at=TIMESTAMP '2026-10-08 06:30' "
        "WHERE id=?",
        [tempo],
    )
    con.close()
    assert listed() == datetime(2026, 10, 8, 6, 30, tzinfo=UTC)


def test_the_daily_push_sends_once_and_only_when_enabled(tempo):
    client = _garmin()
    with _pushing(False):
        assert plan_adaptation.push_today(client, DAY) == "disabled"
    assert client.calls == []
    with _pushing():
        assert plan_adaptation.push_today(client, DAY).startswith("1 sent")
        calls = len(client.calls)
        # Garmin holds it as it is: the second run sends no request at all.
        assert plan_adaptation.push_today(client, DAY) == "0 sent, 1 skipped, 0 failed"
    assert len(client.calls) == calls
    assert len(client.workouts) == len(client.schedules) == 1


def test_every_source_of_steps_reaches_the_watch_in_the_morning(tempo):
    parsed = _session(SessionType.INTERVALS, VMA)
    explicit = _explicit()
    client = _garmin()
    with _pushing():
        assert plan_adaptation.push_today(client, DAY) == "3 sent, 0 skipped, 0 failed"
    repo = GarminRepository()
    for session_id in (tempo, parsed, explicit):
        session = repo.get_planned_session(session_id)
        assert session is not None and session.garmin_pushed_at is not None
        assert session.garmin_workout_id is not None
        state = garmin_export.inspect_session(session_id)["export"]
        assert state is not None and state["state"] == "scheduled"
    # The parsed steps, not the type's template, went out for the VMA session.
    expected = garmin_export._payload(parsed)[0]
    session = repo.get_planned_session(parsed)
    assert session is not None and session.garmin_workout_id is not None
    sent = client.workouts[int(session.garmin_workout_id)]
    assert sent["workoutName"] == expected["workoutName"]
    assert sent["workoutSegments"] == expected["workoutSegments"]


def test_a_session_exported_by_hand_costs_no_request_in_the_morning(tempo):
    client = _garmin()
    garmin_export.export(tempo, client=client)  # the evening before, from Planning
    before = len(client.calls)
    with _pushing():
        assert plan_adaptation.push_today(client, DAY) == "0 sent, 1 skipped, 0 failed"
    assert len(client.calls) == before
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None and session.garmin_pushed_at is not None


def test_an_edited_session_is_replaced_in_place(tempo):
    client = _garmin()
    garmin_export.export(tempo, client=client)
    GarminRepository().update_planned_session_fields(tempo, target_duration_min=40)
    with _pushing():
        assert plan_adaptation.push_today(client, DAY).startswith("1 sent")
    assert _writes(client) == [
        ("POST", garmin_export.WORKOUT),
        ("POST", f"{garmin_export.SCHEDULE}/1"),
        ("PUT", f"{garmin_export.WORKOUT}/1"),
    ]


def test_an_unreadable_described_session_waits_for_its_steps(tempo):
    unread = _session(
        SessionType.INTERVALS,
        "VMA — 12×400 @3'33 r1'. Échauffement 20-25', puis à la sensation",
    )
    client = _garmin()
    with _pushing():
        assert plan_adaptation.push_today(client, DAY) == "1 sent, 1 skipped, 0 failed"
    view = garmin_export.inspect_session(unread)
    assert view["session"]["needs_steps"] and view["export"] is None
    assert len(client.workouts) == 1


@pytest.mark.parametrize("state", ["uncertain", "conflict", "working"])
def test_an_unsettled_export_is_never_retried_by_the_morning(tempo, state):
    client = _garmin()
    garmin_export.export(tempo, client=client)
    GarminRepository().update_planned_session_fields(tempo, target_duration_min=40)
    con = connect()
    con.execute(
        "UPDATE app.garmin_exports SET state=? WHERE session_id=?", [state, tempo]
    )
    con.close()
    before = len(client.calls)
    with _pushing():
        for _ in range(2):
            assert plan_adaptation.push_today(client, DAY).startswith(
                "0 sent, 1 skipped"
            )
    assert len(client.calls) == before


def test_an_ambiguous_morning_write_stays_uncertain(tempo):
    client = _garmin()
    client.fail = "create"  # Garmin created it, the answer was lost
    with _pushing():
        assert plan_adaptation.push_today(client, DAY) == "0 sent, 0 skipped, 1 failed"
        state = garmin_export.inspect_session(tempo)["export"]
        assert state is not None and state["state"] == "uncertain"
        before = len(client.calls)
        assert plan_adaptation.push_today(client, DAY).startswith("0 sent, 1 skipped")
    assert len(client.calls) == before and len(client.workouts) == 1


def test_the_morning_sends_three_sessions_under_one_budget(tempo, monkeypatch):
    for _ in range(3):
        _session(SessionType.ENDURANCE)
    client = _garmin()
    with _pushing():
        assert plan_adaptation.push_today(client, DAY) == "3 sent, 1 skipped, 0 failed"
    assert len(client.workouts) == 3
    # A shared deadline too close to finish a session's exchange sends nothing.
    monkeypatch.setattr(plan_adaptation, "MIN_SECONDS_PER_SESSION", 10_000)
    other = _garmin()
    with _pushing():
        assert plan_adaptation.push_today(other, DAY).startswith("0 sent")
    assert other.calls == []


def test_a_strength_session_is_not_pushed(tempo):
    strength = GarminRepository().create_planned_session(
        PlannedSession(
            date=DAY,
            sport="strength",
            session_type=SessionType.STRENGTH,
            target_duration_min=60,
        )
    )
    client = _garmin()
    with _pushing():
        assert plan_adaptation.push_today(client, DAY) == "1 sent, 1 skipped, 0 failed"
    assert not garmin_export.inspect_session(strength)["session"]["exportable"]


def test_a_skipped_session_on_garmin_is_withdrawn_in_the_morning(tempo):
    explicit = _explicit()
    client = _garmin()
    for session_id in (tempo, explicit):
        garmin_export.export(session_id, client=client)
        GarminRepository().update_planned_session_status(
            session_id, SessionStatus.SKIPPED
        )
    with _pushing():
        plan_adaptation.push_today(client, DAY)
    assert not client.workouts and not client.schedules
    for session_id in (tempo, explicit):
        state = garmin_export.inspect_session(session_id)["export"]
        assert state is not None and state["state"] == "removed"


def test_the_legacy_push_routes_are_retired(tempo, router_client):
    from arete.api.garmin import router

    client = router_client(router)
    assert client.get(f"/garmin/planned/{tempo}/structure").status_code in {404, 405}
    assert client.post(f"/garmin/planned/{tempo}/push").status_code in {404, 405}
