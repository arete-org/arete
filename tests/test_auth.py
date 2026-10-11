"""Sign-in at the API boundary: off by default, enforced with ARETE_AUTH=clerk."""

from __future__ import annotations

import pytest

from arete.api import auth
from arete.dataio.db import connect
from arete.services import oauth_state, users

OWNER = "user_owner"
OTHER = "user_other"
PROFILES = {
    OWNER: ("Owner@Example.com", "Greg", True),
    OTHER: ("other@example.com", None, True),
}
TOKENS = {"owner-token": OWNER, "other-token": OTHER}


@pytest.fixture(autouse=True)
def _clean_users():
    con = connect()
    con.execute("DELETE FROM app.users")
    con.close()
    yield
    con = connect()
    con.execute("DELETE FROM app.users")
    con.close()


@pytest.fixture
def enforced(monkeypatch):
    """Clerk mode with a fake verifier: no network, no real keys."""
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "pk_test_fake")
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "owner@example.com")
    monkeypatch.delenv("ARETE_API_KEY", raising=False)
    fetched: list[str] = []

    def verify(token: str):
        if token in TOKENS:
            return {"sub": TOKENS[token]}
        raise auth.AuthError(401, "Session invalide ou expirée.")

    def profile(clerk_user_id: str):
        fetched.append(clerk_user_id)
        return PROFILES[clerk_user_id]

    monkeypatch.setattr(auth, "_verify_session_token", verify)
    monkeypatch.setattr(auth, "_fetch_clerk_profile", profile)
    return fetched


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_open_by_default(client, monkeypatch):
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    assert client.get("/settings").status_code == 200
    assert client.get("/auth/config").json() == {
        "enabled": False,
        "publishable_key": None,
    }
    me = client.get("/auth/me").json()
    assert (me["athlete_id"], me["is_owner"], me["email"]) == (1, True, "")


def test_enforced_mode_requires_a_credential(client, enforced):
    refused = client.get("/settings")
    assert refused.status_code == 401
    assert refused.headers["www-authenticate"] == "Bearer"
    assert client.get("/settings", headers=_bearer("garbage")).status_code == 401
    # Public without a credential: the probe, the sign-in bootstrap, the schema.
    assert client.get("/health").status_code == 200
    assert client.get("/auth/config").json() == {
        "enabled": True,
        "publishable_key": "pk_test_fake",
    }
    assert client.get("/openapi.json").status_code == 200
    # The Strava callback arrives from the provider's redirect, with no session:
    # it keeps its own state check and must not be turned away at the door.
    assert client.get("/strava/callback").status_code != 401
    # Slack events carry Slack's signature, checked by their own route.
    assert "www-authenticate" not in client.post("/slack/events").headers


def test_each_account_gets_its_own_athlete(client, enforced):
    me = client.get("/auth/me", headers=_bearer("owner-token")).json()
    assert me == {
        "email": "owner@example.com",
        "name": "Greg",
        "athlete_id": 1,
        "is_owner": True,
        "role": "athlete",
        "is_admin": True,
    }
    assert client.get("/settings", headers=_bearer("owner-token")).status_code == 200

    other = client.get("/auth/me", headers=_bearer("other-token")).json()
    assert other["email"] == "other@example.com"
    assert other["athlete_id"] > 1 and other["is_owner"] is False
    own = client.get("/settings", headers=_bearer("other-token"))
    assert own.status_code == 200
    assert own.json()["user_id"] == other["athlete_id"]
    # Each account's profile was read from Clerk once, then served from the table.
    assert sorted(enforced) == sorted([OWNER, OTHER])


def test_the_api_key_acts_as_the_owner(client, enforced, monkeypatch):
    monkeypatch.setenv("ARETE_API_KEY", "k-" * 16)
    assert client.get("/settings", headers=_bearer("k-" * 16)).status_code == 200
    assert client.get("/auth/me", headers=_bearer("k-" * 16)).json()["is_owner"] is True
    assert client.get("/settings", headers=_bearer("k-" * 15)).status_code == 401


def test_misconfiguration_fails_closed(client, monkeypatch):
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.delenv("CLERK_SECRET_KEY", raising=False)
    assert client.get("/settings").status_code == 503
    assert client.get("/health").status_code == 200


def test_an_identity_provider_outage_is_a_503_not_a_leak(client, enforced, monkeypatch):
    def down(_token):
        raise RuntimeError("clerk unreachable")

    monkeypatch.setattr(auth, "_verify_session_token", down)
    assert client.get("/settings", headers=_bearer("owner-token")).status_code == 503


def _expire_profiles() -> None:
    con = connect()
    con.execute("UPDATE app.users SET profile_synced_at = now() - INTERVAL 2 HOUR")
    con.close()
    auth.forget_accounts()  # two hours later, no cached resolution is left


def test_a_burst_of_stale_requests_refreshes_the_profile_once(enforced, monkeypatch):
    # A dashboard sends a dozen requests at once; each used to fetch Clerk
    # and rewrite the same row, and the losers' conflicts answered 503.
    import threading
    import time

    auth.resolve_user("Bearer owner-token")
    _expire_profiles()
    enforced.clear()
    fetch = auth._fetch_clerk_profile

    def slow(subject):
        time.sleep(0.2)
        return fetch(subject)

    monkeypatch.setattr(auth, "_fetch_clerk_profile", slow)
    resolved = []
    threads = [
        threading.Thread(
            target=lambda: resolved.append(auth.resolve_user("Bearer owner-token"))
        )
        for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    assert enforced == [OWNER]
    assert [user.athlete_id for user in resolved] == [1] * 8


def test_a_refresh_lost_to_another_instance_keeps_the_stored_account(
    enforced, monkeypatch
):
    import duckdb

    stored = auth.resolve_user("Bearer owner-token")
    _expire_profiles()

    def conflict(*args, **kwargs):
        raise duckdb.TransactionException("Conflict on update!")

    monkeypatch.setattr(users, "upsert_user", conflict)
    again = auth.resolve_user("Bearer owner-token")
    assert (again.id, again.athlete_id) == (stored.id, 1)
    # Without a stored account there is nothing to fall back on.
    with pytest.raises(duckdb.TransactionException):
        auth.resolve_user("Bearer other-token")


class TestUsers:
    def test_athlete_1_is_claimed_once_then_other_listed_addresses_get_their_own(
        self, monkeypatch
    ):
        # A second listed address once handed a guest the owner's data and
        # Garmin session: whoever holds athlete 1 keeps it alone.
        monkeypatch.setenv("ARETE_OWNER_EMAIL", "Owner@Example.com, guest@example.com")
        first = users.upsert_user("u1", "owner@example.com", "Greg", verified=True)
        assert first.athlete_id == 1 and first.is_owner
        again = users.upsert_user("u1", "OWNER@example.com", None)
        assert (again.athlete_id, again.name) == (1, "Greg")
        # The same address on a new login (a recreated account) is the owner.
        assert users.upsert_user("u4", "owner@example.com", verified=True).is_owner
        guest = users.upsert_user("u2", "GUEST@example.com", None, verified=True)
        assert guest.athlete_id > 1 and not guest.is_owner
        other = users.upsert_user("u3", "other@example.com", "Someone")
        assert other.athlete_id > 1
        assert len({guest.athlete_id, other.athlete_id}) == 2
        assert [u.clerk_user_id for u in users.list_users()] == ["u1", "u4", "u2", "u3"]

    def test_the_owner_e_mail_falls_back_to_settings(self, monkeypatch):
        monkeypatch.delenv("ARETE_OWNER_EMAIL", raising=False)
        con = connect()
        con.execute(
            "UPDATE app.user_settings SET email='Me@Example.com' WHERE user_id=1"
        )
        con.close()
        assert users.upsert_user("u3", "me@example.com", verified=True).athlete_id == 1
        assert users.upsert_user("u4", "you@example.com", verified=True).athlete_id > 1


class TestOAuthState:
    def test_round_trip_tamper_and_expiry(self):
        state = oauth_state.issue("secret", now=1_000_000)
        assert oauth_state.verify("secret", state, now=1_000_100)
        assert not oauth_state.verify("other", state, now=1_000_100)
        assert not oauth_state.verify("secret", state + "x", now=1_000_100)
        assert not oauth_state.verify("secret", state, now=1_000_000 + 601)
        assert not oauth_state.verify("secret", None)
        assert not oauth_state.verify("secret", "a.b")


def test_http_workers_enforce_private_plans(client, enforced):
    first = _bearer("owner-token")
    second = _bearer("other-token")
    identifiers = []
    for headers, label in [
        (first, "First private plan"),
        (second, "Second private plan"),
    ]:
        response = client.post(
            "/garmin/planned",
            headers=headers,
            json={"date": "2026-10-10", "description": label},
        )
        assert response.status_code == 201, response.text
        identifiers.append(response.json()["id"])
    for headers, own, foreign in [
        (first, identifiers[0], identifiers[1]),
        (second, identifiers[1], identifiers[0]),
    ]:
        response = client.get("/garmin/planned", headers=headers)
        assert response.status_code == 200
        ids = {row["id"] for row in response.json()}
        assert own in ids and foreign not in ids
        assert (
            client.patch(
                f"/garmin/planned/{foreign}",
                headers=headers,
                json={"status": "skipped"},
            ).status_code
            == 404
        )
        assert (
            client.delete(f"/garmin/planned/{foreign}", headers=headers).status_code
            == 404
        )
        assert (
            client.delete(f"/garmin/planned/{own}", headers=headers).status_code == 200
        )


class TestAccountCache:
    """One account read per burst; revocation bounded by ACCOUNT_TTL_SECONDS."""

    @pytest.fixture
    def clock(self, monkeypatch):
        now = [1000.0]
        monkeypatch.setattr(auth, "_clock", lambda: now[0])
        return now

    def test_a_burst_of_requests_reads_the_account_once(
        self, client, enforced, monkeypatch, statement_log
    ):
        auth.resolve_user("Bearer owner-token")  # provisioned from Clerk
        auth.forget_accounts()
        connect_ = users.connect
        monkeypatch.setattr(users, "connect", lambda: statement_log.wrap(connect_()))
        for _ in range(10):
            response = client.get("/settings", headers=_bearer("owner-token"))
            assert response.status_code == 200
        # One query for the login and its athlete together, then the cache.
        assert len(statement_log) == 1
        assert "app.athletes" in statement_log[0]

    def test_deactivation_applies_at_once_here_and_within_the_ttl_elsewhere(
        self, client, enforced, clock
    ):
        owner, other = _bearer("owner-token"), _bearer("other-token")
        athlete = client.get("/auth/me", headers=other).json()["athlete_id"]
        client.get("/auth/me", headers=owner)
        # Through this instance's administration: refused at the next request.
        deactivate = f"/admin/athletes/{athlete}/deactivate"
        assert client.post(deactivate, headers=owner).status_code == 204
        assert client.get("/settings", headers=other).status_code == 403
        reactivate = f"/admin/athletes/{athlete}/reactivate"
        assert client.post(reactivate, headers=owner).status_code == 204
        assert client.get("/settings", headers=other).status_code == 200
        # Through another instance (a direct write here): within the TTL.
        users.deactivate_athlete(athlete, actor=auth.resolve_user("Bearer owner-token"))
        clock[0] += auth.ACCOUNT_TTL_SECONDS - 1
        assert client.get("/settings", headers=other).status_code == 200
        clock[0] += 1
        assert client.get("/settings", headers=other).status_code == 403
        assert auth.ACCOUNT_TTL_SECONDS <= 60

    def test_the_cache_is_bounded_and_keeps_subjects_apart(
        self, enforced, monkeypatch, statement_log
    ):
        monkeypatch.setitem(TOKENS, "third-token", "user_third")
        monkeypatch.setitem(PROFILES, "user_third", ("third@example.com", None, True))
        monkeypatch.setattr(auth, "ACCOUNT_CACHE_SIZE", 2)
        owner = auth.resolve_user("Bearer owner-token")
        other = auth.resolve_user("Bearer other-token")
        assert owner.athlete_id == 1 and other.athlete_id not in (None, 1)
        connect_ = users.connect
        monkeypatch.setattr(users, "connect", lambda: statement_log.wrap(connect_()))
        # Served from the cache, each subject its own account.
        assert auth.resolve_user("Bearer other-token") == other
        assert auth.resolve_user("Bearer owner-token") == owner
        assert statement_log == []
        auth.resolve_user("Bearer third-token")
        # The least recently used (other) made room; the owner stayed.
        assert list(auth._accounts) == [OWNER, "user_third"]

    def test_a_read_overtaken_by_an_administration_change_is_not_kept(
        self, enforced, monkeypatch
    ):
        auth.resolve_user("Bearer other-token")
        auth.forget_accounts()
        read = users.get_account

        def overtaken(subject):
            account = read(subject)
            auth.forget_accounts()  # an admin acted while this read was in flight
            return account

        monkeypatch.setattr(users, "get_account", overtaken)
        auth.resolve_user("Bearer other-token")
        assert OTHER not in auth._accounts
