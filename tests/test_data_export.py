"""The data export: allowlisted tables and journal, never a credential, bounded."""

from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from datetime import date

import pytest

from arete.api.data_export import router
from arete.dataio.db import connect
from arete.services import data_export
from arete.services.memory import memory_root

SECRETS = ("test-export-access-token", "test-export-garmin-oauth", "test-export-p256")
ARCHIVE = "sessions-2001-01.md"


@pytest.fixture
def stored():
    con = connect()
    con.execute(
        """
        INSERT INTO app.actual_sessions (user_id, date, sport, name, duration_sec, source)
        VALUES (1, '2001-01-10', 'running', 'test-export Garmin', 1800, 'garmin_connect'),
               (1, '2001-02-10', 'running', 'test-export Strava', 2400, 'strava')
        """
    )
    con.execute(
        "INSERT INTO app.daily_metrics (user_id, date, resting_hr) "
        "VALUES (1, '2001-01-10', 48)"
    )
    con.execute(
        "INSERT INTO app.goals (user_id, name, race_date, distance_km) "
        "VALUES (1, 'test-export goal', '2001-06-01', 10)"
    )
    con.execute(
        "INSERT OR REPLACE INTO app.strava_tokens "
        "(user_id, access_token, refresh_token, expires_at) VALUES (99, ?, ?, 0)",
        [SECRETS[0], SECRETS[0]],
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS app.files "
        "(path VARCHAR PRIMARY KEY, content BLOB NOT NULL, updated_at TIMESTAMP)"
    )
    con.execute(
        "INSERT OR REPLACE INTO app.files (path, content) VALUES "
        "('garmin_tokens/test-export.json', ?)",
        [SECRETS[1].encode()],
    )
    con.execute(
        "INSERT OR REPLACE INTO app.push_subscriptions (endpoint, p256dh, auth) "
        "VALUES ('https://push.test/export', ?, ?)",
        [SECRETS[2], SECRETS[2]],
    )
    con.close()
    memory_root().mkdir(parents=True, exist_ok=True)
    archive = memory_root() / ARCHIVE
    archive.write_text("## 2001-01-10 — Footing\nBonnes jambes.\n", encoding="utf-8")
    yield
    archive.unlink()
    con = connect()
    con.execute("DELETE FROM app.actual_sessions WHERE name LIKE 'test-export%'")
    con.execute("DELETE FROM app.daily_metrics WHERE date = '2001-01-10'")
    con.execute("DELETE FROM app.goals WHERE name = 'test-export goal'")
    con.execute("DELETE FROM app.strava_tokens WHERE user_id = 99")
    con.execute("DELETE FROM app.files WHERE path = 'garmin_tokens/test-export.json'")
    con.execute(
        "DELETE FROM app.push_subscriptions WHERE endpoint = 'https://push.test/export'"
    )
    con.close()


def _zip(content: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return {n: archive.read(n).decode("utf-8-sig") for n in archive.namelist()}


def test_zip_has_one_csv_per_table_and_the_journal(stored):
    files = _zip(data_export.build("zip").content)
    tables = {t.name for t in data_export.TABLES} - data_export.OPT_IN
    assert {f"{t}.csv" for t in tables} <= set(files)
    # Streams weigh too much for a whole history: only on request.
    assert "activity_streams.csv" not in files
    assert files[f"journal/{ARCHIVE}"].startswith("## 2001-01-10")
    sessions = list(csv.DictReader(io.StringIO(files["actual_sessions.csv"])))
    names = {row["name"] for row in sessions}
    # The athlete's own download keeps Strava's rows.
    assert {"test-export Garmin", "test-export Strava"} <= names


def test_no_credential_ever_leaves(stored):
    blobs = [data_export.build("json").content]
    blobs += [c.encode() for c in _zip(data_export.build("zip").content).values()]
    for blob in blobs:
        for secret in SECRETS:
            assert secret.encode() not in blob


def test_exported_columns_carry_no_secret():
    """A credential column added to an exported table must fail here first."""
    data = data_export.collect(names=[t.name for t in data_export.TABLES])
    pattern = re.compile(r"token|secret|password|p256dh|^auth$", re.IGNORECASE)
    leaks = [
        f"{name}.{column}"
        for name, (columns, _) in data.tables.items()
        for column in columns
        if pattern.search(column)
    ]
    assert leaks == []


def test_the_range_filters_dated_tables_only(stored):
    body = json.loads(
        data_export.build(
            "json",
            start=date(2001, 1, 1),
            end=date(2001, 1, 31),
        ).content
    )
    sessions = [r["name"] for r in body["tables"]["actual_sessions"]]
    assert "test-export Garmin" in sessions
    assert "test-export Strava" not in sessions
    assert all(
        r["date"].startswith("2001-01") for r in body["tables"]["actual_sessions"]
    )
    # Goals, facts and the journal come whole whatever the range.
    assert any(g["name"] == "test-export goal" for g in body["tables"]["goals"])
    assert ARCHIVE in body["journal"]
    assert body["start"] == "2001-01-01"


def test_a_session_s_feedback_and_streams_leave_dated_by_their_session(stored):
    con = connect()
    (session_id,) = con.execute(
        "SELECT id FROM app.actual_sessions WHERE name = 'test-export Garmin'"
    ).fetchone()
    con.execute(
        "INSERT INTO app.session_feedback (actual_session_id, text, source, trigger) "
        "VALUES (?, 'test-export bien géré', 'agent', 'sync')",
        [session_id],
    )
    con.execute(
        "INSERT INTO app.activity_streams (actual_session_id, sample_count, t_sec) "
        "VALUES (?, 2, [0, 1])",
        [session_id],
    )
    con.close()
    try:
        january = {"start": date(2001, 1, 1), "end": date(2001, 1, 31)}
        body = json.loads(data_export.build("json", **january).content)
        [feedback] = body["tables"]["session_feedback"]
        assert (feedback["date"], feedback["text"]) == (
            "2001-01-10",
            "test-export bien géré",
        )
        assert "activity_streams" not in body["tables"]
        asked = json.loads(
            data_export.build("json", names=["activity_streams"], **january).content
        )
        [stream] = asked["tables"]["activity_streams"]
        assert stream["actual_session_id"] == session_id
        later = data_export.build(
            "json", start=date(2001, 2, 1), names=["session_feedback"]
        ).content
        assert json.loads(later)["tables"]["session_feedback"] == []
    finally:
        con = connect()
        for table in ("session_feedback", "activity_streams"):
            con.execute(
                f"DELETE FROM app.{table} WHERE actual_session_id = ?", [session_id]
            )
        con.close()


def test_the_settings_page_offers_exactly_what_the_server_exports():
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[1] / "frontend/src/lib/dataExport.ts"
    ).read_text(encoding="utf-8")
    listed = re.findall(r"\{ id: '(\w+)', label: '[^']*'(, optIn: true)? \}", source)
    names = [name for name, _ in listed]
    assert sorted(names) == sorted(data_export.EXPORT_NAMES)
    assert {name for name, opt_in in listed if opt_in} == data_export.OPT_IN


def test_api_downloads_selected_tables_as_an_attachment(stored, router_client):
    client = router_client(router)
    response = client.get(
        "/export/json", params=[("tables", "goals"), ("tables", "journal")]
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.headers["cache-control"] == "no-store"
    assert (
        'attachment; filename="arete-export-' in response.headers["content-disposition"]
    )
    body = response.json()
    assert set(body["tables"]) == {"goals"}
    zipped = client.get("/export/zip", params={"tables": "daily_metrics"})
    assert set(_zip(zipped.content)) == {"daily_metrics.csv"}


def test_api_refuses_bad_requests(router_client):
    client = router_client(router)
    assert client.get("/export/parquet").status_code == 422
    assert client.get("/export/zip", params={"tables": "users"}).status_code == 422
    bad_range = client.get(
        "/export/zip", params={"start": "2026-02-01", "end": "2026-01-01"}
    )
    assert bad_range.status_code == 422


def test_api_refuses_an_export_past_the_response_limit(router_client, monkeypatch):
    monkeypatch.setattr(data_export, "EXPORT_LIMIT_BYTES", 10)
    response = router_client(router).get("/export/json")
    assert response.status_code == 413
    assert "période plus courte" in response.json()["detail"]


def test_the_morning_check_ins_leave_with_their_answers_only():
    con = connect()
    con.execute(
        "INSERT INTO app.daily_checkins (date, sleep, legs, mood, note, answered_at, "
        "updated_at) VALUES ('2001-01-10', 2, 4, NULL, 'test-export nuit courte', "
        "'2001-01-10 05:12', '2001-01-10 05:12')"
    )
    # The push of a day never answered: no answer to export.
    con.execute(
        "INSERT INTO app.daily_checkins (date, prompted_at) "
        "VALUES ('2001-01-11', '2001-01-11 05:05')"
    )
    con.close()
    try:
        body = json.loads(
            data_export.build(
                "json", start=date(2001, 1, 1), end=date(2001, 1, 31)
            ).content
        )
    finally:
        con = connect()
        con.execute("DELETE FROM app.daily_checkins WHERE date < '2002-01-01'")
        con.close()
    [row] = body["tables"]["daily_checkins"]
    assert (row["date"], row["sleep"], row["legs"]) == ("2001-01-10", 2, 4)
    assert row["note"] == "test-export nuit courte"
    assert "prompted_at" not in row


def test_a_review_being_written_is_not_exported():
    con = connect()
    con.execute(
        "INSERT INTO app.weekly_reviews (week_start, text, source, proposals_json) "
        "VALUES ('2001-01-01', 'Semaine tenue.', 'agent', '[]'), "
        "('2001-01-08', '', 'pending', '[]')"
    )
    con.close()
    try:
        body = json.loads(
            data_export.build(
                "json", start=date(2001, 1, 1), end=date(2001, 1, 31)
            ).content
        )
    finally:
        con = connect()
        con.execute("DELETE FROM app.weekly_reviews WHERE week_start < '2002-01-01'")
        con.close()
    assert [r["week_start"] for r in body["tables"]["weekly_reviews"]] == ["2001-01-01"]


def test_briefings_leave_with_the_athlete_s_reactions_and_no_one_else_s(
    tmp_path, monkeypatch
):
    """GDPR portability: what the athlete wrote on a briefing is theirs (ARE-106)."""
    from arete.dataio.init_duckdb import main as init_schema
    from arete.services.athlete_scope import athlete_scope
    from arete.services.coaching_repository import BriefingRepository
    from arete.services.users import upsert_user

    # A database of its own: a second athlete must not outlive this test.
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "export.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    init_schema()
    repo = BriefingRepository()
    mine = repo.create(text="Footing facile.", briefing_date=date(2001, 1, 10))
    repo.react(mine, "down", "Trop prudent.")
    other = upsert_user("other", "other@example.com", "Other", verified=True)
    with athlete_scope(other.athlete_id):
        theirs = repo.create(text="Leur briefing.", briefing_date=date(2001, 1, 10))
        repo.react(theirs, "up", "Leur avis.")

    body = json.loads(
        data_export.build("json", names=["coach_briefings"]).content.decode()
    )
    [row] = body["tables"]["coach_briefings"]
    assert (row["date"], row["text"], row["source"]) == (
        "2001-01-10",
        "Footing facile.",
        "rules",
    )
    assert (row["reaction"], row["reaction_comment"]) == ("down", "Trop prudent.")
    assert row["created_at"] and row["reacted_at"]
    # Same table, same columns as a CSV: the format of every other table.
    csv_text = _zip(data_export.build("zip", names=["coach_briefings"]).content)[
        "coach_briefings.csv"
    ]
    [header, line] = list(csv.reader(io.StringIO(csv_text)))
    assert dict(zip(header, line, strict=True))["reaction_comment"] == "Trop prudent."
    assert "Leur" not in csv_text


def test_a_timestamp_late_on_the_end_day_is_inside_the_range():
    con = connect()
    con.execute(
        "INSERT INTO app.notifications (id, event_key, kind, title, body, url, created_at) "
        "VALUES ('test-export-late', 'test-export-late', 'briefing', 'Briefing', 'Corps', "
        "'/', TIMESTAMPTZ '2001-01-31 23:30:00'), ('test-export-next', "
        "'test-export-next', 'briefing', 'Briefing', 'Corps', '/', "
        "TIMESTAMPTZ '2001-02-01 00:00:00')"
    )
    con.close()
    try:
        body = json.loads(
            data_export.build(
                "json",
                start=date(2001, 1, 31),
                end=date(2001, 1, 31),
                names=["notifications"],
            ).content
        )
    finally:
        con = connect()
        con.execute("DELETE FROM app.notifications WHERE id LIKE 'test-export-%'")
        con.close()
    assert [r["id"] for r in body["tables"]["notifications"]] == ["test-export-late"]


def _text(words: int) -> str:
    """An SQL expression of about 10 * ``words`` characters, compressing like prose."""
    return (
        f"array_to_string(list_transform(range({words}), "
        "k -> md5(i::VARCHAR || '-' || k::VARCHAR)[1:8 + (k % 5)]), ' ')"
    )


@pytest.fixture
def five_years():
    """A long-time athlete: five years of sessions, health, feedback and coaching."""
    laps = (
        "to_json(list_transform(range(12), k -> {'lap': k, 'sec': (random() * 400)::INT, "
        "'dist': (random() * 1000)::INT, 'hr': (120 + random() * 50)::INT, "
        "'max_hr': (150 + random() * 30)::INT, 'pace': (240 + random() * 120)::INT, "
        "'cadence': (160 + random() * 30)::INT, 'ascent': (random() * 40)::INT}))::VARCHAR"
    )
    days = "range(1825) t(i)"
    statements = [
        "INSERT INTO app.actual_sessions (user_id, date, sport, name, notes, duration_sec, "
        "distance_m, avg_hr, laps_json, splits_json, source) "
        f"SELECT 1, DATE '1990-01-01' + i::INT, 'running', 'test-five Footing', {_text(20)}, "
        f"3600, 10000, 140, {laps}, {laps}, 'garmin_connect' FROM {days}",
        "INSERT INTO app.planned_sessions (user_id, date, sport, session_type, description, "
        f"structure_json) SELECT 1, DATE '1990-01-01' + i::INT, 'running', 'endurance', "
        f"{_text(25)}, {laps} FROM {days}",
        "INSERT INTO app.daily_metrics (user_id, date, resting_hr, hrv_last_night, "
        "sleep_score, steps, training_readiness_feedback) SELECT 1, "
        f"DATE '1990-01-01' + i::INT, 48, 60, 80, 9000, {_text(10)} FROM {days}",
        "INSERT INTO app.session_feedback (actual_session_id, text, source, trigger) "
        f"SELECT s.id, {_text(60)}, 'agent', 'sync' FROM (SELECT id, id AS i FROM "
        "app.actual_sessions WHERE name = 'test-five Footing') s",
        "INSERT INTO app.weekly_reviews (week_start, text, source, proposals_json) "
        f"SELECT DATE '1990-01-01' + (i * 7)::INT, {_text(300)}, 'agent', '[]' "
        "FROM range(260) t(i)",
        "INSERT INTO app.daily_checkins (date, sleep, legs, mood, note, answered_at) "
        f"SELECT DATE '1990-01-01' + i::INT, 3, 3, 3, {_text(6)}, "
        f"TIMESTAMP '1990-01-01 06:00' + i * INTERVAL 1 DAY FROM {days}",
        # Heavy histories the default leaves out: a briefing and a decision a day.
        "INSERT INTO app.coach_briefings (date, text, priority, source, status, trigger) "
        f"SELECT DATE '1990-01-01' + i::INT, {_text(200)}, 'info', 'agent', 'ok', 'sync' "
        f"FROM {days}",
        "INSERT INTO app.plan_decisions (date, planned_session_id, decision, reason, "
        f"original_json, adapted_json) SELECT DATE '1990-01-01' + i::INT, i::INT, 'keep', "
        f"{_text(30)}, {laps}, {laps} FROM {days}",
    ]
    con = connect()
    for statement in statements:
        con.execute(statement)
    con.close()
    yield
    con = connect()
    con.execute(
        "DELETE FROM app.session_feedback WHERE actual_session_id IN "
        "(SELECT id FROM app.actual_sessions WHERE name = 'test-five Footing')"
    )
    for table in (
        "actual_sessions",
        "planned_sessions",
        "daily_metrics",
        "daily_checkins",
        "coach_briefings",
        "plan_decisions",
    ):
        con.execute(f"DELETE FROM app.{table} WHERE date < '1995-01-01'")
    con.execute("DELETE FROM app.weekly_reviews WHERE week_start < '1996-01-01'")
    con.close()


def test_the_default_export_fits_one_response_for_years_of_history(five_years):
    """What the deletion screen suggests downloading must not be refused."""
    content = data_export.build("zip").content
    assert len(content) <= data_export.EXPORT_LIMIT_BYTES
    files = _zip(content)
    assert "coach_briefings.csv" not in files and "plan_decisions.csv" not in files
    assert len(files["actual_sessions.csv"].splitlines()) > 1825
    # Every opt-in table together would not fit: they come one choice away.
    everything = [n for n in data_export.EXPORT_NAMES]
    with pytest.raises(data_export.ExportTooLarge):
        data_export.build("zip", names=everything)
    asked = data_export.build(
        "zip", start=date(1994, 1, 1), names=["coach_briefings", "plan_decisions"]
    ).content
    assert set(_zip(asked)) == {"coach_briefings.csv", "plan_decisions.csv"}
