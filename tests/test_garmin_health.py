"""Tests for daily readiness score computation."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest

from arete.api.garmin_health import router
from arete.dataio.db import connect
from arete.garmin.health_sync import _upsert_daily_metrics
from arete.garmin.readiness import compute_readiness, fetch_window


@pytest.fixture
def client(router_client):
    return router_client(router)


def _seed_metrics(rows: list[tuple]) -> None:
    """Insert test rows into app.daily_metrics. Each row: (date, hrv, sleep, bb, stress, rhr)."""
    with patch("arete.garmin.readiness.connect") as mock_connect:
        mock_conn = mock_connect.return_value
        mock_conn.execute.return_value.fetchone.return_value = None
        # Just let the test skip baseline calculation by inserting no history
        compute_readiness(date(2026, 6, 1))


class TestReadinessFormula:
    def test_no_data_returns_none(self):
        with patch("arete.garmin.readiness.connect") as mock_connect:
            mock_conn = mock_connect.return_value
            mock_conn.execute.return_value.fetchone.return_value = None
            assert compute_readiness(date(2026, 6, 1)) is None

    def test_strong_recovery_high_score(self):
        """HRV above baseline, full sleep, BB 100 = high score."""
        with patch("arete.garmin.readiness.connect") as mock_connect:
            mock_conn = mock_connect.return_value
            # First call: fetch_day_metrics returns (hrv, sleep, bb, stress, rhr)
            # Second call: fetch_baseline returns rows for stats
            mock_conn.execute.return_value.fetchone.return_value = (
                80,
                8 * 3600,
                100,
                25,
                50,
            )
            mock_conn.execute.return_value.fetchall.return_value = [
                (60, 7 * 3600, 80, 30, 52) for _ in range(14)
            ]
            score = compute_readiness(date(2026, 6, 1))
            assert score is not None
            assert score >= 80  # strong recovery

    def test_poor_recovery_low_score(self):
        """HRV below baseline, short sleep, low BB = low score."""
        with patch("arete.garmin.readiness.connect") as mock_connect:
            mock_conn = mock_connect.return_value
            mock_conn.execute.return_value.fetchone.return_value = (
                30,
                4 * 3600,
                30,
                60,
                60,
            )
            mock_conn.execute.return_value.fetchall.return_value = [
                (60, 7 * 3600, 80, 30, 52) for _ in range(14)
            ]
            score = compute_readiness(date(2026, 6, 1))
            assert score is not None
            assert score < 40  # poor recovery

    def test_cold_start_with_data(self):
        """Less than 5 days of baseline history = fallback to 1.0 ratios."""
        with patch("arete.garmin.readiness.connect") as mock_connect:
            mock_conn = mock_connect.return_value
            mock_conn.execute.return_value.fetchone.return_value = (
                60,
                8 * 3600,
                80,
                30,
                50,
            )
            mock_conn.execute.return_value.fetchall.return_value = []  # no history
            score = compute_readiness(date(2026, 6, 1))
            # Fallback: hrv_ratio=1.0 (ratio 0.5 from 0.5 offset = 0.5 → 0.5 mapped)
            # sleep_ratio=1.0 (8h = target, 0.5/0.7 = 0.71)
            # bb=80 (0.8)
            # score = 0.4*0.5 + 0.3*0.71 + 0.3*0.8 = 0.2 + 0.21 + 0.24 = 0.65 → 65
            assert 50 <= score <= 80

    def test_penalty_for_high_stress(self):
        """Stress significantly above baseline = score penalty."""
        with patch("arete.garmin.readiness.connect") as mock_connect:
            mock_conn = mock_connect.return_value
            # Target: stress 70 (vs baseline mean 30, std 5 = +8 std) → -40 penalty
            mock_conn.execute.return_value.fetchone.return_value = (
                80,
                8 * 3600,
                100,
                70,
                50,
            )
            # Varied baseline: stress ~30 ± 5, so std > 0
            mock_conn.execute.return_value.fetchall.return_value = [
                (60, 7 * 3600, 80, 25 + (i % 5), 52) for i in range(14)
            ]
            score = compute_readiness(date(2026, 6, 1))
            # Base ~85, but penalty should bring it well under
            assert score < 50

    def test_score_clamped_0_100(self):
        """Score is always 0-100."""
        with patch("arete.garmin.readiness.connect") as mock_connect:
            mock_conn = mock_connect.return_value
            # Worst case: very low HRV, no sleep, BB 0
            mock_conn.execute.return_value.fetchone.return_value = (1, 0, 0, 100, 100)
            mock_conn.execute.return_value.fetchall.return_value = [
                (60, 7 * 3600, 80, 30, 52) for _ in range(14)
            ]
            score = compute_readiness(date(2026, 6, 1))
            assert 0 <= score <= 100

    def test_extreme_stress_penalty_clamped(self):
        """Even huge stress penalty shouldn't push below 0."""
        with patch("arete.garmin.readiness.connect") as mock_connect:
            mock_conn = mock_connect.return_value
            mock_conn.execute.return_value.fetchone.return_value = (
                60,
                8 * 3600,
                80,
                200,
                50,
            )
            mock_conn.execute.return_value.fetchall.return_value = [
                (60, 7 * 3600, 80, 30, 5)
                for _ in range(14)  # std = 0
            ]
            score = compute_readiness(date(2026, 6, 1))
            assert score >= 0


class TestReadinessWindow:
    def test_one_window_read_scores_today_and_yesterday_like_two_reads(self):
        end = date(2031, 3, 16)
        for i in range(16):
            _upsert_daily_metrics(
                {
                    "date": end - timedelta(days=i),
                    "hrv_last_night": 50 + i,
                    "sleep_duration_sec": 6 * 3600 + i * 600,
                    "body_battery_high": 60 + i,
                    "stress_avg": 20 + (i * 7) % 15,
                    "resting_hr": 45 + i % 4,
                }
            )
        con = connect()
        try:
            window = fetch_window(con, end)
            for day in (end, end - timedelta(days=1)):
                score = compute_readiness(day)
                assert score is not None
                assert compute_readiness(day, window=window) == score
        finally:
            con.execute(
                "DELETE FROM app.daily_metrics WHERE date >= ?", [date(2031, 1, 1)]
            )
            con.close()


class TestHealthStatusFromLocalState:
    """Settings asks on every load: answered without Garmin."""

    @pytest.fixture
    def tokens(self, tmp_path, monkeypatch):
        directory = tmp_path / "garmin_tokens"
        monkeypatch.setenv("ARETE_GARMIN_TOKENS_DIR", str(directory))
        return directory

    @patch("arete.api.garmin_health.connect")
    def test_stored_tokens_answer_without_a_garmin_login(
        self, mock_connect, client, tokens
    ):
        from arete.garmin.token_store import save_account

        mock_connect.return_value.execute.return_value.fetchone.return_value = (
            5,
            date(2026, 5, 28),
            date(2026, 6, 1),
            None,
        )
        tokens.mkdir()
        (tokens / "garmin_tokens.json").write_text("{}")
        save_account(tokens / "garmin_tokens.json", "me@garmin.test", remote=False)
        with patch("arete.garmin.client.Garmin") as garmin:
            resp = client.get("/garmin/health/status")
        garmin.assert_not_called()
        garmin.return_value.login.assert_not_called()
        assert resp.status_code == 200
        assert resp.json() == {
            "tokens_present": True,
            "tokens_dir": str(tokens),
            "days_stored": 5,
            "first_date": "2026-05-28",
            "last_date": "2026-06-01",
            "last_sync": None,
        }

    def test_tokens_garmin_refused_are_not_present(self, client, tokens):
        from arete.garmin.token_store import refused, save_account

        tokens.mkdir()
        token = tokens / "garmin_tokens.json"
        token.write_text("{}")
        save_account(token, "me@garmin.test", remote=False)
        refused(token, remote=False)
        assert client.get("/garmin/health/status").json()["tokens_present"] is False

    def test_no_tokens_are_not_present(self, client, tokens):
        body = client.get("/garmin/health/status").json()
        assert body["tokens_present"] is False
        assert body["tokens_dir"] == str(tokens)


def test_health_status_leaves_garminconnect_out(tmp_path):
    """A cold instance: the health status must not import Garmin's client."""
    import json
    import os
    import subprocess
    import sys

    tokens = tmp_path / "garmin_tokens"
    tokens.mkdir()
    (tokens / "garmin_tokens.json").write_text("{}")
    code = """
import json, sys
from fastapi.testclient import TestClient
from arete.dataio.init_duckdb import main as init_schema
init_schema()
from arete.api.main import app
body = TestClient(app).get("/garmin/health/status").json()
print(json.dumps({"body": body, "garmin": "garminconnect" in sys.modules}))
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
    assert result["body"]["tokens_present"] is True
    assert result["garmin"] is False


class TestGarminHealthApi:
    @patch("arete.api.garmin_health.connect")
    def test_daily_endpoint_404_when_no_data(self, mock_connect, client):
        mock_conn = mock_connect.return_value
        mock_conn.execute.return_value.fetchone.return_value = None
        resp = client.get("/garmin/health/daily?date=2026-06-01")
        assert resp.status_code == 404

    @patch("arete.api.garmin_health.connect")
    def test_daily_endpoint_returns_metrics(self, mock_connect, client):
        mock_conn = mock_connect.return_value
        mock_conn.execute.return_value.fetchone.return_value = (
            "2026-06-01",
            60,
            70,
            "BALANCED",
            28800,
            85,
            7200,
            14400,
            5400,
            1800,
            80,
            30,
            95,
            40,
            48,
            25,
            60,
            8500,
            45,
            82,
            "garmin",
            "2026-06-01 10:00:00",
            68,
            "MODERATE",
            "RECOVERED",
            "PRODUCTIVE_1",
            55.4,
            1188,
            2470,
            5460,
            11520,
            6800,
            72,
        )
        resp = client.get("/garmin/health/daily?date=2026-06-01")
        assert resp.status_code == 200
        data = resp.json()
        assert data["hrv_last_night"] == 70
        assert data["sleep_duration_sec"] == 28800
        assert data["body_battery_high"] == 95
        assert data["readiness_score"] == 82
        assert data["training_readiness_score"] == 68
        assert data["race_10k_sec"] == 2470
        assert data["hill_score"] == 72

    @patch("arete.dataio.db.connect")
    def test_range_endpoint(self, mock_connect, client):
        mock_conn = mock_connect.return_value
        mock_conn.execute.return_value.fetchall.return_value = [
            ("2026-05-30", 60, 65, 80, 28800, 90, 40, 25, 50, 78, 8000),
            ("2026-05-31", 65, 67, 85, 30000, 95, 45, 22, 48, 85, 9500),
        ]
        resp = client.get("/garmin/health/range?start=2026-05-30&end=2026-05-31")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["days"]) == 2
        assert data["days"][0]["readiness_score"] == 78


class TestDailyMetricsTable:
    """app.daily_metrics must exist in the schema and support upsert (real temp DB)."""

    def test_upsert_then_read_via_api(self, client):
        _upsert_daily_metrics(
            {"date": date(2026, 6, 15), "hrv_last_night": 55, "sleep_score": 80}
        )
        # second write on the same day must update, not fail on PK conflict
        _upsert_daily_metrics(
            {"date": date(2026, 6, 15), "hrv_last_night": 60, "sleep_score": 82}
        )

        resp = client.get("/garmin/health/daily?date=2026-06-15")
        assert resp.status_code == 200
        body = resp.json()
        assert body["hrv_last_night"] == 60
        assert body["sleep_score"] == 82


class TestGarminTrainingMetrics:
    """Garmin's own readiness and fitness metrics, as the API is expected to ship them."""

    def _client(self):
        from unittest.mock import MagicMock

        client = MagicMock()
        client.hrv.return_value = {}
        client.sleep.return_value = {}
        client.stress.return_value = {}
        client.body_battery.return_value = []
        client.steps.return_value = []
        client.resting_hr.return_value = {}
        client.training_readiness.return_value = {
            "score": 68,
            "level": "MODERATE",
            "feedbackShort": "RECOVERED",
        }
        client.training_status.return_value = {
            "mostRecentTrainingStatus": {
                "latestTrainingStatusData": {
                    "3442978530": {
                        "trainingStatus": 7,
                        "trainingStatusFeedbackPhrase": "PRODUCTIVE_1",
                    }
                }
            }
        }
        client.max_metrics.return_value = [
            {"generic": {"vo2MaxPreciseValue": 55.4, "vo2MaxValue": 55}}
        ]
        client.race_predictions.return_value = {
            "time5K": 1188,
            "time10K": 2470,
            "timeHalfMarathon": 5460,
            "timeMarathon": 11520,
        }
        client.endurance_score.return_value = {"overallScore": 6800}
        client.hill_score.return_value = {"overallScore": 72}
        return client

    def test_gather_metrics_maps_training_readiness_and_predictions(self):
        from datetime import date

        from arete.garmin.health_sync import _gather_metrics

        metrics = _gather_metrics(self._client(), date(2026, 10, 9))
        assert metrics["training_readiness_score"] == 68
        assert metrics["training_readiness_level"] == "MODERATE"
        assert metrics["training_status"] == "PRODUCTIVE_1"
        assert metrics["vo2max_run"] == 55.4
        assert (metrics["race_5k_sec"], metrics["race_marathon_sec"]) == (1188, 11520)
        assert (metrics["endurance_score"], metrics["hill_score"]) == (6800, 72)

    def test_range_sync_fetches_performance_only_for_the_last_day(self):
        from datetime import date
        from unittest.mock import patch

        from arete.garmin import health_sync

        client = self._client()
        with (
            patch.object(health_sync, "GarminClient", return_value=client),
            patch.object(health_sync, "_upsert_daily_metrics"),
        ):
            health_sync.sync_range(date(2026, 10, 6), date(2026, 10, 9))
        assert client.training_readiness.call_count == 4
        assert client.race_predictions.call_count == 1

    def test_a_failing_performance_endpoint_keeps_the_other_fields(self):
        from datetime import date

        from arete.garmin.health_sync import _gather_metrics

        client = self._client()
        client.race_predictions.side_effect = RuntimeError("404")
        metrics = _gather_metrics(client, date(2026, 10, 9))
        assert "race_10k_sec" not in metrics
        assert metrics["hill_score"] == 72 and metrics["training_readiness_score"] == 68


def test_race_predictions_also_read_the_list_form():
    from datetime import date
    from unittest.mock import MagicMock

    from arete.garmin.health_sync import _fetch_performance

    client = MagicMock()
    client.race_predictions.return_value = [
        {
            "time5K": 1200,
            "time10K": 2500,
            "timeHalfMarathon": 5500,
            "timeMarathon": 11600,
        }
    ]
    assert _fetch_performance(client, date(2026, 10, 9))["race_10k_sec"] == 2500
