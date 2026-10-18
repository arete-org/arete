"""Consent to the terms and to health data processing (GDPR art. 9), ARE-127.

A fresh account reaches nothing that imports, stores or sends its data to a
model before consenting; a withdrawal pauses every job without deleting data.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from arete.api import auth
from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.services import consent
from arete.services.athlete_scope import athlete_scope, current_athlete_id
from arete.services.users import upsert_user

ROOT = Path(__file__).resolve().parents[1]
#: Monday 10:00 UTC, noon in Paris: every athlete is owed the daily run.
NOON = datetime(2026, 10, 12, 10, 0, tzinfo=UTC)
ACCEPT = {
    "terms_version": consent.TERMS_VERSION,
    "privacy_version": consent.PRIVACY_VERSION,
    "terms_accepted": True,
    "health_data": True,
}
#: Every route a fresh account must not reach: Garmin, file import, the
#: coach and its briefings, and an ordinary data read.
GATED = [
    ("post", "/garmin/sync/login"),
    ("post", "/garmin/sync/activities"),
    ("post", "/garmin/health/sync"),
    ("post", "/garmin/upload-fit"),
    ("post", "/agent/chat"),
    ("post", "/agent/chat/stream"),
    ("post", "/tips/daily"),
    ("post", "/strava/sync"),
    ("get", "/dashboard"),
    ("get", "/settings"),
]


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    """Two accounts on a private database, sign-in on, nobody consented yet."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "consent.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "first@example.com")
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    monkeypatch.delenv("ARETE_API_KEY", raising=False)
    init_schema()
    first = upsert_user("first", "first@example.com", "First", verified=True)
    second = upsert_user("second", "second@example.com", "Second", verified=True)
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "pk_test_fake")
    monkeypatch.setattr(auth, "_verify_session_token", lambda token: {"sub": token})
    return first, second


def bearer(user) -> dict[str, str]:
    return {"Authorization": f"Bearer {user.clerk_user_id}"}


def rows(athlete_id: int) -> list[tuple]:
    con = connect()
    try:
        return con.execute(
            "SELECT user_id, terms_version, privacy_version, health_data, "
            "consented_at, withdrawn_at FROM app.athlete_consents "
            "WHERE athlete_id = ? ORDER BY id",
            [athlete_id],
        ).fetchall()
    finally:
        con.close()


def test_a_fresh_account_reaches_nothing_but_its_account_and_export(accounts, client):
    first, _ = accounts
    me = client.get("/auth/me", headers=bearer(first))
    assert me.status_code == 200
    assert me.json()["consent"] == {
        "required": True,
        "current": False,
        "terms_version": consent.TERMS_VERSION,
        "privacy_version": consent.PRIVACY_VERSION,
        "latest": None,
    }
    for method, path in GATED:
        refused = getattr(client, method)(path, headers=bearer(first))
        assert refused.status_code == 403, path
        assert refused.json() == {"detail": consent.CONSENT_REQUIRED_DETAIL}, path
        # A stable marker, not the French text, tells the browser why.
        assert refused.headers[auth.CONSENT_HEADER] == "required", path
    # The deployment's prefix is gated as well.
    assert client.get("/api/settings", headers=bearer(first)).status_code == 403
    # The right of access does not wait for consent.
    assert client.get("/export/json", headers=bearer(first)).status_code == 200


def test_consent_is_recorded_with_versions_login_and_time(accounts, client):
    first, second = accounts
    before = datetime.now(UTC).replace(tzinfo=None)
    given = client.post("/auth/consent", json=ACCEPT, headers=bearer(first))
    assert given.status_code == 200
    state = given.json()
    assert state["current"] is True
    assert state["latest"]["withdrawn_at"] is None
    [(user_id, terms, privacy, health, at, withdrawn)] = rows(first.athlete_id)
    assert (user_id, terms, privacy, health, withdrawn) == (
        first.id,
        consent.TERMS_VERSION,
        consent.PRIVACY_VERSION,
        True,
        None,
    )
    assert before <= at <= datetime.now(UTC).replace(tzinfo=None)
    assert client.get("/settings", headers=bearer(first)).status_code == 200
    assert client.get("/auth/me", headers=bearer(first)).json()["consent"]["current"]
    # Another athlete's consent is their own.
    assert client.get("/settings", headers=bearer(second)).status_code == 403


@pytest.mark.parametrize(
    ("change", "status"),
    [
        ({"terms_accepted": False}, 422),
        ({"health_data": False}, 422),
        ({"terms_version": "2025-01"}, 409),
        ({"privacy_version": "2025-01"}, 409),
    ],
)
def test_consent_needs_both_boxes_and_the_current_texts(
    accounts, client, change, status
):
    first, _ = accounts
    refused = client.post(
        "/auth/consent", json={**ACCEPT, **change}, headers=bearer(first)
    )
    assert refused.status_code == status
    assert rows(first.athlete_id) == []
    assert client.get("/settings", headers=bearer(first)).status_code == 403


def test_the_api_key_neither_gives_nor_withdraws_consent(accounts, client, monkeypatch):
    monkeypatch.setenv("ARETE_API_KEY", "k-" * 16)
    key = {"Authorization": "Bearer " + "k-" * 16}
    assert client.get("/settings", headers=key).status_code == 403
    assert client.post("/auth/consent", json=ACCEPT, headers=key).status_code == 403
    first, _ = accounts
    client.post("/auth/consent", json=ACCEPT, headers=bearer(first))
    assert client.get("/settings", headers=key).status_code == 200
    refused = client.post("/auth/consent/withdraw", headers=key)
    assert refused.status_code == 403
    assert refused.json() == {"detail": auth.API_KEY_CONSENT_DETAIL}
    assert client.get("/settings", headers=key).status_code == 200


def test_the_withdrawal_records_the_login_that_withdrew(accounts, client):
    first, _ = accounts
    client.post("/auth/consent", json=ACCEPT, headers=bearer(first))
    client.post("/auth/consent/withdraw", headers=bearer(first))
    con = connect()
    try:
        withdrawn = con.execute(
            "SELECT withdrawn_by, withdrawn_at IS NOT NULL FROM app.athlete_consents "
            "WHERE athlete_id = ?",
            [first.athlete_id],
        ).fetchall()
    finally:
        con.close()
    assert withdrawn == [(first.id, True)]


def test_a_withdrawal_on_another_instance_blocks_the_next_request_at_once(
    accounts, client, give_consent
):
    """Consent is never cached (GDPR art. 7(3)); the accounts still are."""
    first, second = accounts
    give_consent(first.athlete_id, second.athlete_id)
    assert client.get("/settings", headers=bearer(first)).status_code == 200
    assert client.get("/settings", headers=bearer(second)).status_code == 200
    cached = set(auth._accounts)
    assert {first.clerk_user_id, second.clerk_user_id} <= cached
    consent.withdraw(first.athlete_id, None)  # recorded elsewhere: no cache touched
    assert client.get("/settings", headers=bearer(first)).status_code == 403
    assert client.get("/settings", headers=bearer(second)).status_code == 200
    # Consent changes through the API invalidate nothing either.
    client.post("/auth/consent", json=ACCEPT, headers=bearer(first))
    client.post("/auth/consent/withdraw", headers=bearer(second))
    assert cached <= set(auth._accounts)
    assert client.get("/settings", headers=bearer(first)).status_code == 200
    assert client.get("/settings", headers=bearer(second)).status_code == 403


def test_every_reader_agrees_after_a_rollback_to_older_texts(
    accounts, client, monkeypatch, give_consent
):
    """A v1 consent in force, then a v2 one recorded later: back on v1, the
    middleware, /auth/me and the jobs all count the v1 consent."""
    from arete import scheduler

    first, _ = accounts
    give_consent(first.athlete_id)  # v1
    v1 = consent.TERMS_VERSION
    monkeypatch.setattr(consent, "TERMS_VERSION", "2027-01")
    give_consent(first.athlete_id)  # v2, the newest row
    monkeypatch.setattr(consent, "TERMS_VERSION", v1)  # the deployment rolls back
    auth.forget_accounts()
    assert client.get("/settings", headers=bearer(first)).status_code == 200
    me = client.get("/auth/me", headers=bearer(first)).json()["consent"]
    assert me["current"] is True
    assert me["latest"]["terms_version"] == v1  # the consent in force is shown
    assert first.athlete_id in [row[0] for row in scheduler._candidates()]


def test_withdrawal_stops_processing_keeps_data_and_can_be_given_again(
    accounts, client
):
    first, _ = accounts
    client.post("/auth/consent", json=ACCEPT, headers=bearer(first))
    put = client.put("/settings", json={"display_name": "Gardé"}, headers=bearer(first))
    assert put.status_code == 200
    # Cached as consented on this instance: the withdrawal applies at once.
    assert client.get("/settings", headers=bearer(first)).status_code == 200

    withdrawn = client.post("/auth/consent/withdraw", headers=bearer(first))
    assert withdrawn.status_code == 200
    assert withdrawn.json()["current"] is False
    assert withdrawn.json()["latest"]["withdrawn_at"] is not None
    for method, path in GATED:
        assert getattr(client, method)(path, headers=bearer(first)).status_code == 403
    with athlete_scope(first.athlete_id):
        from arete.dataio.settings import get_user_settings

        assert get_user_settings()["display_name"] == "Gardé"  # nothing deleted

    client.post("/auth/consent", json=ACCEPT, headers=bearer(first))
    history = rows(first.athlete_id)
    assert len(history) == 2  # the proof of the first consent stays
    assert history[0][5] is not None and history[1][5] is None
    assert client.get("/settings", headers=bearer(first)).status_code == 200


def test_a_new_text_version_asks_again(accounts, client, monkeypatch, give_consent):
    first, _ = accounts
    give_consent(first.athlete_id)
    assert client.get("/settings", headers=bearer(first)).status_code == 200
    accepted = consent.TERMS_VERSION
    monkeypatch.setattr(consent, "TERMS_VERSION", "2027-01")
    auth.forget_accounts()  # a new deployment starts with no cache
    assert client.get("/settings", headers=bearer(first)).status_code == 403
    me = client.get("/auth/me", headers=bearer(first)).json()["consent"]
    assert me["current"] is False and me["terms_version"] == "2027-01"
    assert me["latest"]["terms_version"] == accepted


def test_a_consent_given_on_another_instance_opens_the_app_at_once(
    accounts, client, give_consent
):
    first, _ = accounts
    assert client.get("/settings", headers=bearer(first)).status_code == 403
    give_consent(first.athlete_id)  # elsewhere: this instance's cache is untouched
    assert client.get("/settings", headers=bearer(first)).status_code == 200


def test_without_sign_in_no_consent_is_asked(accounts, client, monkeypatch):
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    assert client.get("/settings").status_code == 200
    assert client.get("/auth/me").json()["consent"]["required"] is False
    assert consent.allows_processing(1)


# --------------------------------------------------------------- jobs --
@pytest.fixture
def frozen(monkeypatch):
    from arete import scheduler

    monkeypatch.setattr(scheduler, "utc_now", lambda: NOON)
    monkeypatch.delenv("ARETE_AUTO_SYNC_HOUR", raising=False)


def test_scheduled_jobs_skip_an_athlete_without_consent(
    accounts, monkeypatch, frozen, give_consent
):
    """The owner included: their jobs pause until they consent, without error."""
    from arete import scheduler

    first, second = accounts
    give_consent(second.athlete_id)
    seen: list[int] = []

    def sync():
        seen.append(current_athlete_id())
        return {"sync": "ok"}

    monkeypatch.setattr(scheduler, "daily_sync", sync)
    monkeypatch.setattr(scheduler, "write_daily_briefing", lambda: "rules")
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "rules")
    # Check-in, Sunday review and the evening passes read the same list.
    assert [row[0] for row in scheduler._candidates()] == [second.athlete_id]
    assert list(scheduler.run_scheduled_batch()["athletes"]) == [str(second.athlete_id)]
    assert seen == [second.athlete_id]


def test_a_withdrawn_athlete_is_skipped_by_every_job(
    accounts, monkeypatch, frozen, give_consent
):
    from arete import scheduler
    from arete.services import automation_dispatch, automations

    first, second = accounts
    give_consent(first.athlete_id, second.athlete_id)
    consent.withdraw(first.athlete_id, None)
    assert [row[0] for row in scheduler._candidates()] == [second.athlete_id]

    prepared: list[int] = []
    monkeypatch.setattr(
        automations, "prepare", lambda **_: prepared.append(current_athlete_id())
    )
    automation_dispatch.dispatch(lambda run: None)
    assert prepared == [second.athlete_id]

    seen: list[int] = []
    monkeypatch.setattr(
        scheduler,
        "write_evening_message",
        lambda *a: seen.append(current_athlete_id()) or "disabled",
    )
    monkeypatch.setattr(scheduler, "evening_owed", lambda *a: True)
    scheduler.run_evening_messages()
    assert seen == [second.athlete_id]


def test_automations_due_without_consent_are_missed_never_run_late(
    accounts, give_consent
):
    from arete.services import automation_dispatch, automations
    from arete.services.automation_schedule import AutomationInput

    first, _ = accounts
    now = datetime.now(UTC)

    def daily(title: str) -> dict:
        return automations.create(
            AutomationInput(
                title=title,
                mission="Examiner la récupération",
                timezone="Europe/Paris",
                trigger={"kind": "daily", "time": "08:00"},
            ),
            activate=True,
            now=now - timedelta(days=3),
        )

    with athlete_scope(first.athlete_id):
        queued = daily("Prêt avant le retrait")
        pending = daily("Jamais préparé")
    give_consent(first.athlete_id)
    with athlete_scope(first.athlete_id):
        automations.prepare(now)  # the latest occurrence is queued, overdue
    consent.withdraw(first.athlete_id, None)

    executed: list = []
    automation_dispatch.dispatch(executed.append)
    assert executed == []
    with athlete_scope(first.athlete_id):
        for item in (queued, pending):
            runs = automations.runs(item["id"])["items"]
            assert runs and {r["state"] for r in runs} == {"missed"}
            assert automation_dispatch.NO_CONSENT_REASON in {r["error"] for r in runs}
            # The schedule moved past now: nothing waits to fire late.
            due = automations.get(item["id"])["next_due_at"]
            assert datetime.fromisoformat(str(due)) > now

    give_consent(first.athlete_id)
    automation_dispatch.dispatch(executed.append)
    assert executed == []


def _automation(trigger: dict, *, activated: datetime) -> dict:
    from arete.services import automations
    from arete.services.automation_schedule import AutomationInput

    return automations.create(
        AutomationInput(
            title="Suivi",
            mission="Examiner la récupération",
            timezone="Europe/Paris",
            trigger=trigger,
        ),
        activate=True,
        now=activated,
    )


def test_a_session_registered_without_consent_never_triggers_a_late_run(
    accounts, give_consent
):
    from arete.garmin.models import ActualSession
    from arete.garmin.repository import GarminRepository
    from arete.services import automation_dispatch, automations

    first, _ = accounts
    now = datetime.now(UTC)
    with athlete_scope(first.athlete_id):
        item = _automation(
            {"kind": "session", "sport": "running", "delay_minutes": 0},
            activated=now - timedelta(days=2),
        )
    give_consent(first.athlete_id)
    consent.withdraw(first.athlete_id, None)
    with athlete_scope(first.athlete_id):
        # Synced just before the withdrawal reached it, or imported meanwhile.
        GarminRepository().create_actual_session(
            ActualSession(date=now.date(), sport="running", duration_sec=1800)
        )
    give_consent(first.athlete_id)
    executed: list = []
    automation_dispatch.dispatch(executed.append)
    with athlete_scope(first.athlete_id):
        assert automations.runs(item["id"])["items"] == []
    assert executed == []
    # A session registered after the new consent triggers as before.
    with athlete_scope(first.athlete_id):
        GarminRepository().create_actual_session(
            ActualSession(date=now.date(), sport="running", duration_sec=2400)
        )
    automation_dispatch.dispatch(executed.append)
    assert len(executed) == 1


def test_an_invalid_automation_of_an_athlete_without_consent_is_paused(
    accounts, give_consent
):
    """A stored trigger that no longer validates pauses that automation; the
    dispatch goes on for everyone else."""
    from arete.dataio.db import db_connection
    from arete.services import automation_dispatch

    first, second = accounts
    now = datetime.now(UTC)
    with athlete_scope(first.athlete_id):
        broken = _automation(
            {"kind": "daily", "time": "08:00"}, activated=now - timedelta(days=2)
        )
        with db_connection() as con:
            con.execute(
                "UPDATE app.automations SET trigger_json = ? WHERE id = ?",
                ['{"kind": "hourly"}', broken["id"]],
            )
    give_consent(second.athlete_id)
    with athlete_scope(second.athlete_id):
        healthy = _automation(
            {"kind": "once", "at": (now - timedelta(minutes=1)).isoformat()},
            activated=now - timedelta(minutes=2),
        )
    executed: list = []
    automation_dispatch.dispatch(lambda run: executed.append(run["automation_id"]))
    assert executed == [healthy["id"]]
    with athlete_scope(first.athlete_id), db_connection() as con:
        state = con.execute(
            "SELECT state FROM app.visible_automations WHERE id = ?", [broken["id"]]
        ).fetchone()
    assert state == ("paused",)


def test_an_athlete_without_consent_and_nothing_due_costs_no_write(
    accounts, monkeypatch
):
    from arete.services import automation_dispatch, automations

    def no_write():
        raise AssertionError("a write transaction for an athlete with nothing due")

    monkeypatch.setattr(automations, "transaction", no_write)
    assert automation_dispatch.dispatch(lambda run: None)["runs"] == []


def test_a_withdrawal_during_a_dispatch_stops_that_athlete_s_work(
    accounts, monkeypatch, frozen, give_consent
):
    """Consent is read again before each athlete's claim, model request and
    automation run, not only when the candidates are listed."""
    from arete import scheduler
    from arete.services import automation_dispatch, automations

    first, second = accounts
    give_consent(first.athlete_id, second.athlete_id)
    listed = scheduler._candidates()
    consent.withdraw(second.athlete_id, None)  # after the listing
    synced: list[int] = []
    briefed: list[int] = []

    def sync():
        synced.append(current_athlete_id())
        consent.withdraw(first.athlete_id, None)  # during the sync
        return {"sync": "ok"}

    monkeypatch.setattr(scheduler, "_candidates", lambda: listed)
    monkeypatch.setattr(scheduler, "daily_sync", sync)
    monkeypatch.setattr(
        scheduler, "write_daily_briefing", lambda: briefed.append(1) or "rules"
    )
    monkeypatch.setattr(scheduler, "write_weekly_review", lambda: "rules")
    result = scheduler.run_scheduled_batch()["athletes"]
    assert synced == [first.athlete_id]  # the second was never claimed
    assert result[str(first.athlete_id)]["briefing"] == "skipped: consent withdrawn"
    assert briefed == []

    # An automation run due, then a withdrawal while the dispatch prepares.
    give_consent(first.athlete_id)
    now = datetime.now(UTC)
    with athlete_scope(first.athlete_id):
        _automation(
            {"kind": "once", "at": (now - timedelta(minutes=1)).isoformat()},
            activated=now - timedelta(minutes=2),
        )
    prepare = automations.prepare

    def withdrawn_meanwhile(**kwargs):
        prepare(**kwargs)
        consent.withdraw(first.athlete_id, None)

    monkeypatch.setattr(automations, "prepare", withdrawn_meanwhile)
    executed: list = []
    automation_dispatch.dispatch(executed.append)
    assert executed == []


def test_the_scheduler_filters_with_the_consent_rule():
    """Its query is one literal (the SQL contract test reads it): same predicate."""
    from arete import scheduler

    predicate, _ = consent.processing_sql("a.id")
    assert predicate in scheduler._CANDIDATES


def test_without_sign_in_jobs_run_without_consent(accounts, monkeypatch, frozen):
    from arete import scheduler

    monkeypatch.delenv("ARETE_AUTH", raising=False)
    first, second = accounts
    assert {row[0] for row in scheduler._candidates()} == {
        first.athlete_id,
        second.athlete_id,
    }


# ------------------------------------------------- other entry points --
def test_slack_never_runs_the_coach_for_an_athlete_without_consent(
    accounts, monkeypatch, give_consent
):
    from arete.services import slack, slack_athletes, slack_identity

    first, _ = accounts
    message = slack.SlackMessage(
        "T123", "Ev1", "A123", "D123", "U123", "1.000001", "1.000001", "Séance ?"
    )
    client = AsyncMock(spec=slack.SlackClient)
    client.author_email.return_value = "first@example.com"
    monkeypatch.setattr(
        slack_athletes, "athlete_for_email", lambda email: first.athlete_id
    )
    monkeypatch.setattr(slack_identity, "link", lambda *args: None)
    assert asyncio.run(slack.resolve(message, client=client)) is None
    client.reply.assert_awaited_once_with(message, slack.UNCONSENTED_MESSAGE)

    # In a channel, whether someone consented is said to them alone, in a DM.
    client.reset_mock()
    client.open_dm.return_value = "DPRIVATE"
    in_channel = replace(
        message, event_id="Ev1b", channel="CPUBLIC", in_channel=True, mentioned=True
    )
    assert asyncio.run(slack.resolve(in_channel, client=client)) is None
    client.reply.assert_not_awaited()
    client.open_dm.assert_awaited_once_with("U123")
    client.post.assert_awaited_once_with("DPRIVATE", None, slack.UNCONSENTED_MESSAGE)

    # Slack redelivers an event it thinks unanswered: the notice goes out once.
    client.reset_mock()
    redelivered = replace(message, event_id="Ev2")
    for _ in range(4):
        assert asyncio.run(slack.resolve(redelivered, client=client)) is None
    client.reply.assert_awaited_once_with(redelivered, slack.UNCONSENTED_MESSAGE)

    give_consent(first.athlete_id)
    fresh = replace(message, event_id="Ev3")
    assert asyncio.run(slack.resolve(fresh, client=client)) == first.athlete_id


def test_an_administrator_cannot_read_an_athlete_without_consent(
    accounts, monkeypatch, give_consent
):
    from arete.services import admin_athlete_data, slack_identity

    first, second = accounts
    monkeypatch.setattr(slack_identity, "require_admin", lambda *args: first)
    with pytest.raises(PermissionError, match="consenti"):
        admin_athlete_data.read("T", "U", "acct", second.athlete_id, "settings")
    give_consent(second.athlete_id)
    assert admin_athlete_data.read("T", "U", "acct", second.athlete_id, "settings")


def test_the_strava_callback_refuses_an_athlete_without_consent(accounts, client):
    from arete.api.strava import _state_secret
    from arete.services import oauth_state

    first, _ = accounts
    state = oauth_state.issue(_state_secret(), athlete_id=first.athlete_id)
    refused = client.get(f"/strava/callback?code=x&state={state}")
    assert refused.status_code == 403
    assert refused.json() == {"detail": consent.CONSENT_REQUIRED_DETAIL}


# ------------------------------------------------------------- texts --
@pytest.mark.parametrize(
    ("name", "version"),
    [
        ("conditions.md", consent.TERMS_VERSION),
        ("confidentialite.md", consent.PRIVACY_VERSION),
    ],
)
def test_the_published_texts_carry_the_versions_asked(name, version):
    text = (ROOT / "frontend/src/legal" / name).read_text()
    assert text.startswith("> **BROUILLON — à valider**")
    assert re.search(rf"^Version : `{re.escape(version)}`$", text, re.M)
    # The controller is named by the owner, never in the repository.
    assert "**[NOM DU RESPONSABLE DU TRAITEMENT], personne physique**" in text
    for placeholder in ("[EMAIL DE CONTACT]", "[ADRESSE POSTALE]"):
        assert placeholder in text
