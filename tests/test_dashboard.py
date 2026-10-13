"""GET /dashboard: the page's former burst, read once on one connection."""

from __future__ import annotations

import re

import duckdb
import pytest
from dashboard_fixture import seed_history

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services.athlete_scope import athlete_scope
from arete.services.settings import athlete_today

STATEMENTS = re.compile(r'db;dur=[\d.]+;desc="(\d+) statements"')


@pytest.fixture
def history(tmp_path, monkeypatch):
    """A temp database holding two years of history around today."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "dashboard.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    today = athlete_today()
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
    }


def test_every_slice_equals_its_former_endpoint(history, client):
    day = history.isoformat()
    board = client.get("/dashboard").json()
    expected = _endpoints(client, day)

    assert board.keys() == expected.keys()
    for field, value in expected.items():
        assert board[field] == value, field
    # A day that exercises every slice, not empty lists equal to empty lists.
    assert board["planned"] and board["actual"] and board["strength"]
    assert board["plan_today"]["decisions"] and board["coach"]["items"]
    assert board["next_goal"] and board["health"]
    assert board["fitness"]["ctl"] > 0 and board["player_stats"]["xp"]["current"] > 0
    assert board["briefing"]["status"] == "ready"
    # Ties on the date keep a stable order: the newest session first.
    assert [s["name"] for s in board["actual"]] == ["Velo", "Réveil musculaire"]


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

    mine = client.get("/dashboard", headers=as_first).json()
    theirs = client.get("/dashboard", headers=as_second).json()

    assert [s["description"] for s in mine["planned"]] == ["Premier Tempo du jour"]
    assert mine["coach"]["items"] and mine["health"] is not None
    # Nothing of the first athlete's day, and the empty day's own answers.
    assert theirs["planned"] == theirs["actual"] == theirs["strength"] == []
    assert theirs["plan_today"]["decisions"] == theirs["coach"]["items"] == []
    assert theirs["next_goal"] is None and theirs["health"] is None
    assert theirs["fitness"]["ctl"] == 0.0
    assert theirs["briefing"]["status"] == "pending"
    assert theirs == _endpoints(client, today.isoformat(), headers=as_second)
