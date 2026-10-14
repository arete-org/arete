"""Writing a goal's plan: what it creates, replaces and leaves alone."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest

from arete.dataio.db import connect
from arete.garmin.models import PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import goals, plan_builder

TODAY = date.today() + timedelta(days=1200)  # a "today" no other test reaches
SETTINGS = {"rest_day_preference": ["monday"], "weekly_training_goal": 5}


@pytest.fixture
def goal():
    g = goals.create_goal(
        name="test-plan", race_date=TODAY + timedelta(weeks=8), distance_km=10
    )
    con = connect()
    for i in range(1, 28, 2):  # 14 runs of 50 min in the last four weeks
        con.execute(
            "INSERT INTO app.actual_sessions (user_id, date, sport, duration_sec, source)"
            " VALUES (1, ?, 'running', 3000, 'test-plan')",
            [TODAY - timedelta(days=i)],
        )
    con.close()
    with (
        patch("arete.services.plan_builder.get_user_settings", return_value=SETTINGS),
        patch(
            "arete.services.metrics.current_vdot",
            return_value=(50.0, "garmin_prediction"),
        ),
    ):
        yield g
    con = connect()
    con.execute(
        "DELETE FROM app.planned_sessions WHERE date >= ?", [TODAY - timedelta(days=30)]
    )
    con.execute("DELETE FROM app.actual_sessions WHERE source = 'test-plan'")
    con.execute("DELETE FROM app.goals WHERE name LIKE 'test-%'")
    con.close()


def _plan_sessions(goal_id: int) -> list[PlannedSession]:
    return [
        s
        for s in GarminRepository().list_planned_sessions(
            start_date=TODAY,
            end_date=TODAY + timedelta(weeks=9),
            status=None,
            limit=200,
            ascending=True,
        )
        if s.goal_id == goal_id
    ]


def test_inputs_read_the_athletes_recent_running(goal):
    inputs = plan_builder.plan_inputs(goal, TODAY)
    assert inputs.start == TODAY + timedelta(days=1)
    assert round(inputs.weekly_minutes_now) == 175  # 14 x 50 min / 4 weeks
    assert inputs.sessions_per_week == 4  # 3.5 runs a week, rounded
    assert inputs.rest_days == frozenset({0})
    assert inputs.paces is not None and round(inputs.paces.vdot) == 50


def test_preview_writes_nothing(goal):
    body = plan_builder.preview(goal.id, TODAY)
    assert body["weeks"][-1]["phase"] == "race"
    assert _plan_sessions(goal.id) == []


def test_apply_writes_replaces_and_respects_other_sessions(goal):
    repo = GarminRepository()
    busy = TODAY + timedelta(days=2)  # a Wednesday-ish day the plan would use
    manual = repo.create_planned_session(
        PlannedSession(
            date=busy, session_type=SessionType.ENDURANCE, description="perso"
        )
    )
    first = plan_builder.apply(goal.id, TODAY)
    sessions = _plan_sessions(goal.id)
    assert first["created"] == len(sessions) > 0
    assert all(s.source == "plan" for s in sessions)
    assert all(s.date != busy for s in sessions)
    assert sessions[-1].session_type == SessionType.RACE
    again = plan_builder.apply(goal.id, TODAY)
    assert again["replaced"] == first["created"]
    assert len(_plan_sessions(goal.id)) == again["created"]
    assert repo.get_planned_session(manual) is not None
    assert plan_builder.remove(goal.id, TODAY) == again["created"]
    assert _plan_sessions(goal.id) == []


def test_routes(goal, router_client):
    from arete.api.goals import router

    client = router_client(router)
    with patch("arete.services.plan_builder.athlete_today", return_value=TODAY):
        assert client.post(f"/goals/{goal.id}/plan/preview").status_code == 200
    assert client.post("/goals/999999/plan").status_code == 404
    far = goals.create_goal(
        name="test-far", race_date=date.today() + timedelta(weeks=40), distance_km=42.2
    )
    resp = client.post(f"/goals/{far.id}/plan/preview")
    assert resp.status_code == 422 and "24 semaines" in resp.json()["detail"]


def test_projection_shows_the_taper_freshening_the_athlete(goal):
    plan_builder.apply(goal.id, TODAY)
    body = plan_builder.projection(goal.id, TODAY)
    series = body["series"]
    assert series[-1]["date"] == goal.race_date.isoformat()
    assert body["planned_sessions"] > 0
    assert series[0]["date"] >= (TODAY - timedelta(days=28)).isoformat()
    # The plan loads, then the taper lets form come back before the race.
    lowest_tsb = min(p["tsb"] for p in series)
    assert body["race_day"]["tsb"] > lowest_tsb
    assert body["peak_ctl"] >= series[0]["ctl"]


def test_planned_tss_uses_the_history_formula():
    from arete.features.plan_generator import planned_tss

    assert round(planned_tss("tempo", 60)) == round(60 * 0.49 / 0.36)
    assert planned_tss("intervals", 50) > planned_tss("endurance", 50)
