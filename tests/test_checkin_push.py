"""The morning check-in's push: one a day, before the day's run (ARE-59)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services import checkins, notifications
from arete.services.settings import athlete_today


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "push.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    con = connect()
    con.execute("INSERT INTO app.athletes (id) VALUES (1) ON CONFLICT DO NOTHING")
    con.close()


def _rows() -> list[tuple]:
    con = connect()
    try:
        return con.execute("SELECT * FROM app.visible_daily_checkins").fetchall()
    finally:
        con.close()


#: 05:10 UTC: 07:10 in Paris in summer, 06:10 (quiet hours) in winter.
SUMMER = datetime(2026, 7, 13, 5, 10, tzinfo=UTC)
WINTER = datetime(2026, 1, 12, 5, 10, tzinfo=UTC)


@pytest.fixture
def device(db, monkeypatch):
    """One subscribed browser, the clocks frozen at ``now[0]``; nothing leaves."""
    from arete import scheduler
    from arete.services import notifications, settings

    monkeypatch.setenv("WEB_PUSH_VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setenv("WEB_PUSH_VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("WEB_PUSH_SUBJECT", "mailto:me@example.com")
    now = [SUMMER]
    for module in (scheduler, notifications, settings, checkins):
        monkeypatch.setattr(module, "utc_now", lambda: now[0])
    notifications.subscribe("https://push.test/checkin", "p", "a")
    with patch("pywebpush.webpush") as push:
        yield now, push


def _prefs(raw: str | None = None, *, enabled: bool = True) -> None:
    con = connect()
    con.execute(
        "INSERT INTO app.user_settings (user_id, timezone, notifications_enabled, "
        "notification_preferences) VALUES (1, 'Europe/Paris', ?, ?) "
        "ON CONFLICT (user_id) DO UPDATE SET "
        "notifications_enabled = EXCLUDED.notifications_enabled, "
        "notification_preferences = EXCLUDED.notification_preferences",
        [enabled, raw],
    )
    con.close()


def _dispatch(now: list[datetime], at: datetime) -> dict:
    from arete import scheduler

    now[0] = at
    return scheduler.run_checkin_prompts()["athletes"]


def test_one_push_a_day_deep_linked_to_the_card(device):
    now, push = device
    _prefs()
    assert _dispatch(now, SUMMER) == {"1": "1 sent"}
    # The 06:00 window, and a Docker tick, find the day spent.
    assert _dispatch(now, SUMMER + timedelta(hours=1)) == {
        "1": "already answered or prompted"
    }
    assert push.call_count == 1
    payload = json.loads(push.call_args.kwargs["data"])
    assert payload["url"] == "/?checkin=1"
    assert payload["title"] == "Check-in du matin"
    # The prompt's row is not an answer: the card still asks.
    assert checkins.get() is None and checkins.recent() == []


def test_quiet_hours_wait_for_the_next_window_without_spending_the_day(device):
    now, push = device
    _prefs()
    # 06:10 in Paris: quiet, not claimed.
    assert _dispatch(now, WINTER) == {}
    assert _rows() == []
    assert _dispatch(now, WINTER + timedelta(hours=1)) == {"1": "1 sent"}
    assert push.call_count == 1


def test_an_answered_day_gets_no_push(device):
    now, push = device
    _prefs()
    checkins.save(athlete_today(), sleep=4, legs=4)
    assert _dispatch(now, SUMMER) == {"1": "already answered or prompted"}
    assert push.call_count == 0


@pytest.mark.parametrize(
    ("raw", "enabled", "reason"),
    [
        ('{"kinds": {"checkin": false}}', True, "type de notification désactivé"),
        (None, False, "notifications désactivées"),
    ],
)
def test_a_declined_push_is_not_sent(device, raw, enabled, reason):
    now, push = device
    _prefs(raw, enabled=enabled)
    assert _dispatch(now, SUMMER) == {"1": reason}
    assert push.call_count == 0 and _rows() == []


def test_outside_the_morning_nothing_is_asked(device):
    now, push = device
    _prefs('{"quiet_hours": null}')
    # 04:10 and 12:10 in Paris, without quiet hours to hold them back.
    assert _dispatch(now, SUMMER - timedelta(hours=3)) == {}
    assert _dispatch(now, SUMMER + timedelta(hours=5)) == {}
    assert push.call_count == 0


def test_a_parked_athlete_is_not_asked(device):
    now, push = device
    _prefs()
    con = connect()
    con.execute(
        "UPDATE app.athletes SET sync_lease_until = ? WHERE id = 1",
        [(SUMMER + timedelta(days=365)).replace(tzinfo=None)],
    )
    con.close()
    assert _dispatch(now, SUMMER) == {}
    assert push.call_count == 0 and _rows() == []


def test_no_device_to_reach_does_not_spend_the_day(device, monkeypatch):
    now, push = device
    _prefs()
    monkeypatch.delenv("WEB_PUSH_VAPID_PRIVATE_KEY")
    assert _dispatch(now, SUMMER) == {"1": "clés Web Push absentes du serveur"}
    monkeypatch.setenv("WEB_PUSH_VAPID_PRIVATE_KEY", "priv")
    notifications.unsubscribe("https://push.test/checkin")
    assert _dispatch(now, SUMMER) == {"1": "aucun appareil abonné"}
    assert push.call_count == 0 and _rows() == []
    # Subscribed later that morning: the next window still asks.
    notifications.subscribe("https://push.test/checkin", "p", "a")
    assert _dispatch(now, SUMMER + timedelta(hours=1)) == {"1": "1 sent"}


def test_the_push_speaks_of_the_session_only_when_there_is_one(device):
    from arete.garmin.models import PlannedSession, SessionType
    from arete.garmin.repository import GarminRepository

    now, push = device
    _prefs()
    _dispatch(now, SUMMER)
    assert "séance" not in json.loads(push.call_args.kwargs["data"])["body"]

    con = connect()
    con.execute("DELETE FROM app.daily_checkins")
    con.close()
    GarminRepository().create_planned_session(
        PlannedSession(
            date=athlete_today(), sport="running", session_type=SessionType.TEMPO
        )
    )
    _dispatch(now, SUMMER + timedelta(hours=1))
    body = json.loads(push.call_args.kwargs["data"])["body"]
    assert "ajuster la séance du jour" in body
