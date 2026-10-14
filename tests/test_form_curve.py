"""GET /dashboard/form-curve: the dashboard's lazy read of fitness, fatigue and form."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services import goals
from arete.services.athlete_scope import athlete_scope
from arete.services.settings import athlete_today


@pytest.fixture
def athlete(tmp_path, monkeypatch) -> date:
    """Four months of running, one session every other day, in a database of its own."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "curve.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    init_schema()
    today = athlete_today()
    con = connect()
    try:
        con.executemany(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, rpe, source)"
            " VALUES (?, 'running', 3600, 6, 'manual')",
            [[today - timedelta(days=ago)] for ago in range(120, 0, -2)],
        )
    finally:
        con.close()
    return today


def _plan(day: date, session_type: str, minutes: int, status: str = "pending") -> int:
    con = connect()
    try:
        return con.execute(
            "INSERT INTO app.planned_sessions (date, sport, session_type,"
            " target_duration_min, description, status) VALUES (?, 'running', ?, ?, ?, ?)"
            " RETURNING id",
            [day, session_type, minutes, f"{session_type} {minutes}", status],
        ).fetchone()[0]
    finally:
        con.close()


def test_without_a_goal_the_curve_is_twelve_weeks_of_history(athlete, client):
    body = client.get("/dashboard/form-curve").json()

    dates = [p["date"] for p in body["series"]]
    assert dates[0] == (athlete - timedelta(days=84)).isoformat()
    assert dates[-1] == athlete.isoformat() and len(dates) == 85
    assert not any(p["planned"] for p in body["series"])
    assert body["goal_id"] is None and body["race_day"] is None
    assert body["key_session"] is None
    # The same model as the dashboard's form for today.
    fitness = client.get("/metrics/fitness").json()
    last = body["series"][-1]
    assert (last["ctl"], last["atl"], last["tsb"]) == (
        fitness["ctl"],
        fitness["atl"],
        fitness["tsb"],
    )


def test_with_a_goal_it_runs_to_race_day_and_names_the_key_session(athlete, client):
    race = athlete + timedelta(days=30)
    goal = goals.create_goal(name="Semi de Lyon", race_date=race, distance_km=21.1)
    _plan(athlete + timedelta(days=1), "endurance", 45)
    key = _plan(athlete + timedelta(days=3), "intervals", 60)
    _plan(athlete + timedelta(days=4), "long_run", 200, status="skipped")
    _plan(athlete + timedelta(days=8), "long_run", 150)  # outside the week

    body = client.get("/dashboard/form-curve").json()

    assert body["goal_id"] == goal.id
    assert body["series"][0]["date"] == (athlete - timedelta(days=84)).isoformat()
    assert body["series"][-1]["date"] == race.isoformat()
    planned = {p["date"] for p in body["series"] if p["planned"]}
    assert (athlete + timedelta(days=3)).isoformat() in planned
    assert body["race_day"]["tsb"] is not None and body["planned_sessions"] == 3
    assert body["key_session"]["id"] == key
    assert body["key_session"]["session_type"] == "intervals"


def test_a_past_goal_is_not_projected(athlete, client):
    goals.create_goal(
        name="Passée", race_date=athlete - timedelta(days=3), distance_km=10
    )
    body = client.get("/dashboard/form-curve").json()
    assert body["goal_id"] is None and body["series"][-1]["date"] == athlete.isoformat()


def test_another_athletes_goal_and_plan_are_not_read(athlete, client):
    from arete.services.users import upsert_user

    other = upsert_user("other", "other@example.com", "Other", verified=True)
    with athlete_scope(other.athlete_id):
        goals.create_goal(
            name="Leur course", race_date=athlete + timedelta(days=20), distance_km=10
        )
        _plan(athlete + timedelta(days=2), "intervals", 60)
    body = client.get("/dashboard/form-curve").json()
    assert body["goal_id"] is None and body["key_session"] is None
