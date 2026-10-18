"""No Strava-derived number reaches the coach (ARE-126).

Strava's API agreement (1 June 2026) forbids its data in the development or
operation of an AI application, including context-window ingestion. A Strava
row, and Strava values left on a Garmin row, must change none of the numbers
the coach reads: the dashboard, the analytics overview (Analytics page data),
the workload and fitness tools and the briefing facts.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.garmin.sync import (
    DERIVED_FROM_STRAVA,
    STRAVA_ONLY_FIELDS,
    garmin_takeover,
)
from arete.services.settings import athlete_today


@pytest.fixture
def athlete(tmp_path, monkeypatch) -> date:
    """Six weeks of Garmin running in a database of its own."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "strava.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    init_schema()
    today = athlete_today()
    con = connect()
    try:
        con.executemany(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, rpe, avg_hr,"
            " distance_m, source) VALUES (?, 'running', 3000, ?, 150, 10000,"
            " 'garmin_connect')",
            [
                [today - timedelta(days=ago), None if ago % 3 else 6]
                for ago in range(42, 0, -2)
            ],
        )
    finally:
        con.close()
    return today


def _model_numbers(client, today: date) -> dict:
    from arete.agent.tools.analytics import get_fitness, get_workload
    from arete.services.briefing import briefing_facts

    overview = client.get("/analytics/overview", params={"period": "30d"}).json()
    return {
        "dashboard": client.get("/dashboard").json()["fitness"],
        "overview": overview["cards"],
        "workload": json.loads(get_workload.invoke({"days": 28})),
        "fitness": json.loads(get_fitness.invoke({"days": 42})),
        "briefing": briefing_facts(today, ""),
    }


def test_strava_values_change_no_number_the_coach_reads(athlete, client):
    before = _model_numbers(client, athlete)
    con = connect()
    try:
        # A Strava-only workout, and Strava values left on a Garmin row by the
        # old merge (suffer score, power, splits, best efforts, workout type).
        con.execute(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, avg_hr,"
            " distance_m, suffer_score, source) VALUES (?, 'running', 5400, 172,"
            " 15000, 240, 'strava')",
            [athlete - timedelta(days=1)],
        )
        con.execute(
            "UPDATE app.actual_sessions SET suffer_score = 300, avg_watts = 280,"
            " workout_type = 1, strava_activity_id = '42'"
            " WHERE id = (SELECT max(id) FROM app.actual_sessions"
            " WHERE source = 'garmin_connect')"
        )
    finally:
        con.close()
    assert _model_numbers(client, athlete) == before


def test_a_garmin_takeover_clears_the_strava_only_values():
    garmin = ActualSession(
        date=date(2026, 10, 1),
        sport="running",
        source=ActivitySource.GARMIN_CONNECT,
        garmin_activity_id="garmin-7",
        name="Course à pied",
    )
    fields = garmin_takeover(garmin)
    assert fields["source"] == ActivitySource.GARMIN_CONNECT.value
    assert all(fields[column] is None for column in STRAVA_ONLY_FIELDS)
    # The adherence was computed from Strava's measures: it goes too.
    assert all(fields[column] is None for column in DERIVED_FROM_STRAVA)
    assert fields["name"] == "Course à pied"
    # Every column a takeover writes is one the repository lets it write.
    assert set(fields) <= GarminRepository.ENRICHMENT_COLUMNS


def test_the_migration_clears_strava_values_on_linked_garmin_rows(athlete):
    from arete.dataio.init_duckdb import _m62_strava_values_off_garmin_rows

    con = connect()
    try:
        con.execute(
            "UPDATE app.actual_sessions SET suffer_score = 90, best_efforts_json = '[]',"
            " splits_json = '[]', avg_watts = 250, weighted_avg_watts = 260,"
            " workout_type = 3, laps_json = '[]', device_name = 'Strava app',"
            " notes = 'Description Strava', strava_activity_id = '9'"
            " WHERE id = (SELECT min(id) FROM app.actual_sessions)"
        )
        # A Garmin row never linked to Strava keeps whatever it has.
        con.execute(
            "UPDATE app.actual_sessions SET avg_watts = 230"
            " WHERE id = (SELECT max(id) FROM app.actual_sessions)"
        )
        con.execute(
            "INSERT INTO app.strava_tokens (athlete_id, access_token, refresh_token,"
            " expires_at) VALUES (42, 'at', 'rt', 2000000000)"
        )
        _m62_strava_values_off_garmin_rows(con)
        _m62_strava_values_off_garmin_rows(con)  # idempotent
        tokens = con.execute("SELECT count(*) FROM app.strava_tokens").fetchone()
        linked = con.execute(
            "SELECT suffer_score, best_efforts_json, splits_json, avg_watts,"
            " weighted_avg_watts, workout_type, laps_json, device_name, notes,"
            " strava_activity_id, distance_m"
            " FROM app.actual_sessions WHERE id = (SELECT min(id) FROM app.actual_sessions)"
        ).fetchone()
        unlinked = con.execute(
            "SELECT avg_watts FROM app.actual_sessions"
            " WHERE id = (SELECT max(id) FROM app.actual_sessions)"
        ).fetchone()
    finally:
        con.close()
    assert linked == (None,) * 9 + ("9", 10000)
    assert tokens == (0,)  # Strava is retired: its stored credentials go
    assert unlinked == (230,)


def test_a_strength_log_linked_to_a_strava_row_still_loads(athlete, client):
    # The log is the athlete's own entry; only the Strava row is left out.
    con = connect()
    try:
        strava = con.execute(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, source)"
            " VALUES (?, 'strength', 3600, 'strava') RETURNING id",
            [athlete],
        ).fetchone()[0]
        before = client.get("/dashboard").json()["fitness"]["atl"]
        con.execute(
            "INSERT INTO app.strength_sessions (date, name, duration_min, overall_rpe,"
            " actual_session_id) VALUES (?, 'Force', 60, 8, ?)",
            [athlete, strava],
        )
    finally:
        con.close()
    assert client.get("/dashboard").json()["fitness"]["atl"] > before


def test_a_takeover_linked_to_a_plan_is_rescored_on_garmin_values(athlete):
    from arete.garmin.models import PlannedSession, SessionType
    from arete.garmin.sync import rescore

    repo = GarminRepository()
    planned = repo.create_planned_session(
        PlannedSession(
            date=athlete,
            sport="running",
            session_type=SessionType.ENDURANCE,
            target_duration_min=50,
        )
    )
    con = connect()
    try:
        actual = con.execute(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, source,"
            " planned_session_id, adherence_score) VALUES (?, 'running', 3000,"
            " 'garmin_connect', ?, NULL) RETURNING id",
            [athlete, planned],
        ).fetchone()[0]
    finally:
        con.close()
    garmin = ActualSession(
        date=athlete,
        sport="running",
        source=ActivitySource.GARMIN_CONNECT,
        duration_sec=3000,
    )
    rescore(repo, actual, garmin, planned)
    row = repo.get_actual_session(actual)
    assert row.planned_session_id == planned
    assert row.adherence_score is not None


def test_banister_and_weekly_facts_leave_strava_rows_out(athlete):
    from arete.features.banister import get_running_sessions
    from arete.services import weekly_review

    start = athlete - timedelta(days=6)
    con = connect()
    try:
        before = get_running_sessions(con, start, athlete)
    finally:
        con.close()
    facts_before = weekly_review.week_facts(start, athlete)
    con = connect()
    try:
        con.execute(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, avg_hr,"
            " avg_speed_mps, source) VALUES (?, 'running', 5400, 165, 3.2, 'strava')",
            [athlete - timedelta(days=1)],
        )
        after = get_running_sessions(con, start, athlete)
    finally:
        con.close()
    assert after == before
    assert weekly_review.week_facts(start, athlete) == facts_before
