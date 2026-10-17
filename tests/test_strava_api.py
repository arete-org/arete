"""Tests for the /strava router: OAuth helpers, status, disconnect and sync."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from arete.api.strava import router
from arete.strava.models import strava_activity_to_actual_session

FAKE_TOKENS = {
    "athlete_id": 42,
    "access_token": "fake_at",
    "refresh_token": "fake_rt",
    "expires_at": 9999999999,
    "athlete_name": "Greg",
}

FAKE_ACTIVITIES = [
    {
        "id": 1001,
        "name": "Morning Run",
        "type": "Run",
        "start_date": "2026-05-10T08:00:00Z",
        "start_date_local": "2026-05-10T10:00:00Z",
        "elapsed_time": 3600,
        "moving_time": 3500,
        "distance": 10000.0,
        "total_elevation_gain": 50.0,
        "average_speed": 2.78,
        "max_speed": 4.0,
        "average_heartrate": 145.0,
        "max_heartrate": 170.0,
        "calories": 600,
        "start_latlng": [48.85, 2.35],
    },
    {
        "id": 1002,
        "name": "Evening Ride",
        "type": "Ride",
        "start_date": "2026-05-10T18:00:00Z",
        "start_date_local": "2026-05-10T20:00:00Z",
        "elapsed_time": 5400,
        "moving_time": 5000,
        "distance": 30000.0,
        "total_elevation_gain": 200.0,
        "average_speed": 5.56,
        "max_speed": 12.0,
        "calories": 800,
        "start_latlng": [48.86, 2.34],
    },
]


@pytest.fixture
def client(router_client):
    return router_client(router)


def _patch_sync():
    """Return a stack of patches for the sync endpoint seams."""
    return (
        patch("arete.api.strava._get_strava_tokens"),
        patch("arete.api.strava._ensure_fresh_token"),
        patch("arete.api.strava._get_strava_client"),
        patch("arete.dataio.db.connect"),
        patch(
            "arete.strava.models.strava_activity_to_actual_session",
            wraps=strava_activity_to_actual_session,  # real mapping, observable
        ),
        patch("arete.garmin.repository.GarminRepository"),
    )


def _setup_mocks(
    mock_tokens,
    mock_fresh,
    mock_get_client,
    mock_connect,
    mock_repo_cls,
    existing_ids=None,
):
    """Configure all mocks for the sync endpoint."""
    mock_tokens.return_value = FAKE_TOKENS
    mock_fresh.return_value = "fake_at"

    strava_client = MagicMock()
    strava_client.fetch_activities.return_value = FAKE_ACTIVITIES
    strava_client.fetch_activity_detail.return_value = None  # fall back to the summary
    strava_client.fetch_activity_zones.return_value = None
    mock_get_client.return_value = strava_client

    # Mock the DB connection used for dedup query
    con = MagicMock()
    rows = [(sid,) for sid in (existing_ids or [])]
    con.execute.return_value.fetchall.return_value = rows
    mock_connect.return_value = con

    repo = MagicMock()
    repo.known_strava_ids.return_value = set(existing_ids or [])
    repo.find_overlapping_session.return_value = None  # no Garmin twin by default
    mock_repo_cls.return_value = repo

    return repo


class TestStravaSyncFlow:
    """Test the full sync flow with mocked HTTP."""

    def test_sync_imports_activities(self, client):
        p_tok, p_fresh, p_client, p_con, p_map, p_repo = _patch_sync()
        with (
            p_tok as m_tok,
            p_fresh as m_fresh,
            p_client as m_cli,
            p_con as m_con,
            p_map,
            p_repo as m_repo,
        ):
            repo = _setup_mocks(m_tok, m_fresh, m_cli, m_con, m_repo)

            resp = client.post("/strava/sync", json={"days": 30})

            assert resp.status_code == 200
            data = resp.json()
            assert data["success"] is True
            assert data["imported"] == 2
            assert data["skipped"] == 0
            assert repo.create_actual_session.call_count == 2

    def test_sync_requires_connection(self, client):
        with patch("arete.api.strava._get_strava_tokens", return_value=None):
            resp = client.post("/strava/sync", json={"days": 30})
            assert resp.status_code == 400

    def test_sync_deduplicates(self, client):
        p_tok, p_fresh, p_client, p_con, p_map, p_repo = _patch_sync()
        with (
            p_tok as m_tok,
            p_fresh as m_fresh,
            p_client as m_cli,
            p_con as m_con,
            p_map,
            p_repo as m_repo,
        ):
            repo = _setup_mocks(
                m_tok, m_fresh, m_cli, m_con, m_repo, existing_ids=["1001", "1002"]
            )

            resp = client.post("/strava/sync", json={"days": 30})

            data = resp.json()
            assert data["imported"] == 0
            assert data["skipped"] == 2
            assert repo.create_actual_session.call_count == 0

    def test_sync_partial_dedup(self, client):
        p_tok, p_fresh, p_client, p_con, p_map, p_repo = _patch_sync()
        with (
            p_tok as m_tok,
            p_fresh as m_fresh,
            p_client as m_cli,
            p_con as m_con,
            p_map,
            p_repo as m_repo,
        ):
            _setup_mocks(m_tok, m_fresh, m_cli, m_con, m_repo, existing_ids=["1001"])

            resp = client.post("/strava/sync", json={"days": 30})

            data = resp.json()
            assert data["imported"] == 1
            assert data["skipped"] == 1


class TestStravaAuthorize:
    @patch.dict(
        "os.environ",
        {
            "STRAVA_CLIENT_ID": "12345",
            "STRAVA_CLIENT_SECRET": "secret",
            "STRAVA_REDIRECT_URI": "http://localhost:8000/strava/callback",
        },
    )
    def test_returns_authorize_url(self, client):
        resp = client.get("/strava/authorize")
        assert resp.status_code == 200
        data = resp.json()
        assert "url" in data
        assert "strava.com/oauth/authorize" in data["url"]
        assert "client_id=12345" in data["url"]


class TestStravaStatus:
    @patch("arete.api.strava._get_strava_tokens")
    def test_disconnected(self, mock_tokens, client):
        mock_tokens.return_value = None
        resp = client.get("/strava/status")
        assert resp.status_code == 200
        assert resp.json()["connected"] is False

    @patch("arete.api.strava._get_strava_tokens")
    def test_connected(self, mock_tokens, client):
        mock_tokens.return_value = {
            "athlete_id": 42,
            "athlete_name": "Greg",
            "expires_at": 9999999999,
        }
        resp = client.get("/strava/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["connected"] is True
        assert data["athlete_name"] == "Greg"


class TestStravaDisconnect:
    @patch("arete.api.strava._delete_strava_tokens")
    def test_disconnect(self, mock_delete, client):
        resp = client.delete("/strava/disconnect")
        assert resp.status_code == 200
        mock_delete.assert_called_once()


class TestStravaMergeIntoGarmin:
    def test_twin_is_enriched_not_duplicated(self, client):
        from arete.garmin.models import ActivitySource, ActualSession

        p_tok, p_fresh, p_client, p_con, p_map, p_repo = _patch_sync()
        with (
            p_tok as m_tok,
            p_fresh as m_fresh,
            p_client as m_cli,
            p_con as m_con,
            p_map,
            p_repo as m_repo,
        ):
            repo = _setup_mocks(m_tok, m_fresh, m_cli, m_con, m_repo)
            twin = ActualSession(
                id=7,
                sport="running",
                source=ActivitySource.GARMIN_CONNECT,
                garmin_activity_id="g1",
            )
            repo.find_overlapping_session.return_value = twin
            resp = client.post("/strava/sync", json={"days": 30})
        assert resp.status_code == 200
        body = resp.json()
        assert body["merged"] == 2 and body["imported"] == 0
        assert repo.create_actual_session.call_count == 0
        kwargs = repo.update_actual_session_fields.call_args_list[0].kwargs
        assert kwargs["strava_activity_id"] == "1001"
        assert kwargs["name"] == "Morning Run"  # Garmin row had no name


def test_callback_lands_on_the_connections_tab(router_client):
    client = MagicMock()
    client.exchange_code.return_value = {
        "access_token": "at",
        "refresh_token": "rt",
        "expires_at": 9999999999,
        "athlete": {"id": 42, "firstname": "Greg"},
    }
    from arete.api import strava
    from arete.services import oauth_state

    state = oauth_state.issue(strava._state_secret(), athlete_id=1)
    with (
        patch("arete.api.strava._get_strava_client", return_value=client),
        patch("arete.api.strava._save_strava_tokens") as save,
    ):
        resp = router_client(router).get(
            f"/strava/callback?code=abc&state={state}", follow_redirects=False
        )
    assert resp.status_code in (302, 307)
    assert resp.headers["location"].endswith(
        "/settings?tab=connections&strava=connected"
    )
    save.assert_called_once()


def test_callback_without_our_state_stores_nothing(router_client):
    client = MagicMock()
    with (
        patch("arete.api.strava._get_strava_client", return_value=client),
        patch("arete.api.strava._save_strava_tokens") as save,
    ):
        missing = router_client(router).get("/strava/callback?code=abc")
        forged = router_client(router).get("/strava/callback?code=abc&state=1.2.3")
    assert missing.status_code == 400 and forged.status_code == 400
    client.exchange_code.assert_not_called()
    save.assert_not_called()


def test_state_secret_never_falls_back_to_the_process_secret_in_production(
    monkeypatch,
):
    from arete.api import strava

    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.delenv("CLERK_SECRET_KEY", raising=False)
    monkeypatch.delenv("CRON_SECRET", raising=False)
    assert strava._state_secret() != strava._PROCESS_SECRET


def test_oauth_refuses_a_forgeable_state_when_production_has_no_secret(
    router_client, monkeypatch
):
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.delenv("CLERK_SECRET_KEY", raising=False)
    monkeypatch.delenv("CRON_SECRET", raising=False)
    client = router_client(router)
    with patch("arete.api.strava._get_strava_client", return_value=MagicMock()):
        assert client.get("/strava/authorize").status_code == 503
    assert client.get("/strava/callback?code=abc&state=1.2.3").status_code == 503


def test_authorize_url_carries_a_signed_state(router_client):
    from urllib.parse import parse_qs, urlparse

    from arete.api import strava
    from arete.services import oauth_state

    client = MagicMock()
    client.get_authorize_url.side_effect = (
        lambda state=None: f"https://strava/?state={state}"
    )
    with patch("arete.api.strava._get_strava_client", return_value=client):
        url = router_client(router).get("/strava/authorize").json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    assert oauth_state.verify(strava._state_secret(), state)
