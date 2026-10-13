"""Tests for GarminClient (garminconnect mocked) and health-metric mapping."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from arete.garmin import health_sync
from arete.garmin.client import TOKEN_FILE, GarminAuthError, GarminClient


@pytest.fixture
def token_dir(tmp_path):
    return tmp_path / "tokens"


class TestGarminClientAuth:
    def test_connect_without_tokens_raises(self, token_dir):
        with pytest.raises(GarminAuthError, match="No Garmin tokens"):
            GarminClient(token_dir).connect()
        assert GarminClient(token_dir).is_authenticated() is False

    def test_connect_restores_saved_session(self, token_dir):
        token_dir.mkdir()
        (token_dir / TOKEN_FILE).write_text("{}")
        with patch("arete.garmin.client.Garmin") as garmin_cls:
            client = GarminClient(token_dir)
            api = client.connect()
            assert client.connect() is api  # cached
        garmin_cls.return_value.login.assert_called_once_with(str(token_dir))

    def test_connect_with_broken_tokens_raises(self, token_dir):
        token_dir.mkdir()
        (token_dir / TOKEN_FILE).write_text("{}")
        with patch("arete.garmin.client.Garmin") as garmin_cls:
            garmin_cls.return_value.login.side_effect = RuntimeError("expired")
            with pytest.raises(GarminAuthError, match="could not be restored"):
                GarminClient(token_dir).connect()

    def test_login_saves_tokens(self, token_dir):
        with patch("arete.garmin.client.Garmin") as garmin_cls:
            api = garmin_cls.return_value
            api.login.return_value = (None, None)
            assert GarminClient(token_dir).login("a@b.c", "pw") == "ok"
        garmin_cls.assert_called_once_with(
            "a@b.c", "pw", return_on_mfa=True, retry_attempts=0
        )
        api.client.dump.assert_called_once_with(str(token_dir))
        assert token_dir.exists()

    def test_login_mfa_flow(self, token_dir):
        with patch("arete.garmin.client.Garmin") as garmin_cls:
            api = garmin_cls.return_value
            api.login.return_value = ("needs_mfa", None)
            client = GarminClient(token_dir)
            assert client.login("a@b.c", "pw") == "needs_mfa"
            api.client.dump.assert_not_called()

            GarminClient(token_dir).complete_mfa("123456")
        api.resume_login.assert_called_once_with({}, "123456")
        api.client.dump.assert_called_once_with(str(token_dir))
        assert not GarminClient._pending_mfa

    def test_complete_mfa_without_pending_login(self, token_dir):
        GarminClient._pending_mfa.clear()
        with pytest.raises(GarminAuthError, match="No login waiting"):
            GarminClient(token_dir).complete_mfa("000000")

    def test_logout_removes_token_file(self, token_dir):
        token_dir.mkdir()
        (token_dir / TOKEN_FILE).write_text("{}")
        (token_dir / "account.json").write_text('{"account": "a@b.c"}')
        GarminClient(token_dir).logout()
        assert not (token_dir / TOKEN_FILE).exists()
        assert not (token_dir / "account.json").exists()

    def test_login_records_the_account_for_the_status(self, token_dir):
        with patch("arete.garmin.client.Garmin") as garmin_cls:
            api = garmin_cls.return_value
            api.login.return_value = (None, None)
            api.username = "a@b.c"
            GarminClient(token_dir).login("a@b.c", "pw")
        assert json.loads((token_dir / "account.json").read_text()) == {
            "account": "a@b.c"
        }

    def test_a_restored_session_records_a_missing_account(self, token_dir):
        token_dir.mkdir()
        (token_dir / TOKEN_FILE).write_text("{}")
        with patch("arete.garmin.client.Garmin") as garmin_cls:
            api = garmin_cls.return_value
            api.username, api.full_name = None, "Jean Coureur"
            GarminClient(token_dir).connect()
        assert json.loads((token_dir / "account.json").read_text()) == {
            "account": "Jean Coureur"
        }


class TestGarminClientData:
    def _client(self, token_dir) -> tuple[GarminClient, MagicMock]:
        client = GarminClient(token_dir)
        api = MagicMock()
        client._api = api
        return client, api

    def test_download_fit_unzips_original(self, token_dir):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("12345_ACTIVITY.fit", b"FIT-BYTES")
        client, api = self._client(token_dir)
        api.download_activity.return_value = buf.getvalue()
        assert client.download_fit(12345) == b"FIT-BYTES"

    def test_download_fit_passthrough_when_not_zip(self, token_dir):
        client, api = self._client(token_dir)
        api.download_activity.return_value = b".FIT raw"
        assert client.download_fit(1) == b".FIT raw"

    def test_activities_uses_iso_dates(self, token_dir):
        client, api = self._client(token_dir)
        client.activities(date(2026, 1, 1), date(2026, 1, 31))
        api.get_activities_by_date.assert_called_once_with("2026-01-01", "2026-01-31")

    def test_history_reads_one_bounded_page(self, token_dir):
        client, api = self._client(token_dir)
        api.get_activities.return_value = [{"activityId": 12}]
        assert client.activity_page(19, 21) == [{"activityId": 12}]
        api.get_activities.assert_called_once_with(start=19, limit=21)
        api.get_activities_by_date.assert_not_called()

    @pytest.mark.parametrize("raw", [{"error": "failed"}, [None], [{}] * 22])
    def test_invalid_history_is_not_an_empty_archive(self, token_dir, raw):
        client, api = self._client(token_dir)
        api.get_activities.return_value = raw
        with pytest.raises(ValueError, match="Invalid Garmin"):
            client.activity_page(19, 21)

    def test_training_readiness_uses_the_morning_reading(self, token_dir):
        client, api = self._client(token_dir)
        api.get_morning_training_readiness.return_value = {"score": 70}
        assert client.training_readiness(date(2026, 10, 9)) == {"score": 70}
        api.get_morning_training_readiness.assert_called_once_with("2026-10-09")

    def test_race_predictions_ask_for_the_latest(self, token_dir):
        client, api = self._client(token_dir)
        client.race_predictions()
        api.get_race_predictions.assert_called_once_with()


class TestHealthMapping:
    """Raw Garmin JSON -> app.daily_metrics columns."""

    def test_gather_metrics_maps_every_signal(self):
        client = MagicMock()
        client.hrv.return_value = {
            "hrvSummary": {"lastNightAvg": 55, "weeklyAvg": 52, "status": "BALANCED"}
        }
        client.sleep.return_value = {
            "dailySleepDTO": {
                "id": 1,
                "sleepTimeSeconds": 27000,
                "deepSleepSeconds": 5000,
                "lightSleepSeconds": 15000,
                "remSleepSeconds": 6000,
                "awakeSleepSeconds": 1000,
                "sleepScores": {"overall": {"value": 81}},
            }
        }
        client.stress.return_value = {"avgStressLevel": 28, "maxStressLevel": 90}
        client.body_battery.return_value = [
            {
                "charged": 60,
                "drained": 45,
                "bodyBatteryValuesArray": [[1, 30], [2, 95], [3, 50]],
            }
        ]
        client.steps.return_value = [{"totalSteps": 8421}]
        client.resting_hr.return_value = {
            "allMetrics": {
                "metricsMap": {"WELLNESS_RESTING_HEART_RATE": [{"value": 48}]}
            }
        }

        m = health_sync._gather_metrics(client, date(2026, 6, 1))

        assert m["hrv_last_night"] == 55 and m["hrv_weekly_avg"] == 52
        assert m["hrv_status"] == "BALANCED"
        assert m["sleep_duration_sec"] == 27000 and m["sleep_score"] == 81
        assert m["stress_avg"] == 28 and m["stress_max"] == 90
        assert m["body_battery_charged"] == 60 and m["body_battery_drained"] == 45
        assert m["body_battery_high"] == 95 and m["body_battery_low"] == 30
        assert m["steps"] == 8421
        assert m["resting_hr"] == 48
        assert m["source"] == "garmin"

    def test_gather_metrics_tolerates_missing_and_failing_signals(self):
        client = MagicMock()
        client.hrv.return_value = None
        client.sleep.return_value = {"dailySleepDTO": {"id": None}}  # no sleep recorded
        client.stress.side_effect = RuntimeError("boom")
        client.body_battery.return_value = []
        client.steps.return_value = []
        client.resting_hr.return_value = {}

        m = health_sync._gather_metrics(client, date(2026, 6, 1))

        assert set(m) == {"date", "source"}

    def test_sync_day_without_tokens_fails_cleanly(self, tmp_path):
        result = health_sync.sync_day(date(2026, 6, 1), GarminClient(tmp_path / "none"))
        assert result.success is False
        assert "No Garmin tokens" in (result.error or "")


@pytest.mark.parametrize(
    "status,exception",
    [(401, PermissionError), (404, LookupError), (503, RuntimeError)],
)
def test_export_transport_never_refreshes_or_replays_writes(
    token_dir, status, exception
):
    token_dir.mkdir()
    (token_dir / TOKEN_FILE).write_text("{}")
    with patch("arete.garmin.client.Garmin") as factory:
        api = factory.return_value
        api.client._connectapi = "https://connectapi.garmin.com"
        api.client._api_session.request.return_value.status_code = status
        with pytest.raises(exception):
            GarminClient(token_dir).workout_request(
                "POST",
                "/workout-service/workout",
                timeout=7.0,
                payload={"workoutName": "test"},
            )
        api.login.assert_not_called()
        api.client.load.assert_called_once_with(str(token_dir))
        api.client._api_session.request.assert_called_once()
        assert (
            api.client._api_session.request.call_args.kwargs["allow_redirects"] is False
        )
        assert api.client._api_session.request.call_args.kwargs["timeout"] == 7.0
        api.client.request.assert_not_called()
