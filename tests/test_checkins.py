"""The morning check-in: stored once a day, read by the day's decision and the
briefing (ARE-59). Its push: ``test_checkin_push.py``."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta

import duckdb
import pytest

from arete.dataio.db import configure_athlete, connect
from arete.dataio.init_duckdb import main as init_schema
from arete.garmin.models import PlannedSession, SessionType
from arete.garmin.repository import GarminRepository
from arete.services import checkins
from arete.services.metrics import Readiness
from arete.services.settings import athlete_today


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A database of its own: the day's plan and decisions are this test's."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "checkins.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    con = connect()
    con.execute("INSERT INTO app.athletes (id) VALUES (1) ON CONFLICT DO NOTHING")
    con.close()
    return tmp_path


def _rows() -> list[tuple]:
    con = connect()
    try:
        return con.execute(
            "SELECT date, sleep, legs, mood, note, answered_at, prompted_at "
            "FROM app.visible_daily_checkins ORDER BY date"
        ).fetchall()
    finally:
        con.close()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def test_answering_twice_the_same_day_replaces_the_answer(db, client):
    day = athlete_today().isoformat()
    first = client.put(f"/checkins/{day}", json={"sleep": 2, "legs": 4})
    assert first.status_code == 200, first.text
    again = client.put(
        f"/checkins/{day}",
        json={"sleep": 3, "legs": 4, "mood": 5, "note": "  Bien dormi  "},
    )
    assert again.status_code == 200
    body = again.json()
    assert (body["sleep"], body["legs"], body["mood"]) == (3, 4, 5)
    assert body["note"] == "Bien dormi" and body["replanned"] is False
    # One row; the first answer's time is kept, the correction's recorded.
    assert len(_rows()) == 1
    assert body["answered_at"] == first.json()["answered_at"]
    listed = client.get("/checkins").json()
    assert [c["date"] for c in listed] == [day]
    assert listed[0]["sleep"] == 3


@pytest.mark.parametrize(
    ("offset", "payload"),
    [
        (0, {"sleep": 0, "legs": 3}),
        (0, {"sleep": 3, "legs": 6}),
        (0, {"sleep": "3", "legs": 3}),
        (0, {"sleep": 3}),
        (0, {"sleep": 3, "legs": 3, "mood": 9}),
        (0, {"sleep": 3, "legs": 3, "note": "x" * (checkins.MAX_NOTE_CHARS + 1)}),
        (1, {"sleep": 3, "legs": 3}),
        (-checkins.MAX_DAYS, {"sleep": 3, "legs": 3}),
    ],
)
def test_invalid_answers_are_refused(db, client, offset, payload):
    day = (athlete_today() + timedelta(days=offset)).isoformat()
    response = client.put(f"/checkins/{day}", json=payload)
    assert response.status_code == 422, response.text
    assert _rows() == []


def test_the_list_is_bounded_to_the_window(db, client):
    today = athlete_today()
    for back in (0, 13):
        day = (today - timedelta(days=back)).isoformat()
        client.put(f"/checkins/{day}", json={"sleep": 4, "legs": 4})
    assert len(client.get("/checkins?days=14").json()) == 2
    assert len(client.get("/checkins?days=1").json()) == 1
    for days in (0, checkins.MAX_DAYS + 1):
        assert client.get(f"/checkins?days={days}").status_code == 422


def test_an_athlete_never_reads_another_s_check_in(db, client, monkeypatch):
    from arete.api import auth
    from arete.services.users import upsert_user

    day = athlete_today().isoformat()
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "first@example.com")
    first = upsert_user("first", "first@example.com", "First", verified=True)
    second = upsert_user("second", "second@example.com", "Second", verified=True)
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "test")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "test")
    monkeypatch.setattr(auth, "_verify_session_token", lambda token: {"sub": token})
    as_first = {"Authorization": f"Bearer {first.clerk_user_id}"}
    as_second = {"Authorization": f"Bearer {second.clerk_user_id}"}

    mine = client.put(
        f"/checkins/{day}", json={"sleep": 1, "legs": 2}, headers=as_first
    )
    assert mine.status_code == 200
    assert client.get("/checkins", headers=as_second).json() == []
    # The second athlete's own answer of the same day is a row of their own.
    theirs = {"sleep": 5, "legs": 5}
    assert (
        client.put(f"/checkins/{day}", json=theirs, headers=as_second).json()["sleep"]
        == 5
    )
    assert [c["sleep"] for c in client.get("/checkins", headers=as_first).json()] == [1]


# --------------------------------------------------------------------------- #
# The day's decision
# --------------------------------------------------------------------------- #
@pytest.fixture
def frozen_morning(db, monkeypatch):
    """Every clock at 08:00 UTC of today: the daily run is owed, outside quiet hours."""
    from arete import scheduler
    from arete.services import notifications, settings

    now = datetime.combine(athlete_today(), time(8, 0), UTC)
    for module in (scheduler, notifications, settings, checkins):
        monkeypatch.setattr(module, "utc_now", lambda: now)
    monkeypatch.delenv("ARETE_AUTO_SYNC_HOUR", raising=False)
    return now


@pytest.fixture
def tempo_today(db, monkeypatch):
    """Today's tempo, against a Garmin readiness of 85: kept without a check-in."""
    readiness = Readiness(score=85.0, source="garmin_training", measured_on=None)
    monkeypatch.setattr(
        "arete.services.metrics.load_form", lambda day=None: (None, readiness)
    )
    return GarminRepository().create_planned_session(
        PlannedSession(
            date=athlete_today(),
            sport="running",
            session_type=SessionType.TEMPO,
            target_duration_min=45,
            target_hr_zone="Z4",
        )
    )


def _decisions() -> list[tuple]:
    con = connect()
    try:
        return con.execute(
            "SELECT decision, reason, state FROM app.visible_plan_decisions"
        ).fetchall()
    finally:
        con.close()


def _daily_run_done_today() -> None:
    con = connect()
    con.execute(
        "UPDATE app.athletes SET last_sync_at = ? WHERE id = 1",
        [datetime.now(UTC).replace(tzinfo=None)],
    )
    con.close()


def test_the_daily_run_reads_heavy_legs_as_one_band_lower(tempo_today):
    from arete.services.plan_adaptation import adapt_today

    checkins.save(athlete_today(), sleep=4, legs=2)
    adapt_today()
    [(decision, reason, state)] = _decisions()
    assert (decision, state) == ("ease", "pending")
    assert "Préparation Garmin 85/100, jambes lourdes déclarées" in reason


@pytest.mark.parametrize("answer", [None, {"sleep": 5, "legs": 5}])
def test_good_or_no_answers_leave_the_decision_as_it_was(tempo_today, answer):
    from arete.services.plan_adaptation import adapt_today

    if answer:
        checkins.save(athlete_today(), **answer)
    adapt_today()
    assert _decisions() == []  # 85 keeps the tempo: nothing stored


def test_a_low_answer_after_the_run_proposes_without_changing_the_plan(
    tempo_today, client
):
    _daily_run_done_today()
    day = athlete_today().isoformat()
    response = client.put(f"/checkins/{day}", json={"sleep": 2, "legs": 3})
    assert response.json()["replanned"] is True
    [(decision, reason, state)] = _decisions()
    assert (decision, state) == ("ease", "pending")
    assert "nuit difficile déclarée" in reason
    # A proposal to validate: the session itself is untouched.
    session = GarminRepository().get_planned_session(tempo_today)
    assert session.session_type == SessionType.TEMPO
    assert session.status.value == "pending"


def test_an_answer_before_the_run_waits_for_it(tempo_today, client):
    day = athlete_today().isoformat()
    response = client.put(f"/checkins/{day}", json={"sleep": 1, "legs": 1})
    # The run reads it with the night's data; nothing is decided early.
    assert response.json()["replanned"] is False
    assert _decisions() == []


def test_a_good_answer_after_the_run_asks_nothing_again(tempo_today, client):
    _daily_run_done_today()
    day = athlete_today().isoformat()
    response = client.put(f"/checkins/{day}", json={"sleep": 5, "legs": 4})
    assert response.json()["replanned"] is False
    assert _decisions() == []


def test_a_low_answer_during_the_run_reaches_the_day_s_decision(
    frozen_morning, tempo_today, client, monkeypatch
):
    """Docker sends the push and starts the run in the same tick: the athlete
    may answer after the run decided but before it is stamped finished."""
    from arete import scheduler
    from arete.services.plan_adaptation import adapt_today

    answered = []

    def daily_run():
        adapt_today()  # the run's decision: 85 keeps the tempo, nothing stored
        day = athlete_today().isoformat()
        answer = client.put(f"/checkins/{day}", json={"sleep": 1, "legs": 3})
        answered.append(answer.json())
        return {}

    monkeypatch.setattr(scheduler, "daily_sync", daily_run)
    monkeypatch.setattr(scheduler, "write_daily_briefing", lambda: "rules")
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "not monday")
    result = scheduler.run_scheduled_batch()

    assert answered[0]["replanned"] is False  # the run was not finished yet
    assert result["athletes"]["1"]["checkin"] == "replanned"
    [(decision, reason, state)] = _decisions()
    assert (decision, state) == ("ease", "pending")
    assert "nuit difficile déclarée" in reason


def test_a_failed_replan_keeps_the_saved_answer(tempo_today, client, monkeypatch):
    _daily_run_done_today()

    def conflict():
        raise RuntimeError("TransactionContext Error: Conflict")

    monkeypatch.setattr("arete.services.coach_today.prepare", conflict)
    day = athlete_today().isoformat()
    response = client.put(f"/checkins/{day}", json={"sleep": 1, "legs": 1})
    assert response.status_code == 200
    assert response.json()["replanned"] is False
    assert checkins.get() is not None


def test_a_proposal_made_before_a_later_step_failed_is_still_reported(
    tempo_today, client, monkeypatch
):
    """The decision is written, then the follow-up step fails: the browser
    must still learn of the proposal to show it."""
    _daily_run_done_today()

    def conflict(*_args, **_kwargs):
        raise RuntimeError("TransactionContext Error: Conflict")

    monkeypatch.setattr("arete.services.coach_followup.prepare", conflict)
    day = athlete_today().isoformat()
    response = client.put(f"/checkins/{day}", json={"sleep": 1, "legs": 3})
    assert response.status_code == 200
    assert len(_decisions()) == 1
    assert response.json()["replanned"] is True


def test_replanned_only_when_a_new_proposal_exists(db, client, monkeypatch):
    """No readiness: a low answer cannot decide anything, so nothing was replanned."""
    monkeypatch.setattr(
        "arete.services.metrics.load_form", lambda day=None: (None, None)
    )
    GarminRepository().create_planned_session(
        PlannedSession(
            date=athlete_today(),
            sport="running",
            session_type=SessionType.TEMPO,
            target_duration_min=45,
        )
    )
    _daily_run_done_today()
    day = athlete_today().isoformat()
    response = client.put(f"/checkins/{day}", json={"sleep": 1, "legs": 1})
    assert response.json()["replanned"] is False
    assert _decisions() == []


# --------------------------------------------------------------------------- #
# The briefing's facts
# --------------------------------------------------------------------------- #
def test_the_briefing_s_facts_carry_the_check_in_once_answered(db):
    from arete.services.briefing import (
        _rule_floor,
        briefing_facts,
        facts_changed,
        facts_digest,
    )
    from arete.services.coaching_repository import BriefingRepository

    today = athlete_today()
    rule_text, _, facts = _rule_floor(today)
    before = briefing_facts(today, rule_text, facts)
    assert "Check-in" not in before
    BriefingRepository().create(
        text="Écrit tôt.",
        briefing_date=today,
        priority="info",
        source="agent",
        status="ok",
        trigger="api",
        facts_digest=facts_digest(before),
    )
    briefing = BriefingRepository().get_for_day(today)
    assert briefing is not None and not facts_changed(briefing)

    checkins.save(today - timedelta(days=1), sleep=3, legs=1, note="Course hier soir")
    checkins.save(today, sleep=2, legs=4, mood=3)
    after = briefing_facts(today, rule_text)
    assert "Check-in déclaré par l'athlète :" in after
    assert "- ce matin : sommeil 2/5, jambes 4/5, motivation / stress 3/5" in after
    assert "- hier : sommeil 3/5, jambes 1/5" in after
    assert "« Course hier soir »" in after
    # The other sections still read their own data.
    assert "Dernières séances réalisées :\n- aucune" in after
    # Answered after the dashboard's briefing: the daily run may rewrite it.
    assert facts_changed(briefing)


# --------------------------------------------------------------------------- #
# Migration 49
# --------------------------------------------------------------------------- #
def _to_schema_48(path) -> None:
    con = duckdb.connect(str(path))
    configure_athlete(con)
    con.execute("DROP VIEW app.visible_daily_checkins")
    con.execute("DROP TABLE app.daily_checkins")
    con.execute("DELETE FROM app.schema_version WHERE version = 49")
    con.close()


def test_migration_49_runs_once_on_a_schema_48_database(db, monkeypatch):
    from arete.dataio import init_duckdb

    path = db / "checkins.duckdb"
    _to_schema_48(path)
    con = duckdb.connect(str(path))
    assert init_duckdb.pending_migrations(con) == [49]
    con.close()

    init_duckdb.main()
    init_duckdb.main()  # recorded once, then skipped

    checkins.save(athlete_today(), sleep=3, legs=3)
    con = duckdb.connect(str(path))
    count = con.execute(
        "SELECT count(*) FROM app.schema_version WHERE version = 49"
    ).fetchone()
    # The previous release (migrations up to 48) finds the database current
    # and never reads the new table.
    monkeypatch.setattr(init_duckdb, "MIGRATIONS", init_duckdb.MIGRATIONS[:-1])
    assert init_duckdb.pending_migrations(con) == []
    con.close()
    assert count == (1,)
    assert [r[1:3] for r in _rows()] == [(3, 3)]


def test_a_failed_migration_49_leaves_no_table_without_its_view(db, monkeypatch):
    from arete.dataio import init_duckdb, tenant_schema

    path = db / "checkins.duckdb"
    _to_schema_48(path)

    def broken_view(*_args):
        raise RuntimeError("view refresh failed")

    monkeypatch.setattr(tenant_schema, "_view", broken_view)
    con = duckdb.connect(str(path))
    configure_athlete(con)
    with pytest.raises(RuntimeError):
        init_duckdb._m49_daily_checkins(con)
    tables = con.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'app' AND table_name = 'daily_checkins'"
    ).fetchall()
    con.close()
    assert tables == []
