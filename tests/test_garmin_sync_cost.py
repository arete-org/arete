"""What one onboarding import costs: Garmin requests and database statements.

The real importer and repository run against the test database; only the HTTP
session under ``GarminClient``'s budgeted transport is replaced.
"""

from datetime import timedelta
from unittest.mock import Mock

import pytest

from arete.dataio.db import db_connection
from arete.garmin.client import GarminClient
from arete.observability.requests import RequestTiming, current_request
from arete.services import garmin_sync as service
from arete.services.athlete_scope import athlete_scope
from arete.services.settings import athlete_today

FIRST_ID = 9_177_000


def _activities(count):
    today = athlete_today()
    return [
        {
            "activityId": FIRST_ID + i,
            "activityName": f"Footing {i}",
            "activityType": {"typeKey": "running"},
            "startTimeLocal": f"{today - timedelta(days=i + 1)}T07:30:00",
            "duration": 2400.0,
            "distance": 7000.0,
            "averageSpeed": 2.9,
        }
        for i in range(count)
    ]


@pytest.fixture
def athlete():
    with db_connection() as con:
        athlete_id = con.execute(
            "INSERT INTO app.athletes (id) VALUES (nextval('app.athletes_seq')) RETURNING id"
        ).fetchone()[0]
    with athlete_scope(athlete_id):
        with db_connection() as con:
            con.execute(
                "INSERT INTO app.game_profile(id,athlete_id) VALUES(1,?) ON CONFLICT DO NOTHING",
                [athlete_id],
            )
        yield athlete_id


@pytest.fixture
def garmin(monkeypatch):
    """Garmin's HTTP session: activity pages from ``pages``, every other read empty."""
    from garminconnect import Garmin

    monkeypatch.setattr("arete.garmin.token_store.session_status", lambda: (True, None))
    monkeypatch.setattr(
        "arete.services.session_conditions.enrich_sessions", lambda *a, **k: {}
    )
    # The 3 s pacing is counted, not waited for.
    monkeypatch.setattr("arete.garmin.sync_budget.sleep", lambda _seconds: None)
    pages: list[list[dict]] = []
    paths: list[str] = []

    def request(method, url, **kwargs):
        paths.append(url)
        response = Mock(status_code=200)
        if "activities/search/activities" in url:
            start, limit = (
                int(kwargs["params"]["start"]),
                int(kwargs["params"]["limit"]),
            )
            rows = pages[0] if pages else []
            response.json.return_value = rows[start : start + limit]
        elif "socialProfile" in url:
            response.json.return_value = {"displayName": "pierre", "profileId": 7}
        else:
            response.json.return_value = []
        return response

    def connect(self):
        if self._api is None:
            api = Garmin(retry_attempts=0)
            api.client._run_request = self._sync_request
            api.client.get_api_headers = lambda: {}
            api.client._api_session.request = request
            api._load_social_profile = self._sync_load_profile
            self._api = api
        return self._api

    monkeypatch.setattr(GarminClient, "connect", connect)
    return pages, paths


def _run_onboarding_import(monkeypatch):
    """The import's result, its statements by kind, and the stored sync state."""
    from collections import Counter

    from arete.observability.requests import _CountedConnection

    kinds: Counter[str] = Counter()
    execute = _CountedConnection.execute

    def counted(self, sql, *args, **kwargs):
        head = sql.split(None, 1)[0].upper()
        # Opening a connection: PRAGMAs locally (USE remotely), the athlete variable.
        kinds["setup" if head in {"PRAGMA", "SET", "USE"} else "work"] += 1
        return execute(self, sql, *args, **kwargs)

    monkeypatch.setattr(_CountedConnection, "execute", counted)
    timing = RequestTiming()
    token = current_request.set(timing)
    try:
        events = list(service.iter_manual(max_activities=20, download_fit=False))
    finally:
        current_request.reset(token)
        monkeypatch.setattr(_CountedConnection, "execute", execute)
    assert sum(kinds.values()) == timing.db_statements
    return events[-1], kinds, service.status()


def _reset_sync_state(athlete):
    with db_connection() as con:
        con.execute("DELETE FROM app.garmin_sync_state WHERE athlete_id=?", [athlete])


def test_first_onboarding_import_costs(athlete, garmin, monkeypatch):
    """ARE-177: 18 requests and 13 + 26 statements per activity before."""
    pages, paths = garmin
    pages.append(_activities(25))
    result, kinds, state = _run_onboarding_import(monkeypatch)
    assert result.success and result.more_pending and result.activities_synced == 20
    # Threshold (two reads) and one activity page: no health, no profile lookup.
    assert state["provider_calls"] == len(paths) <= 5
    assert not [path for path in paths if "wellness" in path or "Profile" in path]
    # The same run without new activities measures the per-run overhead.
    _reset_sync_state(athlete)
    pages[0] = []
    _, empty, _ = _run_onboarding_import(monkeypatch)
    per_activity = {kind: (kinds[kind] - empty[kind]) / 20 for kind in kinds}
    # Local connections open with three statements, remote ones with two.
    assert per_activity["work"] <= 8, per_activity
    assert per_activity["setup"] <= 16, per_activity


def test_a_repeated_import_skips_what_the_first_committed(athlete, garmin, monkeypatch):
    pages, _ = garmin
    pages.append(_activities(3))
    first, _, _ = _run_onboarding_import(monkeypatch)
    _reset_sync_state(athlete)
    again, _, _ = _run_onboarding_import(monkeypatch)
    assert first.activities_synced == 3
    assert again.activities_synced == 0 and again.activities_skipped == 3
    with db_connection() as con:
        count = con.execute(
            "SELECT count(*) FROM app.visible_actual_sessions WHERE garmin_activity_id LIKE '9177%'"
        ).fetchone()[0]
    assert count == 3


def test_garmin_still_takes_over_a_legacy_strava_row(athlete, garmin, monkeypatch):
    pages, _ = garmin
    pages.append(_activities(2))
    start = pages[0][1]["startTimeLocal"]
    with db_connection() as con:
        legacy = con.execute(
            "INSERT INTO app.actual_sessions (user_id, date, sport, duration_sec, source, start_time, notes) "
            "VALUES (?, CAST(? AS DATE), 'running', 2400, 'strava', CAST(? AS TIMESTAMP), 'Strava') RETURNING id",
            [athlete, start[:10], start],
        ).fetchone()[0]
    result, _, _ = _run_onboarding_import(monkeypatch)
    assert result.activities_merged == 1 and result.activities_synced == 1
    with db_connection() as con:
        source, notes = con.execute(
            "SELECT source, notes FROM app.visible_actual_sessions WHERE id=?",
            [legacy],
        ).fetchone()
    assert source == "garmin_connect" and notes is None


def test_a_presence_answer_is_used_once():
    from arete.garmin.sync import GarminSyncClient

    repository = Mock()
    repository.has_garmin_activity.return_value = True
    importer = GarminSyncClient(client=Mock(), repository=repository)
    importer.presence[7] = False
    assert importer._is_already_synced(7) is False
    repository.has_garmin_activity.assert_not_called()
    # Other callers, and a second look, still query the archive.
    assert importer._is_already_synced(7) is True
    repository.has_garmin_activity.assert_called_once_with(7)
