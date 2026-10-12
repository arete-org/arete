"""The athlete chooses which pushes arrive, and none arrive in quiet hours."""

from __future__ import annotations

from datetime import UTC, datetime, time
from unittest.mock import patch

import duckdb
import pytest

from arete.dataio.db import connect
from arete.services import notifications, settings
from arete.services.settings import NotificationPreferences, QuietHours

#: 22:00 in Paris (summer time): inside the default quiet hours.
EVENING = datetime(2026, 10, 11, 20, 0, tzinfo=UTC)
#: 10:00 in Paris: outside them.
MORNING = datetime(2026, 10, 11, 8, 0, tzinfo=UTC)


@pytest.fixture
def device(monkeypatch):
    """One subscribed browser; the push service is mocked, nothing leaves."""
    monkeypatch.setenv("WEB_PUSH_VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setenv("WEB_PUSH_VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("WEB_PUSH_SUBJECT", "mailto:me@example.com")
    notifications.subscribe("https://push.test/prefs", "p", "a")
    with patch("pywebpush.webpush") as push:
        yield push
    con = connect()
    con.execute(
        "DELETE FROM app.push_subscriptions WHERE endpoint LIKE 'https://push.test/%'"
    )
    con.close()


def _send(prefs: dict | None, at: datetime, kind="briefing"):
    stored = {"timezone": "Europe/Paris", "notification_preferences": prefs}
    with (
        patch.object(notifications, "get_user_settings", return_value=stored),
        patch.object(notifications, "utc_now", return_value=at),
    ):
        return notifications.notify("Briefing du coach", "Footing.", "/", kind=kind)


def test_a_disabled_kind_is_never_sent(device):
    prefs = {"kinds": {"briefing": False}, "quiet_hours": None}
    result = _send(prefs, MORNING)
    assert result.skipped_reason == "type de notification désactivé"
    assert device.call_count == 0
    assert _send(prefs, MORNING, kind="weekly_review").sent >= 1
    assert device.call_count >= 1


def test_quiet_hours_drop_scheduled_pushes_but_not_the_test(device):
    assert _send(None, EVENING).skipped_reason == "heures calmes"
    assert device.call_count == 0
    assert _send(None, MORNING).sent >= 1
    assert _send({"quiet_hours": None}, EVENING).sent >= 1
    # The athlete's own test button is sent whatever the hour.
    assert _send(None, EVENING, kind=None).sent >= 1


def test_quiet_hours_may_span_midnight():
    night = QuietHours()
    assert night.covers(time(21, 30)) and night.covers(time(3, 0))
    assert not night.covers(time(7, 0)) and not night.covers(time(12, 0))
    lunch = QuietHours(start="12:00", end="14:00")
    assert lunch.covers(time(13, 0)) and not lunch.covers(time(14, 0))
    assert not QuietHours(start="08:00", end="08:00").covers(time(8, 0))


def test_stored_preferences_default_to_everything_on():
    prefs = settings.stored_preferences(None).complete()
    assert set(prefs.kinds) == set(settings.NOTIFICATION_KINDS)
    assert all(prefs.kinds.values())
    assert prefs.quiet_hours == QuietHours(start="21:30", end="07:00")
    # A kind a later release dropped is ignored rather than failing the read.
    legacy = settings.stored_preferences({"kinds": {"gone": False, "imports": False}})
    assert not legacy.allows("imports") and legacy.allows("briefing")


@pytest.fixture
def own_athlete():
    """A private athlete: the shared settings row of athlete 1 stays untouched."""
    from arete.services.athlete_scope import athlete_scope

    athlete_id = 9057
    con = connect()
    con.execute(
        "INSERT INTO app.athletes (id) VALUES (?) ON CONFLICT DO NOTHING", [athlete_id]
    )
    con.close()
    with athlete_scope(athlete_id):
        yield
    con = connect()
    con.execute("DELETE FROM app.user_settings WHERE user_id = ?", [athlete_id])
    con.execute("DELETE FROM app.athletes WHERE id = ?", [athlete_id])
    con.close()


def test_the_settings_form_round_trips_and_older_clients_keep_the_choice(own_athlete):
    from arete.services.settings import (
        UserSettingsUpdate,
        get_settings,
        update_settings,
    )

    assert get_settings().notification_preferences.kinds["post_session"] is True
    chosen = NotificationPreferences(
        kinds={"imports": False}, quiet_hours=QuietHours(start="22:00", end="06:30")
    )
    saved = update_settings(UserSettingsUpdate(notification_preferences=chosen))
    prefs = saved.notification_preferences
    assert prefs.kinds["imports"] is False and prefs.kinds["briefing"] is True
    assert prefs.quiet_hours == QuietHours(start="22:00", end="06:30")
    # A client that predates the field sends none: the choice is kept.
    kept = update_settings(UserSettingsUpdate(theme="pierre"))
    assert kept.notification_preferences == prefs
    assert get_settings().notification_preferences == prefs


def test_an_impossible_quiet_hour_is_refused(client):
    payload = {"notification_preferences": {"quiet_hours": {"start": "25:00"}}}
    assert client.put("/settings", json=payload).status_code == 422


def test_migration_45_on_a_current_schema(tmp_path, monkeypatch):
    from arete.dataio import init_duckdb
    from arete.dataio.db import configure_athlete

    path = tmp_path / "current.duckdb"
    monkeypatch.setenv("ARETE_DB", str(path))
    init_duckdb.main()
    # Back to the shape every deployed database has before this release.
    con = duckdb.connect(str(path))
    configure_athlete(con)
    con.execute("DROP VIEW app.visible_user_settings")
    con.execute("ALTER TABLE app.user_settings DROP COLUMN notification_preferences")
    con.execute("DELETE FROM app.schema_version WHERE version = 45")
    # The schema main deploys today: everything up to 44, only 45 pending.
    assert init_duckdb.pending_migrations(con) == [45]
    con.close()

    init_duckdb.main()

    con = duckdb.connect(str(path), read_only=True)
    configure_athlete(con)
    row = con.execute(
        "SELECT notification_preferences, notifications_enabled "
        "FROM app.visible_user_settings WHERE user_id = 1"
    ).fetchone()
    versions = {
        v for (v,) in con.execute("SELECT version FROM app.schema_version").fetchall()
    }
    con.close()
    # Existing athletes read NULL: every kind on, as before the migration.
    assert row == (None, True)
    assert 45 in versions
