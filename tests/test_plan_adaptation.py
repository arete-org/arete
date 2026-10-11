"""The morning's decisions applied to the plan, once, and taken back."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest

from arete.dataio.db import connect
from arete.garmin.models import PlannedSession, SessionStatus, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import plan_adaptation
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
    monkeypatch.setattr("arete.services.plan_adaptation.athlete_zone_model", zones)
    repo = GarminRepository()
    session_id = repo.create_planned_session(
        PlannedSession(
            date=DAY,
            sport="running",
            session_type=SessionType.TEMPO,
            target_duration_min=50,
            target_hr_zone="Z4",
            target_intensity="hard",
            description="3x10' au seuil",
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
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None
    assert session.session_type == SessionType.ENDURANCE
    assert (session.target_hr_zone, session.target_duration_min) == ("Z2", 50)
    assert session.status == SessionStatus.MODIFIED
    assert decisions[0].original is not None
    assert decisions[0].original["session_type"] == "tempo"
    assert decisions[0].applied_at is not None


def test_a_second_run_the_same_day_decides_nothing_new(tempo):
    _adapt(70.0)
    again = _adapt(30.0)  # a worse reading later must not stack a second decision
    assert [d.decision for d in again] == ["ease"]


def test_revert_restores_the_session(tempo):
    decision = _adapt(70.0)[0]
    reverted = plan_adaptation.revert(decision.id)
    assert reverted.reverted_at is not None
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None
    assert session.session_type == SessionType.TEMPO
    assert (session.target_hr_zone, session.status) == ("Z4", SessionStatus.PENDING)
    with pytest.raises(plan_adaptation.NothingToRevert):
        plan_adaptation.revert(decision.id)


def test_a_bad_morning_skips_the_session(tempo):
    assert [d.decision for d in _adapt(30.0)] == ["rest"]
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None and session.status == SessionStatus.SKIPPED


def test_the_switch_off_writes_nothing_unless_asked(tempo):
    with patch.object(plan_adaptation, "auto_adapt_enabled", return_value=False):
        assert _adapt(30.0, respect_setting=True) == []
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


def test_the_api_lists_adapts_and_reverts(tempo, router_client):
    from arete.api.plan import router

    client = router_client(router)
    with (
        patch("arete.api.plan.athlete_today", return_value=DAY),
        patch("arete.services.coaching_rules.rule_facts", return_value=_facts(50.0)),
    ):
        adapted = client.post("/plan/today/adapt").json()
    assert [d["decision"] for d in adapted["decisions"]] == ["replace_easy"]
    decision_id = adapted["decisions"][0]["id"]
    assert client.post(f"/plan/decisions/{decision_id}/revert").status_code == 200
    assert client.post(f"/plan/decisions/{decision_id}/revert").status_code == 409
    assert client.post("/plan/decisions/999999/revert").status_code == 404


def _garmin():
    from unittest.mock import MagicMock

    from test_garmin_export import Garmin

    client = Garmin()
    client.has_tokens = MagicMock(return_value=True)
    return client


def test_push_stores_ids_and_reuses_the_copy(tempo):
    client = _garmin()
    first = plan_adaptation.push_session(client, tempo)
    assert first["garmin_workout_id"] == "1"
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None and session.garmin_pushed_at is not None
    plan_adaptation.push_session(client, tempo)
    assert len(client.workouts) == len(client.schedules) == 1
    assert not any(method == "DELETE" for method, _, _ in client.calls)


def test_a_strength_session_is_not_pushable():
    from arete.garmin.workout_structure import NotPushable

    repo = GarminRepository()
    session_id = repo.create_planned_session(
        PlannedSession(
            date=DAY,
            sport="strength",
            session_type=SessionType.STRENGTH,
            target_duration_min=60,
        )
    )
    try:
        with pytest.raises(NotPushable):
            plan_adaptation.push_session(_garmin(), session_id)
        assert plan_adaptation.structure_preview(session_id)["pushable"] is False
    finally:
        repo.delete_planned_session(session_id)


def test_the_daily_push_sends_once_and_only_when_enabled(tempo):
    client = _garmin()
    with patch(
        "arete.services.plan_adaptation.get_user_settings",
        return_value={"push_to_garmin_enabled": False},
    ):
        assert plan_adaptation.push_today(client, DAY) == "disabled"
    with patch(
        "arete.services.plan_adaptation.get_user_settings",
        return_value={"push_to_garmin_enabled": True},
    ):
        assert plan_adaptation.push_today(client, DAY).startswith("1 sent")
        assert plan_adaptation.push_today(client, DAY).startswith("0 sent")


def test_an_adaptation_after_a_push_marks_the_copy_stale(tempo):
    plan_adaptation.push_session(_garmin(), tempo)
    _adapt(70.0)
    session = GarminRepository().get_planned_session(tempo)
    assert session is not None
    assert session.garmin_pushed_at is None and session.garmin_workout_id == "1"


def test_the_push_routes(tempo, router_client):
    from arete.api.garmin import router

    client = router_client(router)
    preview = client.get(f"/garmin/planned/{tempo}/structure").json()
    assert preview["pushable"] is True and "Z4" in preview["text"]
    garmin = _garmin()
    garmin.has_tokens.return_value = False
    with patch("arete.garmin.client.GarminClient", return_value=garmin):
        assert client.post(f"/garmin/planned/{tempo}/push").status_code == 409
        garmin.has_tokens.return_value = True
        body = client.post(f"/garmin/planned/{tempo}/push").json()
        assert body["garmin_workout_id"] == "1"
        garmin.fail = "read"
        assert client.post(f"/garmin/planned/{tempo}/push").status_code == 502
