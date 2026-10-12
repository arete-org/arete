"""Web Push: bounded subscriptions, quiet failures, dead endpoints dropped."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from arete.dataio.db import connect
from arete.services import notifications


@pytest.fixture(autouse=True)
def _clean():
    yield
    con = connect()
    con.execute(
        "DELETE FROM app.push_subscriptions WHERE endpoint LIKE 'https://push.test/%'"
    )
    con.close()


@pytest.fixture
def keys(monkeypatch):
    monkeypatch.setenv("WEB_PUSH_VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setenv("WEB_PUSH_VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("WEB_PUSH_SUBJECT", "mailto:me@example.com")


def _endpoints() -> list[str]:
    return [
        e
        for e, _, _ in notifications._subscriptions()
        if e.startswith("https://push.test/")
    ]


def test_subscribe_upserts_and_keeps_the_newest_ten():
    for i in range(12):
        notifications.subscribe(f"https://push.test/{i}", "p", "a")
    notifications.subscribe("https://push.test/3", "p2", "a2")  # same browser again
    endpoints = _endpoints()
    assert len(endpoints) == notifications.MAX_SUBSCRIPTIONS
    assert "https://push.test/3" in endpoints
    notifications.unsubscribe("https://push.test/3")
    assert "https://push.test/3" not in _endpoints()


def test_nothing_is_sent_without_keys_or_with_notifications_off(keys, monkeypatch):
    notifications.subscribe("https://push.test/a", "p", "a")
    with patch(
        "arete.services.notifications.get_user_settings",
        return_value={"notifications_enabled": False},
    ):
        assert (
            notifications.notify("t", "b", kind=None).skipped_reason
            == "notifications désactivées"
        )
    monkeypatch.setenv("WEB_PUSH_VAPID_PRIVATE_KEY", "")
    assert (
        notifications.notify("t", "b", kind=None).skipped_reason
        == "clés Web Push absentes du serveur"
    )


def test_one_push_per_device_and_gone_devices_are_dropped(keys):
    from pywebpush import WebPushException

    notifications.subscribe("https://push.test/ok", "p", "a")
    notifications.subscribe("https://push.test/gone", "p", "a")
    notifications.subscribe("https://push.test/flaky", "p", "a")

    def push(subscription_info, **kwargs):
        endpoint = subscription_info["endpoint"]
        assert kwargs["vapid_claims"] == {"sub": "mailto:me@example.com"}
        assert kwargs["timeout"] == notifications.PUSH_TIMEOUT_S
        if endpoint.endswith("gone"):
            raise WebPushException("gone", response=MagicMock(status_code=410))
        if endpoint.endswith("flaky"):
            raise WebPushException("boom", response=MagicMock(status_code=500))

    with (
        patch("arete.services.notifications.get_user_settings", return_value={}),
        patch("pywebpush.webpush", side_effect=push),
    ):
        result = notifications.notify("Briefing", "Footing 45' en Z2.", "/", kind=None)
    assert (result.sent, result.dropped) == (1, 1)
    assert set(_endpoints()) == {"https://push.test/ok", "https://push.test/flaky"}


def test_first_sentence():
    assert (
        notifications.first_sentence("Charge stable. Footing en Z2.")
        == "Charge stable."
    )
    assert notifications.first_sentence("x" * 200).endswith("…")


def test_the_routes(keys, router_client):
    from arete.api.notifications import router

    client = router_client(router)
    assert client.get("/notifications/vapid-public-key").json() == {"key": "pub"}
    body = {"endpoint": "https://push.test/route", "keys": {"p256dh": "p", "auth": "a"}}
    assert client.post("/notifications/subscription", json=body).status_code == 204
    assert "https://push.test/route" in _endpoints()
    resp = client.request(
        "DELETE", "/notifications/subscription", json={"endpoint": body["endpoint"]}
    )
    assert resp.status_code == 204 and "https://push.test/route" not in _endpoints()
    assert (
        client.post("/notifications/test").json()["skipped_reason"]
        == "aucun appareil abonné"
    )
