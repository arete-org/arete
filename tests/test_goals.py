"""Goal races: CRUD, the next goal, and what deleting one removes."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from arete.dataio.db import connect
from arete.garmin.models import PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import goals

FAR = date.today() + timedelta(days=900)


@pytest.fixture(autouse=True)
def _clean():
    yield
    con = connect()
    con.execute("DELETE FROM app.goals WHERE name LIKE 'test-%'")
    con.execute(
        "DELETE FROM app.planned_sessions WHERE date >= ?", [FAR - timedelta(days=60)]
    )
    con.close()


def test_the_next_goal_is_the_soonest_a_race():
    goals.create_goal(name="test-b", race_date=FAR, distance_km=10, priority="B")
    a = goals.create_goal(
        name="test-a", race_date=FAR + timedelta(days=30), distance_km=21.1
    )
    upcoming = [g for g in goals.list_goals() if g.name.startswith("test-")]
    assert [g.name for g in upcoming] == ["test-b", "test-a"]
    assert goals.next_goal(FAR - timedelta(days=1)) == a


def test_validation():
    with pytest.raises(ValueError):
        goals.create_goal(name="test-x", race_date=FAR, distance_km=10, priority="Z")
    with pytest.raises(ValueError):
        goals.create_goal(name="test-x", race_date=FAR, distance_km=0.5)
    g = goals.create_goal(name="test-x", race_date=FAR, distance_km=10)
    with pytest.raises(ValueError):
        goals.update_goal(g.id, user_id=2)


def test_deleting_a_goal_removes_its_future_plan_only():
    g = goals.create_goal(name="test-del", race_date=FAR, distance_km=42.195)
    repo = GarminRepository()
    generated = repo.create_planned_session(
        PlannedSession(
            date=FAR - timedelta(days=3), session_type=SessionType.TEMPO, goal_id=g.id
        )
    )
    manual = repo.create_planned_session(
        PlannedSession(date=FAR - timedelta(days=2), session_type=SessionType.ENDURANCE)
    )
    assert goals.delete_goal(g.id) is True
    assert repo.get_planned_session(generated) is None
    assert repo.get_planned_session(manual) is not None
    assert goals.delete_goal(g.id) is False


def test_the_routes(router_client):
    from arete.api.goals import router

    client = router_client(router)
    created = client.post(
        "/goals",
        json={"name": "test-api", "race_date": FAR.isoformat(), "distance_km": 10},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["days_left"] == 900 and body["priority"] == "A"
    past = (date.today() - timedelta(days=1)).isoformat()
    assert (
        client.post(
            "/goals", json={"name": "test-p", "race_date": past, "distance_km": 10}
        ).status_code
        == 422
    )
    patched = client.patch(
        f"/goals/{body['id']}", json={"target_time_sec": 2400}
    ).json()
    assert patched["target_time_sec"] == 2400
    assert client.delete(f"/goals/{body['id']}").status_code == 204
    assert client.patch(f"/goals/{body['id']}", json={"name": "x"}).status_code == 404


class TestNextGoal:
    """One SQL row, the same choice as filtering every goal in Python."""

    def test_past_and_cancelled_races_are_skipped(self):
        goals.create_goal(name="test-past", race_date=FAR, distance_km=10)
        cancelled = goals.create_goal(
            name="test-cancelled", race_date=FAR + timedelta(days=1), distance_km=10
        )
        goals.update_goal(cancelled.id, status="cancelled")
        later = goals.create_goal(
            name="test-later", race_date=FAR + timedelta(days=2), distance_km=10
        )
        assert goals.next_goal(FAR + timedelta(days=1)) == later

    def test_a_race_today_is_still_next(self):
        today = goals.create_goal(name="test-today", race_date=FAR, distance_km=10)
        assert goals.next_goal(FAR) == today

    def test_without_an_a_race_the_soonest_other_wins(self):
        soon = goals.create_goal(
            name="test-c", race_date=FAR, distance_km=10, priority="C"
        )
        goals.create_goal(
            name="test-b",
            race_date=FAR + timedelta(days=3),
            distance_km=10,
            priority="B",
        )
        assert goals.next_goal(FAR - timedelta(days=1)) == soon

    def test_none_when_nothing_is_ahead(self):
        goals.create_goal(name="test-gone", race_date=FAR, distance_km=10)
        assert goals.next_goal(FAR + timedelta(days=1)) is None

    def test_one_statement(self, monkeypatch, statement_log):
        import duckdb

        goals.create_goal(name="test-one", race_date=FAR, distance_km=10)
        real = duckdb.connect
        monkeypatch.setattr(
            duckdb, "connect", lambda *a, **k: statement_log.wrap(real(*a, **k))
        )
        goals.next_goal(FAR - timedelta(days=1))
        assert [s for s in statement_log if "visible_goals" in s] == [statement_log[-1]]
