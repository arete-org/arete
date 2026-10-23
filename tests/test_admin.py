"""Administration over HTTP: who may see and act on accounts, and its rules."""

from __future__ import annotations

from datetime import datetime

import pytest

from arete.api import auth
from arete.dataio.db import connect
from arete.services import users

OWNER, ADMIN, ANA = "user_owner", "user_admin", "user_ana"
PROFILES = {
    OWNER: ("owner@example.com", "Greg", True),
    ADMIN: ("admin@example.com", "Ada", True),
    ANA: ("ana@example.com", "Ana", True),
}
TOKENS = {"owner-token": OWNER, "admin-token": ADMIN, "ana-token": ANA}


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _user_id(subject: str) -> int:
    user = users.get_user(subject)
    assert user is not None
    return user.id


#: The scheduler stores its lease in UTC, whatever the session's TimeZone.
UTC_NOW = "(current_timestamp AT TIME ZONE 'UTC')"


def _set_lease(athlete_id: int, expression: str) -> None:
    con = connect()
    con.execute(
        f"UPDATE app.athletes SET sync_lease_until = {expression} WHERE id=?",
        [athlete_id],
    )
    con.close()


@pytest.fixture(autouse=True)
def _clean_users():
    con = connect()
    con.execute("DELETE FROM app.users")
    con.execute("DELETE FROM app.feature_flags")
    con.close()
    yield
    con = connect()
    con.execute("DELETE FROM app.users")
    con.execute("DELETE FROM app.feature_flags")
    con.close()


@pytest.fixture
def athletes(client, monkeypatch, consented) -> dict[str, int]:
    """Clerk mode with fake tokens: three accounts, ADMIN named by the owner.

    Returns each token's athlete id.
    """
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "pk_test_fake")
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "owner@example.com")
    monkeypatch.delenv("ARETE_API_KEY", raising=False)

    def verify(token: str):
        if token in TOKENS:
            return {"sub": TOKENS[token]}
        raise auth.AuthError(401, "Session invalide ou expirée.")

    monkeypatch.setattr(auth, "_verify_session_token", verify)
    monkeypatch.setattr(auth, "_fetch_clerk_profile", lambda subject: PROFILES[subject])
    ids = {
        token: client.get("/auth/me", headers=_bearer(token)).json()["athlete_id"]
        for token in TOKENS
    }
    named = client.post(
        f"/admin/accounts/{_user_id(ADMIN)}/role",
        json={"role": "admin"},
        headers=_bearer("owner-token"),
    )
    assert named.status_code == 200
    return ids


def test_me_reports_the_role_and_a_change_applies_at_the_next_request(client, athletes):
    owner = client.get("/auth/me", headers=_bearer("owner-token")).json()
    assert (owner["athlete_id"], owner["is_owner"], owner["is_admin"]) == (
        1,
        True,
        True,
    )
    ana = client.get("/auth/me", headers=_bearer("ana-token")).json()
    assert (ana["role"], ana["is_admin"], ana["is_owner"]) == ("athlete", False, False)
    promoted = client.post(
        f"/admin/accounts/{_user_id(ANA)}/role",
        json={"role": "admin"},
        headers=_bearer("owner-token"),
    ).json()
    assert (promoted["role"], promoted["is_admin"]) == ("admin", True)
    # No new sign-in: every request reads the account row.
    ana = client.get("/auth/me", headers=_bearer("ana-token")).json()
    assert (ana["role"], ana["is_admin"]) == ("admin", True)


def test_administration_is_closed_to_athletes(client, athletes, monkeypatch):
    assert client.get("/admin/accounts").status_code == 401
    assert (
        client.get("/admin/accounts", headers=_bearer("ana-token")).status_code == 403
    )
    ana = athletes["ana-token"]
    for path in (
        f"/admin/accounts/{_user_id(ANA)}/role",
        f"/admin/athletes/{ana}/deactivate",
        f"/admin/athletes/{ana}/reactivate",
        f"/admin/athletes/{ana}/release-lease",
    ):
        refused = client.post(
            path, json={"role": "admin"}, headers=_bearer("ana-token")
        )
        assert refused.status_code == 403, path
    for token in ("owner-token", "admin-token"):
        assert client.get("/admin/accounts", headers=_bearer(token)).status_code == 200
    monkeypatch.setenv("ARETE_API_KEY", "k-" * 16)
    assert client.get("/admin/accounts", headers=_bearer("k-" * 16)).status_code == 200


def test_without_sign_in_the_instance_owner_administers(client, monkeypatch):
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    assert client.get("/admin/accounts").status_code == 200


def test_product_indicators_are_admin_only_bounded_and_anonymous(client, athletes):
    path = "/admin/kpis"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=_bearer("ana-token")).status_code == 403
    for weeks in (0, 53):
        refused = client.get(f"{path}?weeks={weeks}", headers=_bearer("owner-token"))
        assert refused.status_code == 422
    answer = client.get(f"{path}?weeks=3", headers=_bearer("admin-token"))
    assert answer.status_code == 200
    weeks = answer.json()
    assert [w["current"] for w in weeks] == [True, False, False]
    assert set(weeks[0]["indicators"]) == {
        "active_accounts",
        "push_subscribers",
        "strength_logged",
        "checkins_answered",
        "briefings_reacted",
        "weekly_reviews_accepted",
        "first_action_hours",
        "retention_30d",
        "evening_replies",
    }
    assert set(weeks[0]["indicators"]["active_accounts"]) == {
        "numerator",
        "denominator",
        "value",
    }
    assert "athlete" not in answer.text and "@" not in answer.text
    assert len(client.get(path, headers=_bearer("owner-token")).json()) == 12


def test_feature_flags_are_admin_only_and_persist_across_admins(
    client, athletes, monkeypatch
):
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    path = "/admin/feature-flags"
    for headers, status in (({}, 401), (_bearer("ana-token"), 403)):
        assert client.get(path, headers=headers).status_code == status
        assert (
            client.put(path, headers=headers, json={"glm_flash": True}).status_code
            == status
        )
    admin = _bearer("admin-token")
    owner = _bearer("owner-token")
    assert client.get(path, headers=admin).json() == {
        "glm_flash": False,
        "coaching_attention": False,
        "glm_flash_available": True,
    }
    assert client.put(path, headers=admin, json={"glm_flash": True}).status_code == 200
    assert client.get(path, headers=owner).json()["glm_flash"] is True
    for body in ({}, {"glm_flash": "false"}, {"glm_flash": 1}, {"model": "arbitrary"}):
        assert client.put(path, headers=owner, json=body).status_code == 422
    assert client.get(path, headers=admin).json()["glm_flash"] is True
    assert client.put(path, headers=owner, json={"glm_flash": False}).status_code == 200
    assert client.get(path, headers=admin).json()["glm_flash"] is False


def test_feature_flag_needs_openrouter_but_can_always_be_disabled(client, monkeypatch):
    monkeypatch.setenv("ARETE_AUTH", "off")
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    path = "/admin/feature-flags"
    assert client.get(path).json()["glm_flash_available"] is False
    assert client.put(path, json={"glm_flash": True}).status_code == 409
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert client.put(path, json={"glm_flash": True}).status_code == 409
    assert client.get(path).json()["glm_flash"] is False
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    assert client.put(path, json={"glm_flash": True}).status_code == 200
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    assert client.put(path, json={"glm_flash": False}).status_code == 200


def test_the_list_shows_each_athlete_with_its_login_and_daily_sync(client, athletes):
    ana, admin = athletes["ana-token"], athletes["admin-token"]
    _set_lease(ana, f"{UTC_NOW} - INTERVAL 1 HOUR")
    _set_lease(admin, f"{UTC_NOW} + INTERVAL 10 MINUTE")
    rows = {
        row["athlete_id"]: row
        for row in client.get("/admin/accounts", headers=_bearer("admin-token")).json()
        if row["user_id"] is not None
    }
    assert set(rows) == {1, ana, admin}
    assert (rows[1]["email"], rows[1]["is_owner"]) == ("owner@example.com", True)
    assert (rows[admin]["role"], rows[admin]["is_owner"]) == ("admin", False)
    assert rows[ana]["role"] == "athlete"
    # A lease past its expiry is a failed or stopped run; a future one runs.
    assert (rows[ana]["lease_stuck"], rows[admin]["lease_stuck"]) == (True, False)
    assert rows[1]["sync_lease_until"] is None and rows[1]["lease_stuck"] is False
    assert rows[ana]["deactivated_at"] is None and rows[ana]["last_sync_at"] is None
    # Stored local times are sent with their offset, for the browser to convert.
    assert datetime.fromisoformat(rows[ana]["last_seen_at"]).tzinfo is not None


def test_only_the_owner_names_administrators_and_never_on_its_own_logins(
    client, athletes
):
    owner = _bearer("owner-token")
    ana = _user_id(ANA)
    path = f"/admin/accounts/{ana}/role"
    refused = client.post(path, json={"role": "admin"}, headers=_bearer("admin-token"))
    assert refused.status_code == 403
    assert client.post(path, json={"role": "admin"}, headers=owner).json()["role"] == (
        "admin"
    )
    assert (
        client.post(path, json={"role": "athlete"}, headers=owner).json()["is_admin"]
        is False
    )
    assert client.post(path, json={"role": "root"}, headers=owner).status_code == 422
    unknown = client.post(
        "/admin/accounts/999999/role", json={"role": "admin"}, headers=owner
    )
    assert unknown.status_code == 404
    own = client.post(
        f"/admin/accounts/{_user_id(OWNER)}/role",
        json={"role": "athlete"},
        headers=owner,
    )
    assert own.status_code == 409
    assert own.json()["detail"] == "Le propriétaire est administrateur d'office."


def test_deactivation_rules_and_round_trip(client, athletes):
    owner, admin = _bearer("owner-token"), _bearer("admin-token")
    ana, administrator = athletes["ana-token"], athletes["admin-token"]
    for headers in (owner, admin):
        assert (
            client.post("/admin/athletes/1/deactivate", headers=headers).status_code
            == 409
        )
    # An administrator cannot deactivate an administrator, itself included.
    refused = client.post(f"/admin/athletes/{administrator}/deactivate", headers=admin)
    assert refused.status_code == 403
    assert refused.json()["detail"] == (
        "Seul le propriétaire peut désactiver un administrateur."
    )
    assert (
        client.post(f"/admin/athletes/{ana}/deactivate", headers=admin).status_code
        == 204
    )
    closed = client.get("/auth/me", headers=_bearer("ana-token"))
    assert closed.status_code == 403
    assert closed.json()["detail"] == "Ce compte a été désactivé."
    assert (
        client.post(f"/admin/athletes/{ana}/deactivate", headers=admin).status_code
        == 204
    )
    listed = {
        row["athlete_id"]: row
        for row in client.get("/admin/accounts", headers=owner).json()
    }
    assert listed[ana]["deactivated_at"] is not None
    assert (
        client.post(f"/admin/athletes/{ana}/reactivate", headers=admin).status_code
        == 204
    )
    assert client.get("/settings", headers=_bearer("ana-token")).status_code == 200
    assert (
        client.post(
            f"/admin/athletes/{administrator}/deactivate", headers=owner
        ).status_code
        == 204
    )
    for action in ("deactivate", "reactivate"):
        missing = client.post(f"/admin/athletes/999999/{action}", headers=owner)
        assert missing.status_code == 404


def test_only_a_lease_past_its_run_is_released(client, athletes):
    ana = athletes["ana-token"]
    path = f"/admin/athletes/{ana}/release-lease"
    admin = _bearer("admin-token")
    # A lease still ahead belongs to a run in progress: releasing it would let
    # a second dispatch run the same athlete at the same time.
    _set_lease(ana, f"{UTC_NOW} + INTERVAL 10 MINUTE")
    assert client.post(path, headers=admin).json() == {"released": False}
    _set_lease(ana, f"{UTC_NOW} - INTERVAL 1 MINUTE")
    assert client.post(path, headers=admin).json() == {"released": True}
    assert client.post(path, headers=admin).json() == {"released": False}
