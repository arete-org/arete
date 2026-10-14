"""The dashboard's briefing: a reaction per briefing, the previous days, its times."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import duckdb
import pytest

from arete.dataio.db import configure_athlete, connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services.athlete_scope import athlete_scope
from arete.services.coaching_repository import BriefingRepository
from arete.services.settings import athlete_today


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A database of its own: the history reads every day the athlete has."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "briefings.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    init_schema()
    return BriefingRepository()


def _write(repo, day: date, text: str, **fields) -> int:
    return repo.create(text=text, briefing_date=day, **fields)


def _row(briefing_id: int):
    con = connect()
    try:
        return con.execute(
            "SELECT reaction, reaction_comment, reacted_at FROM app.coach_briefings WHERE id = ?",
            [briefing_id],
        ).fetchone()
    finally:
        con.close()


def test_a_reaction_is_stored_once_per_briefing_and_idempotent(db, client):
    briefing = _write(db, athlete_today(), "Footing facile.")
    body = {"reaction": "up", "comment": "  Pile ce qu'il fallait.  "}

    first = client.put(f"/tips/briefings/{briefing}/reaction", json=body)
    stored = _row(briefing)
    again = client.put(f"/tips/briefings/{briefing}/reaction", json=body)

    assert first.status_code == again.status_code == 200
    assert (
        first.json()
        == again.json()
        == {
            "id": briefing,
            "reaction": "up",
            "reaction_comment": "Pile ce qu'il fallait.",
        }
    )
    # The same answer again changes nothing, not even its time.
    assert _row(briefing) == stored and stored[2] is not None
    # The day's briefing carries it, so the dashboard shows it after a reload.
    tip = client.get("/tips/daily").json()
    assert (tip["id"], tip["reaction"], tip["reaction_comment"]) == (
        briefing,
        "up",
        "Pile ce qu'il fallait.",
    )


def test_a_reaction_can_change_or_be_withdrawn(db, client):
    briefing = _write(db, athlete_today(), "Repos.")
    url = f"/tips/briefings/{briefing}/reaction"
    client.put(url, json={"reaction": "up"})
    assert client.put(url, json={"reaction": "down"}).json()["reaction"] == "down"
    assert client.put(url, json={"reaction": None}).json()["reaction"] is None
    assert _row(briefing) == (None, None, None)


@pytest.mark.parametrize(
    "body",
    [
        {"reaction": "meh"},
        {"reaction": None, "comment": "Sans réaction"},
        {"reaction": "up", "comment": "x" * 281},
        {},
    ],
)
def test_an_invalid_reaction_is_refused(db, client, body):
    briefing = _write(db, athlete_today(), "Tempo.")
    assert (
        client.put(f"/tips/briefings/{briefing}/reaction", json=body).status_code == 422
    )
    assert _row(briefing) == (None, None, None)


def test_only_a_usable_briefing_of_the_athlete_takes_a_reaction(db, client):
    from arete.services.users import upsert_user

    failed = _write(db, athlete_today(), "", status="failed", error="timeout")
    other = upsert_user("other", "other@example.com", "Other", verified=True)
    with athlete_scope(other.athlete_id):
        theirs = _write(db, athlete_today(), "Leur briefing.")
    for briefing in (failed, theirs, 999_999):
        reply = client.put(
            f"/tips/briefings/{briefing}/reaction", json={"reaction": "up"}
        )
        assert reply.status_code == 404
    with athlete_scope(other.athlete_id):
        assert db.get(theirs).reaction is None


def test_the_history_lists_the_previous_seven_days_of_the_athlete(db, client):
    from arete.services.users import upsert_user

    today = athlete_today()
    _write(db, today, "Aujourd'hui.")  # the card shows it, not the history
    for ago in range(1, 10):
        _write(db, today - timedelta(days=ago), f"Il y a {ago} jours.")
    # A rewritten day shows its last briefing once, and a failed run never.
    rewritten = _write(db, today - timedelta(days=1), "Hier, après la synchro.")
    _write(db, today - timedelta(days=2), "", status="failed", error="timeout")
    other = upsert_user("other", "other@example.com", "Other", verified=True)
    with athlete_scope(other.athlete_id):
        _write(db, today - timedelta(days=1), "Pas le mien.")

    items = client.get("/tips/history").json()

    assert [i["tip"] for i in items] == [
        "Hier, après la synchro.",
        *(f"Il y a {ago} jours." for ago in range(2, 8)),
    ]
    assert items[0]["id"] == rewritten
    assert [i["date"] for i in items] == [
        (today - timedelta(days=ago)).isoformat() for ago in range(1, 8)
    ]
    assert {"generated_at", "source", "reaction", "reaction_comment"} <= items[0].keys()


def test_a_briefing_rewritten_by_the_sync_says_when_it_was_first_written(db, client):
    today = athlete_today()
    first = _write(db, today, "Écrit avant la synchro.", trigger="api")
    con = connect()
    try:
        # The first one was written at 7:12; the sync rewrote it later.
        con.execute(
            "UPDATE app.coach_briefings SET created_at = ? WHERE id = ?",
            [
                datetime.combine(today, datetime.min.time())
                + timedelta(hours=7, minutes=12),
                first,
            ],
        )
    finally:
        con.close()
    _write(db, today, "Réécrit après la synchro.", trigger="scheduler")

    tip = client.get("/tips/daily").json()

    assert tip["tip"] == "Réécrit après la synchro."
    assert tip["updated_after_sync"] is True
    written = datetime.fromisoformat(tip["first_written_at"])
    assert (written.hour, written.minute) == (7, 12) and written.tzinfo is not None
    assert datetime.fromisoformat(tip["generated_at"]).tzinfo is not None


def test_a_briefing_written_once_has_no_first_time_of_its_own(db, client):
    _write(db, athlete_today(), "Une seule fois.")
    tip = client.get("/tips/daily").json()
    assert tip["first_written_at"] is None and tip["updated_after_sync"] is False


def test_a_second_api_write_is_not_announced_as_a_sync_rewrite(db, client):
    _write(db, athlete_today(), "Premier.", trigger="api")
    _write(db, athlete_today(), "Second.", trigger="api")
    tip = client.get("/tips/daily").json()
    assert tip["tip"] == "Second."
    assert tip["updated_after_sync"] is False and tip["first_written_at"] is None


def test_the_coach_reads_a_referenced_briefing_of_the_athlete(db):
    from arete.services.coach_today import reference
    from arete.services.users import upsert_user

    yesterday = athlete_today() - timedelta(days=1)
    briefing = _write(db, yesterday, "Garde l'allure facile.")
    assert (
        reference(f"briefing:{briefing}")["record"]["text"] == "Garde l'allure facile."
    )
    other = upsert_user("other", "other@example.com", "Other", verified=True)
    with athlete_scope(other.athlete_id), pytest.raises(LookupError):
        reference(f"briefing:{briefing}")


def test_migration_48_adds_the_reaction_columns_once(tmp_path, monkeypatch):
    from arete.dataio import init_duckdb
    from arete.dataio.tenant_schema import _view

    path = tmp_path / "current.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    # Back to the shape every deployed database has before this release,
    # its private view included: the migration alters a table a view reads.
    con = duckdb.connect(str(path))
    configure_athlete(con)
    con.execute("DROP VIEW app.visible_coach_briefings")
    for column in ("reaction", "reaction_comment", "reacted_at"):
        con.execute(f"ALTER TABLE app.coach_briefings DROP COLUMN {column}")
    _view(con, "coach_briefings")
    con.execute(
        "INSERT INTO app.coach_briefings (user_id, date, text) VALUES (1, '2026-10-13', 'Avant.')"
    )
    con.execute("DELETE FROM app.schema_version WHERE version = 48")
    assert init_duckdb.pending_migrations(con) == [48]
    con.close()

    init_duckdb.main()
    init_duckdb.main()  # recorded once, then skipped

    con = duckdb.connect(str(path), read_only=True)
    configure_athlete(con)
    # A read through the private view works, and sees the new columns empty.
    row = con.execute(
        "SELECT text, reaction, reaction_comment, reacted_at FROM app.visible_coach_briefings"
    ).fetchone()
    count = con.execute(
        "SELECT count(*) FROM app.schema_version WHERE version = 48"
    ).fetchone()
    con.close()
    assert row == ("Avant.", None, None, None)
    assert count == (1,)


def test_a_failed_migration_48_leaves_the_table_and_its_view_readable(
    tmp_path, monkeypatch
):
    from arete.dataio import init_duckdb, tenant_schema

    path = tmp_path / "failing.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    con = duckdb.connect(str(path))
    configure_athlete(con)
    con.execute("DROP VIEW app.visible_coach_briefings")
    for column in ("reaction", "reaction_comment", "reacted_at"):
        con.execute(f"ALTER TABLE app.coach_briefings DROP COLUMN {column}")
    tenant_schema._view(con, "coach_briefings")

    def broken_view(*_args):
        raise RuntimeError("view refresh failed")

    monkeypatch.setattr(tenant_schema, "_view", broken_view)
    with pytest.raises(RuntimeError):
        init_duckdb._m48_briefing_reactions(con)
    # Rolled back as a whole: no column without its view.
    columns = {r[0] for r in con.execute("DESCRIBE app.coach_briefings").fetchall()}
    assert "reaction" not in columns
    assert con.execute("SELECT count(*) FROM app.visible_coach_briefings").fetchone()
    con.close()


@pytest.fixture
def process_timezone():
    """Sets the process timezone, as Docker (Paris) and Vercel (UTC) differ."""
    import os
    import time

    previous = os.environ.get("TZ")

    def use(zone: str) -> None:
        os.environ["TZ"] = zone
        time.tzset()

    yield use
    if previous is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = previous
    time.tzset()


@pytest.mark.parametrize(
    ("writer", "reader"), [("Europe/Paris", "UTC"), ("UTC", "Europe/Paris")]
)
def test_briefing_times_mean_one_instant_across_instances(
    db, client, process_timezone, writer, reader
):
    from datetime import UTC

    # Written by one instance (the Docker stack, the Vercel cron)...
    process_timezone(writer)
    before = datetime.now(UTC)
    briefing = _write(db, athlete_today(), "Écrit ailleurs.")
    client.put(f"/tips/briefings/{briefing}/reaction", json={"reaction": "up"})
    after = datetime.now(UTC)
    # ...read by another, on the same database.
    process_timezone(reader)
    tip = client.get("/tips/daily").json()

    written = datetime.fromisoformat(tip["generated_at"])
    assert written.utcoffset() == timedelta(0)
    assert before - timedelta(seconds=1) <= written <= after + timedelta(seconds=1)
    reacted = _row(briefing)[2].replace(tzinfo=UTC)  # stored naive UTC
    assert before - timedelta(seconds=1) <= reacted <= after + timedelta(seconds=1)
