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
    tables = {t.name for t in data_export.TABLES}
    assert {f"{t}.csv" for t in tables} <= set(files)
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
