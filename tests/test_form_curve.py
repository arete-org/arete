"""GET /dashboard/form-curve: the dashboard's lazy read of fitness, fatigue and form."""

from __future__ import annotations

from datetime import date, timedelta

import duckdb
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
    # The projection assumes rest after the last planned session.
    assert body["last_planned"] == (athlete + timedelta(days=8)).isoformat()


def test_today_is_the_dashboards_form_even_with_a_session_planned_today(
    athlete, client
):
    goals.create_goal(
        name="Semi", race_date=athlete + timedelta(days=30), distance_km=21.1
    )
    _plan(athlete, "intervals", 75)  # planned today, not done yet

    body = client.get("/dashboard/form-curve").json()

    today = [p for p in body["series"] if p["date"] == athlete.isoformat()]
    assert len(today) == 1 and today[0]["planned"] is False
    fitness = client.get("/metrics/fitness").json()
    board = client.get("/dashboard").json()["fitness"]
    for source in (fitness, board):
        assert (today[0]["ctl"], today[0]["atl"], today[0]["tsb"]) == (
            source["ctl"],
            source["atl"],
            source["tsb"],
        )
    # Today's plan still weighs on the projection, from tomorrow on.
    tomorrow = next(p for p in body["series"] if p["date"] > athlete.isoformat())
    assert tomorrow["atl"] > today[0]["atl"]
    # Planning's projection shows the same today, and the same days after it.
    projection = client.get(f"/goals/{body['goal_id']}/projection").json()
    planning = {p["date"]: p for p in projection["series"]}
    for point in body["series"]:
        if point["date"] in planning:
            form = ("ctl", "atl", "tsb")
            assert [planning[point["date"]][k] for k in form] == [
                point[k] for k in form
            ]
    # Planning still marks today as a planned day, with its planned load.
    assert planning[athlete.isoformat()]["planned"] is True
    assert planning[athlete.isoformat()]["tss"] > 0
    assert projection["planned_sessions"] == 1


def test_race_morning_counts_the_plan_of_the_day_before(athlete, client):
    goal = goals.create_goal(
        name="10 km", race_date=athlete + timedelta(days=1), distance_km=10
    )
    _plan(athlete, "intervals", 90)  # today, the day before the race

    projection = client.get(f"/goals/{goal.id}/projection").json()

    today = next(p for p in projection["series"] if p["date"] == athlete.isoformat())
    fitness = client.get("/metrics/fitness").json()
    assert today["tsb"] == fitness["tsb"]
    # Race morning is the form after today's planned session, not before it.
    assert projection["race_day"]["tsb"] < today["tsb"]


def test_the_key_session_never_comes_after_the_race(athlete, client):
    race = athlete + timedelta(days=3)
    goals.create_goal(name="10 km", race_date=race, distance_km=10)
    _plan(athlete + timedelta(days=1), "endurance", 30)
    _plan(athlete + timedelta(days=5), "long_run", 150)  # after the race
    body = client.get("/dashboard/form-curve").json()
    assert body["key_session"]["date"] == (athlete + timedelta(days=1)).isoformat()


def test_one_connection_and_a_bounded_number_of_statements(
    athlete, client, monkeypatch, statement_log
):
    # A race session without target time: its minutes come from the VDOT.
    goals.create_goal(
        name="Marathon", race_date=athlete + timedelta(days=60), distance_km=42.195
    )
    for days in (1, 3, 5, 8):
        _plan(athlete + timedelta(days=days), "endurance", 50)
    _plan(athlete + timedelta(days=60), "race", 0)
    real_connect = duckdb.connect
    opened = []

    def counting_connect(*args, **kwargs):
        opened.append(args)
        return statement_log.wrap(real_connect(*args, **kwargs))

    monkeypatch.setattr(duckdb, "connect", counting_connect)
    response = client.get("/dashboard/form-curve")

    assert response.status_code == 200 and response.json()["goal_id"] is not None
    assert len(opened) == 1
    assert len(statement_log) <= 10, (
        statement_log
    )  # 9 today; 31 on 7 connections before
    verbs = {sql.split()[0].upper() for sql in statement_log}
    assert verbs <= {"PRAGMA", "SET", "SELECT", "WITH"}, verbs


def test_a_past_goal_is_not_projected(athlete, client):
    goals.create_goal(
        name="Passée", race_date=athlete - timedelta(days=3), distance_km=10
    )
    body = client.get("/dashboard/form-curve").json()
    assert body["goal_id"] is None and body["series"][-1]["date"] == athlete.isoformat()


def test_another_athletes_goal_and_plan_are_not_read(athlete, client):
    from arete.services.users import upsert_user

    mine = goals.create_goal(
        name="Ma course", race_date=athlete + timedelta(days=40), distance_km=10
    )
    _plan(athlete + timedelta(days=4), "endurance", 40)
    other = upsert_user("other", "other@example.com", "Other", verified=True)
    with athlete_scope(other.athlete_id):
        goals.create_goal(
            name="Leur course", race_date=athlete + timedelta(days=20), distance_km=10
        )
        _plan(athlete + timedelta(days=2), "intervals", 90)
    body = client.get("/dashboard/form-curve").json()
    # My goal and my plan only: their harder session, sooner, is not mine.
    assert body["goal_id"] == mine.id
    assert body["key_session"]["date"] == (athlete + timedelta(days=4)).isoformat()
    assert body["planned_sessions"] == 1


def test_a_planned_race_alone_does_not_reach_race_week(athlete, client):
    race = athlete + timedelta(days=40)
    goals.create_goal(name="Semi", race_date=race, distance_km=21.1)
    _plan(athlete + timedelta(days=3), "endurance", 45)  # next week only
    _plan(race, "race", 0)
    body = client.get("/dashboard/form-curve").json()
    assert body["last_planned"] == (athlete + timedelta(days=3)).isoformat()


def test_todays_pending_session_stays_key_once_another_is_logged(athlete, client):
    goals.create_goal(
        name="Semi", race_date=athlete + timedelta(days=30), distance_km=21.1
    )
    con = connect()
    try:  # this morning's run is logged; the evening intervals are still to do
        con.execute(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, rpe, source)"
            " VALUES (?, 'running', 1800, 3, 'manual')",
            [athlete],
        )
    finally:
        con.close()
    evening = _plan(athlete, "intervals", 70)
    _plan(athlete + timedelta(days=2), "endurance", 40)
    body = client.get("/dashboard/form-curve").json()
    assert body["key_session"]["id"] == evening
    # Its load is not counted twice: today's logged session stands for today.
    projection = client.get(f"/goals/{body['goal_id']}/projection").json()
    assert projection["planned_sessions"] == 1


def test_months_off_still_count_as_a_history(athlete, client):
    con = connect()
    try:  # only an old block, ten months ago: today's CTL rounds to zero
        con.execute("DELETE FROM app.actual_sessions")
        con.execute(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, rpe, source)"
            " VALUES (?, 'running', 3600, 6, 'manual')",
            [athlete - timedelta(days=300)],
        )
    finally:
        con.close()
    board = client.get("/dashboard").json()
    assert board["fitness"]["ctl"] == 0.0 and board["fitness"]["atl"] == 0.0
    assert board["has_load"] is True
