"""Tests for Garmin sync module."""

from __future__ import annotations

from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest

from arete.garmin.client import GarminAuthError
from arete.garmin.sync import (
    GarminActivity,
    GarminSyncClient,
    SyncResult,
)


class TestGarminActivity:
    """Tests for GarminActivity dataclass."""

    def test_from_api_response(self):
        """Test parsing from Garmin API response."""
        api_data = {
            "activityId": 12345678,
            "activityName": "Morning Run",
            "activityType": {"typeKey": "running"},
            "startTimeLocal": "2025-12-01T07:30:00",
            "duration": 3600.0,
            "distance": 10000.0,
            "averageHR": 145,
            "maxHR": 165,
            "calories": 650,
            "averageSpeed": 2.78,
            "maxSpeed": 3.5,
            "elevationGain": 120.0,
            "elevationLoss": 115.0,
            "averageRunningCadenceInStepsPerMinute": 175,
            "maxRunningCadenceInStepsPerMinute": 185,
        }

        activity = GarminActivity.from_api_response(api_data)

        assert activity.activity_id == 12345678
        assert activity.activity_name == "Morning Run"
        assert activity.activity_type == "running"
        assert activity.duration_sec == 3600
        assert activity.distance_m == 10000.0
        assert activity.avg_hr == 145
        assert activity.max_hr == 165
        assert activity.calories == 650
        assert activity.avg_cadence == 175

    def test_from_api_response_minimal(self):
        """Test parsing with minimal data."""
        api_data = {
            "activityId": 99999,
            "duration": 1800,
        }

        activity = GarminActivity.from_api_response(api_data)

        assert activity.activity_id == 99999
        assert activity.activity_name == ""
        assert activity.activity_type == "unknown"
        assert activity.duration_sec == 1800
        assert activity.distance_m is None
        assert activity.avg_hr is None

    def test_to_actual_session(self):
        """Test conversion to ActualSession."""
        activity = GarminActivity(
            activity_id=12345,
            activity_name="Test Run",
            activity_type="running",
            start_time=datetime(2025, 12, 1, 7, 30),
            duration_sec=3600,
            distance_m=10000.0,
            avg_hr=145,
            max_hr=165,
            calories=650,
            avg_speed_mps=2.78,
            max_speed_mps=3.5,
            ascent_m=120.0,
            descent_m=115.0,
            avg_cadence=175,
            max_cadence=185,
        )

        session = activity.to_actual_session()

        assert session.date == date(2025, 12, 1)
        assert session.sport == "running"
        assert session.duration_sec == 3600
        assert session.distance_m == 10000.0
        assert session.avg_hr == 145
        assert session.garmin_activity_id == "12345"
        # analytics columns derived at sync time
        assert session.name == "Test Run"
        assert session.avg_pace_sec_km == round(1000 / 2.78)
        assert session.moving_time_sec == 3600  # no movingDuration -> duration

    def test_map_activity_type(self):
        """Test activity type mapping."""
        test_cases = [
            ("running", "running"),
            ("trail_running", "running"),
            ("cycling", "cycling"),
            ("indoor_cycling", "cycling"),
            ("swimming", "swimming"),
            ("lap_swimming", "swimming"),
            ("strength_training", "strength"),
            ("hiking", "hiking"),
            ("unknown_type", "other"),
        ]

        for garmin_type, expected_sport in test_cases:
            activity = GarminActivity(
                activity_id=1,
                activity_name="Test",
                activity_type=garmin_type,
                start_time=datetime.now(),
                duration_sec=1000,
                distance_m=None,
                avg_hr=None,
                max_hr=None,
                calories=None,
                avg_speed_mps=None,
                max_speed_mps=None,
                ascent_m=None,
                descent_m=None,
                avg_cadence=None,
                max_cadence=None,
            )
            assert activity._map_activity_type() == expected_sport


class TestGarminSyncClient:
    """Tests for GarminSyncClient (Garmin access mocked through GarminClient)."""

    def _client(self, **attrs) -> GarminSyncClient:
        garmin = MagicMock()
        for k, v in attrs.items():
            setattr(garmin, k, v)
        return GarminSyncClient(client=garmin)

    def test_is_authenticated_delegates(self):
        client = self._client()
        client.client.is_authenticated.return_value = True
        assert client.is_authenticated() is True
        client.client.is_authenticated.return_value = False
        assert client.is_authenticated() is False

    def test_login_success(self):
        client = self._client()
        client.client.login.return_value = "ok"
        assert client.login(email="test@example.com", password="password123") == "ok"
        client.client.login.assert_called_once_with("test@example.com", "password123")

    def test_login_needs_mfa(self):
        client = self._client()
        client.client.login.return_value = "needs_mfa"
        assert client.login(email="a@b.c", password="x") == "needs_mfa"

    def test_login_no_credentials(self, monkeypatch):
        monkeypatch.delenv("GARMIN_EMAIL", raising=False)
        monkeypatch.delenv("GARMIN_PASSWORD", raising=False)
        with pytest.raises(ValueError, match="Garmin credentials required"):
            self._client().login()

    def test_global_credentials_cannot_connect_an_athlete(self, monkeypatch):
        monkeypatch.setenv("GARMIN_EMAIL", "env@example.com")
        monkeypatch.setenv("GARMIN_PASSWORD", "envpass")
        client = self._client()
        client.client.login.return_value = "ok"
        with pytest.raises(ValueError, match="Garmin credentials required"):
            client.login()
        client.client.login.assert_not_called()

    def test_logout_delegates(self):
        client = self._client()
        client.logout()
        client.client.logout.assert_called_once()

    def test_get_activities(self):
        client = self._client()
        client._last_request_time = 0.0
        client.client.activities.return_value = [
            {
                "activityId": 1,
                "activityName": "Run 1",
                "activityType": {"typeKey": "running"},
                "startTimeLocal": "2025-12-01T08:00:00",
                "duration": 3600,
            },
            {
                "activityId": 2,
                "activityName": "Run 2",
                "activityType": {"typeKey": "running"},
                "startTimeLocal": "2025-12-02T08:00:00",
                "duration": 2700,
            },
        ]
        with patch("arete.garmin.sync.time.sleep"):
            activities = client.get_activities(
                start_date=date(2025, 12, 1), end_date=date(2025, 12, 5), limit=10
            )
        assert [a.activity_id for a in activities] == [1, 2]
        client.client.activities.assert_called_once_with(
            date(2025, 12, 1), date(2025, 12, 5)
        )

    def test_get_activities_respects_limit_and_skips_garbage(self):
        client = self._client()
        client.client.activities.return_value = [
            "not-a-dict",
            {"activityId": 1, "startTimeLocal": "2025-12-01T08:00:00", "duration": 1},
            {"activityId": 2, "startTimeLocal": "2025-12-02T08:00:00", "duration": 1},
        ]
        with patch("arete.garmin.sync.time.sleep"):
            activities = client.get_activities(limit=2)
        assert [a.activity_id for a in activities] == [1]

    def test_download_fit_file_writes_and_caches(self, tmp_path):
        client = self._client()
        client.client.download_fit.return_value = b"FITDATA"
        with patch("arete.garmin.sync.time.sleep"):
            path = client.download_fit_file(42, output_dir=tmp_path)
            assert path == tmp_path / "42.fit"
            assert path.read_bytes() == b"FITDATA"
            # second call: served from disk, no API call
            client.download_fit_file(42, output_dir=tmp_path)
        client.client.download_fit.assert_called_once()

    def _sync_with(self, repo, raw):
        from arete.features.hr_zones import ZoneModel

        client = GarminSyncClient(client=MagicMock(), zones=ZoneModel.from_reference())
        client.client.activities.return_value = raw
        client._repository = repo
        with (
            patch("arete.garmin.sync.time.sleep"),
            patch("arete.garmin.sync.refresh_threshold", return_value={}),
        ):
            return client, client.sync_activities(download_fit=False)

    def test_sync_starts_from_the_newest_garmin_activity(self):
        repo = MagicMock()
        repo.last_garmin_import.return_value = (date(2026, 9, 1), None)
        repo.has_garmin_activity.return_value = False
        client, _ = self._sync_with(repo, [])
        start, _end = client.client.activities.call_args.args
        assert start == date(2026, 9, 1)

    def test_new_activities_are_matched_to_the_plan(self):
        from arete.garmin.models import PlannedSession, SessionStatus, SessionType

        repo = MagicMock()
        repo.last_garmin_import.return_value = (None, None)
        repo.has_garmin_activity.return_value = False
        repo.find_overlapping_session.return_value = None
        repo.create_actual_session.return_value = 42
        repo.get_potential_matches.return_value = [
            PlannedSession(
                id=7,
                date=date(2026, 10, 1),
                sport="running",
                session_type=SessionType.ENDURANCE,
                target_duration_min=60,
                status=SessionStatus.PENDING,
            )
        ]
        raw = [
            {
                "activityId": 1,
                "activityName": "Footing",
                "startTimeLocal": "2026-10-01T08:00:00",
                "duration": 3600,
                "activityType": {"typeKey": "trail_running"},
            }
        ]
        _, result = self._sync_with(repo, raw)
        assert result.activities_synced == 1
        assert result.activities_matched == 1
        repo.update_actual_session_match.assert_called_once()
        assert repo.update_actual_session_match.call_args.args[:2] == (42, 7)

    def test_new_and_merged_sessions_are_reported_with_their_streams(self, tmp_path):
        from arete.features.hr_zones import ZoneModel
        from arete.garmin.models import ActualSession
        from arete.garmin.streams import ActivityStreams

        repo = MagicMock()
        repo.last_garmin_import.return_value = (None, None)
        repo.has_garmin_activity.return_value = False
        repo.get_potential_matches.return_value = []
        strava_twin = ActualSession(id=9, source="strava", planned_session_id=3)
        repo.find_overlapping_session.side_effect = [None, strava_twin]
        repo.create_actual_session.return_value = 42
        raw = [
            {
                "activityId": n,
                "startTimeLocal": f"2026-10-0{n}T08:00:00",
                "duration": 3600,
                "activityType": {"typeKey": "running"},
            }
            for n in (1, 2)
        ]
        streams = ActivityStreams(t=[0, 1], heart_rate=[140, 141])
        client = GarminSyncClient(client=MagicMock(), zones=ZoneModel.from_reference())
        client.client.activities.return_value = raw
        client._repository = repo
        fit = tmp_path / "a.fit"
        with (
            patch("arete.garmin.sync.time.sleep"),
            patch("arete.garmin.sync.refresh_threshold", return_value={}),
            patch.object(client, "download_fit_file", return_value=fit),
            patch.object(
                client, "_enrich_from_fit", side_effect=lambda s, _p: (s, streams)
            ),
        ):
            result = client.sync_activities()
        assert result.session_ids == [42, 9]
        assert [c.args for c in repo.save_activity_streams.call_args_list] == [
            (42, streams),
            (9, streams),
        ]

    def test_a_stream_write_failure_keeps_the_session(self):
        from arete.garmin.streams import ActivityStreams

        repo = MagicMock()
        repo.save_activity_streams.side_effect = RuntimeError("disk full")
        client = GarminSyncClient(client=MagicMock())
        client._repository = repo
        assert client._save_streams(1, ActivityStreams(t=[0])) is False

    def test_sync_activities_reports_auth_error(self):
        client = self._client()
        client.client.activities.side_effect = GarminAuthError("no tokens")
        client._repository = MagicMock()
        client._repository.has_garmin_activity.return_value = False
        client._repository.last_garmin_import.return_value = (None, None)
        with patch("arete.garmin.sync.time.sleep"):
            result = client.sync_activities(start_date=date(2025, 12, 1))
        assert result.success is False
        assert "no tokens" in result.errors[0]


class TestAnalyticsColumns:
    def test_pace_only_for_foot_sports(self):
        from arete.garmin.sync import pace_from_speed

        assert pace_from_speed(2.5, "running") == 400
        assert pace_from_speed(2.5, "walking") == 400
        assert pace_from_speed(8.0, "cycling") is None
        assert pace_from_speed(None, "running") is None
        assert pace_from_speed(0.0, "running") is None

    def test_moving_duration_from_api(self):
        activity = GarminActivity.from_api_response(
            {
                "activityId": 1,
                "startTimeLocal": "2025-12-01T08:00:00",
                "duration": 3600,
                "movingDuration": 3400.0,
            }
        )
        assert activity.to_actual_session().moving_time_sec == 3400

    def test_laps_json_matches_strava_shape(self):
        import json
        from types import SimpleNamespace

        from arete.garmin.sync import laps_to_json

        lap = SimpleNamespace(
            lap_number=1,
            distance_m=1000.4,
            duration_sec=300.0,
            avg_speed_mps=3.3,
            avg_hr=150,
            max_hr=160,
            avg_cadence=170,
        )
        parsed = SimpleNamespace(workout_structure=SimpleNamespace(laps=[lap]))
        laps = json.loads(laps_to_json(parsed))
        assert laps[0]["distance"] == 1000.4
        assert laps[0]["average_heartrate"] == 150 and laps[0]["average_speed"] == 3.3
        assert laps_to_json(SimpleNamespace(workout_structure=None)) is None


class TestAutoMatch:
    def _planned(self, **kw):
        from arete.garmin.models import PlannedSession, SessionStatus, SessionType

        return PlannedSession(
            id=kw.get("id", 10),
            date=date(2026, 9, 18),
            sport=kw.get("sport", "running"),
            session_type=kw.get("session_type", SessionType.TEMPO),
            target_duration_min=55,
            status=kw.get("status", SessionStatus.PENDING),
        )

    def _actual(self):
        from arete.garmin.models import ActualSession

        return ActualSession(
            date=date(2026, 9, 18),
            sport="running",
            session_type="running",
            duration_sec=3300,
        )

    def test_links_pending_planned_session_of_the_day(self):
        from arete.garmin.models import SessionStatus
        from arete.garmin.sync import auto_match

        repo = MagicMock()
        repo.get_potential_matches.return_value = [self._planned()]
        assert auto_match(repo, 42, self._actual()) == 10
        repo.update_actual_session_match.assert_called_once()
        assert repo.update_actual_session_match.call_args.args[:2] == (42, 10)
        repo.update_planned_session_status.assert_called_once_with(
            10, SessionStatus.COMPLETED
        )

    def test_ignores_already_completed_and_other_sports(self):
        from arete.garmin.models import SessionStatus
        from arete.garmin.sync import auto_match

        repo = MagicMock()
        repo.get_potential_matches.return_value = [
            self._planned(status=SessionStatus.COMPLETED),
            self._planned(id=11, sport="strength"),
        ]
        assert auto_match(repo, 42, self._actual()) is None
        repo.update_actual_session_match.assert_not_called()


class TestCompletePlanned:
    def test_marks_first_pending_of_sport(self):
        from arete.garmin.models import PlannedSession, SessionStatus, SessionType
        from arete.garmin.sync import complete_planned

        repo = MagicMock()
        repo.list_planned_sessions.return_value = [
            PlannedSession(
                id=1,
                date=date(2026, 9, 17),
                sport="running",
                session_type=SessionType.TEMPO,
            ),
            PlannedSession(
                id=2,
                date=date(2026, 9, 17),
                sport="strength",
                session_type=SessionType.STRENGTH,
                status=SessionStatus.COMPLETED,
            ),
            PlannedSession(
                id=3,
                date=date(2026, 9, 17),
                sport="strength",
                session_type=SessionType.STRENGTH,
            ),
        ]
        assert complete_planned(repo, date(2026, 9, 17), "strength") == 3
        repo.update_planned_session_status.assert_called_once_with(
            3, SessionStatus.COMPLETED
        )

    def test_nothing_to_complete(self):
        from arete.garmin.sync import complete_planned

        repo = MagicMock()
        repo.list_planned_sessions.return_value = []
        assert complete_planned(repo, date(2026, 9, 17), "strength") is None


class TestSyncResult:
    """Tests for SyncResult dataclass."""

    def test_default_values(self):
        """Test default SyncResult values."""
        result = SyncResult(success=True)

        assert result.success is True
        assert result.activities_synced == 0
        assert result.activities_skipped == 0
        assert result.errors == []
        assert result.last_activity_date is None

    def test_with_values(self):
        """Test SyncResult with values."""
        result = SyncResult(
            success=True,
            activities_synced=5,
            activities_skipped=2,
            errors=["Error 1"],
            last_activity_date=date(2025, 12, 1),
        )

        assert result.activities_synced == 5
        assert result.activities_skipped == 2
        assert len(result.errors) == 1
        assert result.last_activity_date == date(2025, 12, 1)


def test_sync_status_reports_the_last_garmin_import(router_client):
    from datetime import datetime

    from arete.api import garmin_sync

    imported = datetime(2026, 10, 8, 8, 2, 11)
    with (
        patch("arete.garmin.token_store.session_status", return_value=(False, None)),
        patch.object(
            garmin_sync._repo, "last_garmin_import", return_value=(None, imported)
        ),
        patch.object(garmin_sync._repo, "count_actual_sessions", return_value=3),
    ):
        body = router_client(garmin_sync.router).get("/garmin/sync/status").json()
    assert body["last_sync"] == imported.isoformat()
    assert body["activities_synced"] == 3


def test_progress_tracks_skips_fit_failures_and_committed_work():
    from arete.garmin.sync import GarminActivity, SyncProgress

    repo = MagicMock()
    repo.find_overlapping_session.return_value = None
    repo.get_potential_matches.return_value = []
    repo.create_actual_session.side_effect = [42, RuntimeError("write failed")]
    client = GarminSyncClient(client=MagicMock(), repository=repo)
    activities = [
        GarminActivity.from_api_response(
            {
                "activityId": n,
                "activityName": f"Course {n}",
                "startTimeLocal": "2026-10-01T08:00:00",
            }
        )
        for n in (1, 2, 3)
    ]
    with (
        patch.object(client, "refresh_threshold"),
        patch.object(client, "get_activities", return_value=activities),
        patch.object(client, "_is_already_synced", side_effect=[True, False, False]),
        patch.object(client, "download_fit_file", return_value=None),
    ):
        events = list(client.iter_sync_activities(start_date=date(2026, 10, 1)))
    progress = [event for event in events if isinstance(event, SyncProgress)]
    assert [p.completed for p in progress if p.stage == "processing"] == [0, 1, 2, 3]
    assert [p.activity_name for p in progress if p.stage == "fit"] == [
        "Course 2",
        "Course 3",
    ]
    result = events[-1]
    assert isinstance(result, SyncResult)
    assert result.activities_skipped == 1
    assert result.activities_synced == 1
    assert result.session_ids == [42]
    assert len(result.errors) == 3  # Two missing FIT files, one failed write.


def test_closing_progress_before_fit_stops_before_download_or_write():
    from arete.garmin.sync import GarminActivity

    client = GarminSyncClient(client=MagicMock(), repository=MagicMock())
    activity = GarminActivity.from_api_response(
        {
            "activityId": 1,
            "activityName": "Course",
            "startTimeLocal": "2026-10-01T08:00:00",
        }
    )
    with (
        patch.object(client, "refresh_threshold"),
        patch.object(client, "get_activities", return_value=[activity]),
        patch.object(client, "_is_already_synced", return_value=False),
        patch.object(client, "download_fit_file") as download,
    ):
        work = client.iter_sync_activities(start_date=date(2026, 10, 1))
        assert [next(work).stage for _ in range(4)] == [
            "preparing",
            "fetching",
            "processing",
            "fit",
        ]
        work.close()
    download.assert_not_called()
    client.repository.create_actual_session.assert_not_called()


def test_requested_200_activities_are_not_silently_capped_at_100():
    client = GarminSyncClient(client=MagicMock())
    client.client.activities.return_value = [
        {"activityId": n, "startTimeLocal": "2026-10-01T08:00:00"} for n in range(210)
    ]
    assert len(client.get_activities(limit=200)) == 200


def history_client(raw):
    repo = MagicMock()
    repo.last_garmin_import.return_value = (None, None)
    repo.has_garmin_activity.return_value = True
    client = GarminSyncClient(client=MagicMock(), repository=repo)
    client.client.activity_page.return_value = raw
    return client


def history_activity(activity_id):
    return {"activityId": activity_id, "startTimeLocal": "2010-01-01T08:00:00"}


def test_history_continues_past_a_page_of_already_imported_activities():
    client = history_client([history_activity(n) for n in range(40, 20, -1)])
    with patch.object(client, "refresh_threshold") as threshold:
        first = client.sync_activities(history_offset=0, max_activities=20)
        assert first.success and first.activities_skipped == 20
        assert first.next_history_offset == 20 and first.history_anchor == 21
        client.client.activity_page.return_value = [
            history_activity(21),
            history_activity(20),
        ]
        last = client.sync_activities(
            history_offset=20, history_anchor=21, max_activities=20
        )
    assert last.success and last.activities_skipped == 1
    assert last.next_history_offset is None and last.history_anchor is None
    client.client.activity_page.assert_called_with(19, 21)
    client.client.activities.assert_not_called()
    threshold.assert_called_once()
    client.repository.create_actual_session.assert_not_called()


@pytest.mark.parametrize("raw", [[], [history_activity(999)], [{"activityId": 21}, {}]])
def test_history_stops_on_shifted_or_invalid_pages_before_writing(raw):
    client = history_client(raw)
    result = client.sync_activities(
        history_offset=20, history_anchor=21, max_activities=20
    )
    assert not result.success and result.errors
    client.repository.create_actual_session.assert_not_called()


def test_history_bound_requires_an_empty_final_probe():
    client = history_client([history_activity(21)])
    result = client.sync_activities(
        history_offset=20_000, history_anchor=21, max_activities=20
    )
    assert result.success and result.next_history_offset is None
    client.client.activity_page.return_value.append(history_activity(20))
    result = client.sync_activities(
        history_offset=20_000, history_anchor=21, max_activities=20
    )
    assert not result.success and "20 000" in result.errors[0]
    client.repository.create_actual_session.assert_not_called()


@pytest.mark.parametrize("path", ["/activities", "/activities/stream"])
@pytest.mark.parametrize(
    "payload",
    [
        {"history_offset": 0},
        {"history_offset": 20, "max_activities": 20},
        {"history_offset": 0, "max_activities": 20, "history_anchor": 5},
        {"history_offset": 0, "max_activities": 20, "start_date": "2010-01-01"},
        {"history_offset": 20_001, "max_activities": 20, "history_anchor": 5},
        {"history_anchor": 5},
    ],
)
def test_invalid_history_requests_never_start_work(router_client, path, payload):
    from arete.api.garmin_sync import router

    with patch.object(GarminSyncClient, "is_authenticated") as auth:
        response = router_client(router).post(f"/garmin/sync{path}", json=payload)
    assert response.status_code == 422
    auth.assert_not_called()


def test_history_stream_preserves_the_continuation(router_client):
    import json

    from arete.api.garmin_sync import router

    with (
        patch.object(GarminSyncClient, "is_authenticated", return_value=True),
        patch.object(
            GarminSyncClient,
            "iter_sync_activities",
            return_value=(
                event
                for event in [
                    SyncResult(
                        success=True,
                        activities_skipped=20,
                        next_history_offset=20,
                        history_anchor=123,
                    ),
                ]
            ),
        ) as work,
        patch("arete.services.session_conditions.enrich_sessions"),
    ):
        response = router_client(router).post(
            "/garmin/sync/activities/stream",
            json={"history_offset": 0, "max_activities": 20},
        )
    terminal = json.loads(
        response.text.strip().split("\n\n")[-1].removeprefix("data: ")
    )
    assert terminal["next_history_offset"] == 20 and terminal["history_anchor"] == 123
    assert work.call_args.kwargs["history_offset"] == 0


def test_sync_stream_protocol_and_enrichment(router_client):
    import json

    from arete.api.garmin_sync import router
    from arete.garmin.sync import SyncProgress

    with (
        patch.object(GarminSyncClient, "is_authenticated", return_value=True),
        patch.object(
            GarminSyncClient,
            "iter_sync_activities",
            return_value=(
                event
                for event in [
                    SyncProgress("fetching"),
                    SyncProgress("processing", 1, 1),
                    SyncResult(
                        success=True,
                        activities_synced=1,
                        session_ids=[42],
                        last_activity_date=date(2026, 10, 1),
                    ),
                ]
            ),
        ),
        patch("arete.services.session_conditions.enrich_sessions") as enrich,
    ):
        response = router_client(router).post("/garmin/sync/activities/stream", json={})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = [
        json.loads(frame.removeprefix("data: "))
        for frame in response.text.strip().split("\n\n")
    ]
    assert [event["type"] for event in events] == [
        "progress",
        "progress",
        "progress",
        "done",
    ]
    assert events[-2]["stage"] == "finalizing"
    assert events[-1]["last_activity_date"] == "2026-10-01"
    assert "session_ids" not in events[-1]
    enrich.assert_called_once_with([42])


def test_sync_stream_auth_and_validation_happen_before_work(router_client):
    from arete.api.garmin_sync import router

    with (
        patch.object(GarminSyncClient, "is_authenticated", return_value=False),
        patch.object(GarminSyncClient, "iter_sync_activities") as work,
    ):
        api = router_client(router)
        assert api.post("/garmin/sync/activities/stream", json={}).status_code == 409
        assert (
            api.post(
                "/garmin/sync/activities/stream", json={"max_activities": 201}
            ).status_code
            == 422
        )
    work.assert_not_called()


def test_sync_stream_reports_failure_without_success_or_replay(router_client):
    import json

    from arete.api.garmin_sync import router
    from arete.garmin.sync import SyncProgress

    def failing_work(**kwargs):
        yield SyncProgress("fetching")
        raise RuntimeError("private upstream details")

    with (
        patch.object(GarminSyncClient, "is_authenticated", return_value=True),
        patch.object(
            GarminSyncClient, "iter_sync_activities", side_effect=failing_work
        ) as work,
        patch("arete.services.session_conditions.enrich_sessions") as enrich,
    ):
        response = router_client(router).post("/garmin/sync/activities/stream", json={})
    events = [
        json.loads(frame.removeprefix("data: "))
        for frame in response.text.strip().split("\n\n")
    ]
    assert [event["type"] for event in events] == ["progress", "error"]
    assert "private" not in response.text
    work.assert_called_once()
    enrich.assert_not_called()


def _coach_sync(events, *, deadline=None, authenticated=True):
    """Run the coach's sync over scripted events; returns (result, work, enrich)."""
    from arete.services import garmin_sync as service

    def work(**kwargs):
        yield from events

    recent = {
        "sessions": [{"id": 42, "date": "2026-10-10"}, {"id": 7, "date": "2026-10-01"}]
    }
    with (
        patch.object(GarminSyncClient, "is_authenticated", return_value=authenticated),
        patch.object(
            GarminSyncClient, "iter_sync_activities", side_effect=work
        ) as started,
        patch("arete.services.session_conditions.enrich_sessions") as enrich,
        patch("arete.services.analytics.list_sessions", return_value=recent),
    ):
        return service.sync_recent(deadline=deadline), started, enrich


def test_coach_sync_returns_the_imported_sessions_it_enriched():
    from arete.garmin.sync import SyncProgress
    from arete.services.garmin_sync import MAX_ACTIVITIES

    result, started, enrich = _coach_sync(
        [
            SyncProgress("fetching"),
            SyncResult(
                success=True,
                activities_synced=1,
                activities_skipped=3,
                session_ids=[42],
            ),
        ]
    )
    started.assert_called_once_with(max_activities=MAX_ACTIVITIES)
    enrich.assert_called_once_with([42])
    assert result["complete"] is True
    assert result["imported"] == 1
    assert result["already_present"] == 3
    assert result["sessions"] == [{"id": 42, "date": "2026-10-10"}]


def test_coach_sync_stops_between_steps_when_the_run_runs_out_of_time():
    from time import monotonic

    from arete.garmin.sync import SyncProgress

    result, _, enrich = _coach_sync(
        [SyncProgress("fetching"), SyncResult(success=True, session_ids=[42])],
        deadline=monotonic() + 1,
    )
    assert result["complete"] is False
    assert "list_recent_sessions" in result["error"]
    enrich.assert_not_called()


def test_coach_sync_needs_a_garmin_connection_before_any_work():
    with pytest.raises(PermissionError, match="Réglages"):
        _coach_sync([], authenticated=False)


def test_coach_sync_refuses_an_overlapping_run_for_the_same_athlete():
    from arete.garmin.sync import SyncProgress
    from arete.services import garmin_sync as service

    def overlapping():
        yield SyncProgress("fetching")
        with pytest.raises(RuntimeError, match="déjà en cours"):
            service.sync_recent()
        yield SyncResult(success=True)

    result, _, _ = _coach_sync(overlapping())
    assert result["complete"] is True
    assert not service._running


class TestSyncStatusFromLocalState:
    """The dashboard asks on every load: answered without Garmin."""

    @pytest.fixture
    def tokens(self, tmp_path, monkeypatch):
        directory = tmp_path / "garmin_tokens"
        monkeypatch.setenv("ARETE_GARMIN_TOKENS_DIR", str(directory))
        return directory

    def status(self, router_client):
        from arete.api import garmin_sync

        return router_client(garmin_sync.router).get("/garmin/sync/status").json()

    def test_stored_tokens_answer_without_a_garmin_login(self, router_client, tokens):
        from arete.garmin.token_store import save_account

        tokens.mkdir()
        (tokens / "garmin_tokens.json").write_text("{}")
        save_account(tokens / "garmin_tokens.json", "me@garmin.test", remote=False)
        with patch("arete.garmin.client.Garmin") as garmin:
            body = self.status(router_client)
        garmin.assert_not_called()
        garmin.return_value.login.assert_not_called()
        assert body["garmin_authenticated"] is True
        assert body["user_email"] == "me@garmin.test"

    def test_tokens_saved_before_the_account_was_recorded(self, router_client, tokens):
        tokens.mkdir()
        (tokens / "garmin_tokens.json").write_text("{}")
        body = self.status(router_client)
        assert (body["garmin_authenticated"], body["user_email"]) == (True, None)

    def test_tokens_garmin_refused_ask_to_reconnect(self, router_client, tokens):
        from arete.garmin.token_store import refused, save_account

        tokens.mkdir()
        token = tokens / "garmin_tokens.json"
        token.write_text("{}")
        save_account(token, "me@garmin.test", remote=False)
        refused(token, remote=False)
        body = self.status(router_client)
        assert (body["garmin_authenticated"], body["user_email"]) == (
            False,
            "me@garmin.test",
        )

    def test_no_tokens_is_not_connected(self, router_client, tokens):
        body = self.status(router_client)
        assert (body["garmin_authenticated"], body["user_email"]) == (False, None)


def test_status_leaves_garminconnect_out_and_answers_fast(tmp_path):
    """A cold instance: the status must not import Garmin's client at all."""
    import json
    import os
    import subprocess
    import sys

    tokens = tmp_path / "garmin_tokens"
    tokens.mkdir()
    (tokens / "garmin_tokens.json").write_text("{}")
    code = """
import json, sys, time
from fastapi.testclient import TestClient
from arete.dataio.init_duckdb import main as init_schema
init_schema()
from arete.api.main import app
client = TestClient(app)
client.get("/garmin/sync/status")
start = time.perf_counter()
body = client.get("/garmin/sync/status").json()
print(json.dumps({"body": body, "ms": (time.perf_counter() - start) * 1000,
                  "garmin": "garminconnect" in sys.modules}))
"""
    env = {
        **os.environ,
        "ARETE_DB": str(tmp_path / "status.duckdb"),
        "ARETE_DATA_DIR": str(tmp_path / "files"),
        "ARETE_GARMIN_TOKENS_DIR": str(tokens),
        "PYTHON_DOTENV_DISABLED": "1",
    }
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env
    )
    assert out.returncode == 0, out.stderr
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["body"]["garmin_authenticated"] is True
    assert result["garmin"] is False
    # A Garmin login took seconds; the bound is loose for shared CI runners.
    assert result["ms"] < 500, result
