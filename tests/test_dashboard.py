"""GET /dashboard: the page's former burst, read once on one connection."""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime

import duckdb
import pytest
from dashboard_fixture import seed_history

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services.athlete_scope import athlete_scope
from arete.services.settings import athlete_today

STATEMENTS = re.compile(r'db;dur=[\d.]+;desc="(\d+) statements"')
#: Thursday 15 October 2026 in Paris: the fixture day the golden values belong to.
NOW = datetime(2026, 10, 14, 22, 30, tzinfo=UTC)
FIXTURE_DAY = date(2026, 10, 15)


@pytest.fixture
def history(tmp_path, monkeypatch):
    """A temp database holding two years of history around the fixture day."""
    from arete.services import settings

    monkeypatch.setattr(settings, "utc_now", lambda: NOW)
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "dashboard.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_GARMIN_TOKENS_DIR", raising=False)
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    today = athlete_today()
    assert today == FIXTURE_DAY
    con = connect()
    try:
        seed_history(con, today)
        # A second session today, unplanned and without HR: the flat default.
        con.execute(
            "INSERT INTO app.actual_sessions (date, sport, duration_sec, name, source)"
            " VALUES (?, 'cycling', 3600, 'Velo', 'manual')",
            [today],
        )
    finally:
        con.close()
    return today


def _endpoints(client, day: str, headers=None) -> dict:
    """What each former dashboard request answers, by dashboard field."""

    def get(path):
        response = client.get(path, headers=headers)
        assert response.status_code in (200, 404), (path, response.text)
        return response.json() if response.status_code == 200 else None

    window = f"start_date={day}&end_date={day}"
    return {
        "date": day,
        "planned": get(f"/garmin/planned?{window}"),
        "actual": get(f"/garmin/actual?{window}"),
        "strength": [
            s for s in get("/strength/sessions?limit=200") if s["date"] == day
        ],
        "plan_today": get("/plan/today"),
        "next_goal": get("/goals/next"),
        "player_stats": get("/metrics/player-stats"),
        "fitness": get("/metrics/fitness"),
        "workload": get("/metrics/workload"),
        "health": get(f"/garmin/health/daily?date={day}"),
        "garmin_connected": get("/garmin/sync/status")["garmin_authenticated"],
        "briefing": get("/tips/daily"),
        "coach": get("/coach/today"),
        "checkin": next(iter(get("/checkins?days=1")), None),
    }


def test_every_slice_equals_its_former_endpoint(history, client):
    day = history.isoformat()
    answer = {"sleep": 4, "legs": 3, "mood": None, "note": None}
    assert client.put(f"/checkins/{day}", json=answer).status_code == 200
    board = client.get("/dashboard").json()
    expected = _endpoints(client, day)

    # The one field without a former endpoint: whether any load was ever logged.
    assert board.pop("has_load") is True
    assert board.keys() == expected.keys()
    for field, value in expected.items():
        assert board[field] == value, field
    # A day that exercises every slice, not empty lists equal to empty lists.
    assert board["planned"] and board["actual"] and board["strength"]
    assert board["plan_today"]["decisions"] and board["coach"]["items"]
    assert board["next_goal"] and board["health"]
    assert board["briefing"]["status"] == "ready"
    assert board["checkin"]["legs"] == 3
    # Ties on the date keep a stable order: the newest session first.
    assert [s["name"] for s in board["actual"]] == ["Velo", "Réveil musculaire"]


def test_the_fixture_day_keeps_its_numbers(history, client):
    """Golden values, read from origin/main's endpoints on the same fixture."""
    board = client.get("/dashboard").json()
    fitness, stats, workload = (
        board["fitness"],
        board["player_stats"],
        board["workload"],
    )

    assert {k: fitness[k] for k in ("ctl", "atl", "tsb", "ramp_rate", "form_zone")} == {
        "ctl": 70.5,
        "atl": 86.8,
        "tsb": -16.3,
        "ramp_rate": 3.1,
        "form_zone": "tired",
    }
    assert fitness["days_analyzed"] == 32
    assert (fitness["readiness_score"], fitness["readiness_source"]) == (54.0, "garmin")
    assert (stats["xp"]["current"], stats["xp"]["max"]) == (390.4, 250.0)
    assert (stats["level"], stats["weeks_at_goal"]) == (22, 98)
    assert (stats["recent_weeks_at_goal"], stats["recent_weeks"]) == (12, 12)
    assert (stats["mp"]["current"], stats["hp"]["current"]) == (22.8, 54.0)
    assert (workload["acwr"], workload["acwr_ewma"], workload["acwr_zone"]) == (
        1.219,
        1.343,
        "optimal",
    )
    assert workload["days_analyzed"] == 21


def test_garmin_connection_follows_the_stored_tokens(history, client):
    from arete.config import config
    from arete.garmin.token_store import ACCOUNT_FILE, TOKEN_FILE

    def connected():
        board = client.get("/dashboard").json()["garmin_connected"]
        assert board == client.get("/garmin/sync/status").json()["garmin_authenticated"]
        return board

    assert connected() is False
    tokens = config.garmin_tokens_dir
    tokens.mkdir(parents=True, exist_ok=True)
    (tokens / TOKEN_FILE).write_text("{}")
    assert connected() is True
    # Tokens Garmin refused at the last sync count as disconnected.
    (tokens / ACCOUNT_FILE).write_text(json.dumps({"auth_failed_at": NOW.isoformat()}))
    assert connected() is False


def test_one_connection_one_load_history_and_no_write(
    history, client, monkeypatch, statement_log
):
    from arete.dataio import queries
    from arete.services import metrics

    real_connect = duckdb.connect
    opened = []

    def counting_connect(*args, **kwargs):
        opened.append(args)
        return statement_log.wrap(real_connect(*args, **kwargs))

    history_reads = []

    def counting_history(con, user_id=None):
        history_reads.append(user_id)
        return queries.daily_tss_by_date(con, user_id)

    monkeypatch.setattr(duckdb, "connect", counting_connect)
    monkeypatch.setattr(metrics, "daily_tss_by_date", counting_history)

    response = client.get("/dashboard")

    assert response.status_code == 200
    assert len(opened) == 1
    assert len(history_reads) == 1
    # The ticket's budget, setup statements of the connection included.
    count = int(STATEMENTS.search(response.headers["server-timing"]).group(1))
    assert count == len(statement_log) < 25
    verbs = {sql.split()[0].upper() for sql in statement_log}
    assert verbs <= {"PRAGMA", "SET", "SELECT", "WITH"}, verbs

    # More open proposals cost no more statements: their sessions are one read.
    con = connect()
    try:
        for n in range(3):
            planned = con.execute(
                "INSERT INTO app.planned_sessions (user_id, date, sport, session_type)"
                " VALUES (1, ?, 'running', 'tempo') RETURNING id",
                [history],
            ).fetchone()[0]
            con.execute(
                "INSERT INTO app.plan_decisions (user_id, date, planned_session_id,"
                " decision, reason, state, session_revision)"
                " VALUES (1, ?, ?, 'easier', ?, 'pending', 1)",
                [history, planned, f"Proposition {n}"],
            )
    finally:
        con.close()
    statement_log.clear()
    again = client.get("/dashboard")
    assert len(again.json()["coach"]["items"][0]["group"]) == 4
    assert len(statement_log) == count


def test_each_athlete_reads_only_their_dashboard(tmp_path, client, monkeypatch):
    from arete.api import auth
    from arete.services.users import upsert_user

    monkeypatch.setenv("ARETE_DB", str(tmp_path / "tenants.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "first@example.com")
    init_schema()
    first = upsert_user("first", "first@example.com", "First", verified=True)
    second = upsert_user("second", "second@example.com", "Second", verified=True)
    today = athlete_today()
    with athlete_scope(first.athlete_id):
        con = connect()
        try:
            seed_history(con, today, label="Premier ")
        finally:
            con.close()
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "test")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "test")
    monkeypatch.setattr(auth, "_verify_session_token", lambda token: {"sub": token})
    as_first = {"Authorization": f"Bearer {first.clerk_user_id}"}
    as_second = {"Authorization": f"Bearer {second.clerk_user_id}"}

    answer = {"sleep": 2, "legs": 4}
    put = client.put(f"/checkins/{today}", json=answer, headers=as_first)
    assert put.status_code == 200
    mine = client.get("/dashboard", headers=as_first).json()
    theirs = client.get("/dashboard", headers=as_second).json()

    assert [s["description"] for s in mine["planned"]] == ["Premier Tempo du jour"]
    assert mine["coach"]["items"] and mine["health"] is not None
    # Nothing of the first athlete's day, and the empty day's own answers.
    assert theirs["planned"] == theirs["actual"] == theirs["strength"] == []
    assert theirs["plan_today"]["decisions"] == theirs["coach"]["items"] == []
    assert theirs["next_goal"] is None and theirs["health"] is None
    assert mine["checkin"]["sleep"] == 2 and theirs["checkin"] is None
    assert theirs["fitness"]["ctl"] == 0.0
    assert theirs["briefing"]["status"] == "pending"
    assert mine.pop("has_load") is True and theirs.pop("has_load") is False
    assert theirs == _endpoints(client, today.isoformat(), headers=as_second)
