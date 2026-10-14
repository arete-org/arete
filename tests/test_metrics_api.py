"""Tests for the metrics API endpoints."""

from datetime import date, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

from arete.api.main import app

client = TestClient(app)


class TestTRIMPEndpoint:
    """Tests for POST /metrics/cardio/trimp."""

    def test_trimp_male(self) -> None:
        """Calculate TRIMP for male athlete."""
        response = client.post(
            "/metrics/cardio/trimp",
            json={
                "duration_min": 60,
                "avg_hr": 150,
                "hr_rest": 60,
                "hr_max": 190,
                "gender": "male",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert "trimp" in data
        assert data["trimp"] > 0
        assert data["hr_zone"] in [1, 2, 3, 4, 5]
        assert "zone_name" in data

    def test_trimp_female(self) -> None:
        """Calculate TRIMP for female athlete."""
        response = client.post(
            "/metrics/cardio/trimp",
            json={
                "duration_min": 45,
                "avg_hr": 155,
                "hr_rest": 55,
                "hr_max": 185,
                "gender": "female",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["trimp"] > 0
        # Female weighting is different
        assert "intensity" in data

    def test_trimp_validation_errors(self) -> None:
        """Validation should reject invalid inputs."""
        # Missing required field
        response = client.post(
            "/metrics/cardio/trimp",
            json={
                "duration_min": 60,
                "avg_hr": 150,
                "hr_rest": 60,
                # missing hr_max and gender
            },
        )
        assert response.status_code == 422

        # Invalid duration
        response = client.post(
            "/metrics/cardio/trimp",
            json={
                "duration_min": 0,  # must be > 0
                "avg_hr": 150,
                "hr_rest": 60,
                "hr_max": 190,
                "gender": "male",
            },
        )
        assert response.status_code == 422


class TestOneRMEndpoint:
    """Tests for POST /metrics/strength/1rm."""

    def test_1rm_basic(self) -> None:
        """Basic 1RM estimation without RPE."""
        response = client.post(
            "/metrics/strength/1rm",
            json={
                "weight": 100,
                "reps": 5,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["estimated_1rm"] > 100  # Should be higher than 5RM
        assert data["epley"] > 0
        assert data["brzycki"] > 0
        assert data["rpe_based"] is None
        assert "strength_zone" in data
        assert data["intensity_pct"] > 0

    def test_1rm_with_rpe(self) -> None:
        """1RM estimation with RPE for more accuracy."""
        response = client.post(
            "/metrics/strength/1rm",
            json={
                "weight": 100,
                "reps": 5,
                "rpe": 8.5,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["rpe_based"] is not None
        assert data["rpe_based"] > 0

    def test_1rm_single_rep(self) -> None:
        """1RM for a single rep should return the weight."""
        response = client.post(
            "/metrics/strength/1rm",
            json={
                "weight": 150,
                "reps": 1,
            },
        )
        assert response.status_code == 200
        data = response.json()
        # With 1 rep, estimated 1RM should be close to actual weight
        assert abs(data["estimated_1rm"] - 150) < 5

    def test_1rm_validation(self) -> None:
        """Validation errors for invalid inputs."""
        # Too many reps
        response = client.post(
            "/metrics/strength/1rm",
            json={
                "weight": 100,
                "reps": 35,  # max is 30
            },
        )
        assert response.status_code == 422

        # Invalid RPE
        response = client.post(
            "/metrics/strength/1rm",
            json={
                "weight": 100,
                "reps": 5,
                "rpe": 11,  # max is 10
            },
        )
        assert response.status_code == 422


class TestINOLEndpoint:
    """Tests for POST /metrics/strength/inol."""

    def test_inol_light(self) -> None:
        """Light INOL (recovery)."""
        response = client.post(
            "/metrics/strength/inol",
            json={
                "reps": 10,
                "intensity_pct": 60,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["inol"] < 0.5
        assert "récupération" in data["classification"].lower()

    def test_inol_moderate(self) -> None:
        """Moderate INOL (development)."""
        response = client.post(
            "/metrics/strength/inol",
            json={
                "reps": 20,
                "intensity_pct": 70,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert 0.5 <= data["inol"] < 1.0
        assert "modéré" in data["classification"].lower()

    def test_inol_high(self) -> None:
        """High INOL (overload)."""
        response = client.post(
            "/metrics/strength/inol",
            json={
                "reps": 30,
                "intensity_pct": 80,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["inol"] >= 1.0


class TestWorkloadEndpoint:
    """Tests for GET /metrics/workload."""

    def test_workload_no_data(self) -> None:
        """Should return 404 when no training data exists."""
        # This depends on database state
        response = client.get("/metrics/workload")
        # Either returns data or 404
        assert response.status_code in [200, 404]

    def test_workload_query_params(self) -> None:
        """Query params should be validated."""
        # Invalid days (too low)
        response = client.get("/metrics/workload?days=3")
        assert response.status_code == 422

        # Invalid days (too high)
        response = client.get("/metrics/workload?days=200")
        assert response.status_code == 422


class TestFitnessEndpoint:
    """Tests for GET /metrics/fitness."""

    def test_fitness_no_data(self) -> None:
        """Should return 404 when no training data exists."""
        response = client.get("/metrics/fitness")
        assert response.status_code in [200, 404]

    def test_fitness_query_params(self) -> None:
        """Query params should be validated."""
        # Invalid days (too low)
        response = client.get("/metrics/fitness?days=5")
        assert response.status_code == 422

    def test_every_surface_reads_one_form(self) -> None:
        """/metrics/fitness, the dashboard bar and the Analytics chart agree."""
        from arete.dataio.db import connect

        con = connect()
        con.execute(
            "INSERT INTO app.actual_sessions (user_id, date, sport, duration_sec, rpe, source)"
            " SELECT 1, CURRENT_DATE - CAST(i AS INTEGER), 'running', 3600, 6, 'test-one'"
            " FROM range(1, 150) t(i) WHERE i % 3 <> 0"
        )
        con.close()
        try:
            fitness = client.get("/metrics/fitness").json()
            stats = client.get("/metrics/player-stats").json()
            pmc = client.get("/analytics/overview?period=7d").json()["cards"]["pmc"]
        finally:
            con = connect()
            con.execute("DELETE FROM app.actual_sessions WHERE source = 'test-one'")
            con.close()
        assert fitness["readiness_source"] in ("garmin", "model")
        assert fitness["ctl"] == pmc["headline"]["value"]
        assert fitness["tsb"] == pmc["secondary"][0]["value"]
        tsb = fitness["tsb"] + 0.0
        assert stats["mp"]["detail"] == (
            f"TSB {tsb:+.1f}".replace(".", ",") if tsb else "TSB 0,0"
        )


class TestRecommendationsEndpoint:
    """Tests for GET /metrics/recommendations."""

    def test_recommendations_no_data(self) -> None:
        """Should return 404 when no training data exists."""
        response = client.get("/metrics/recommendations")
        assert response.status_code in [200, 404]

    def test_recommendations_sport_types(self) -> None:
        """Should accept different sport types."""
        for sport in ["cardio", "strength", "mixed"]:
            response = client.get(f"/metrics/recommendations?sport_type={sport}")
            assert response.status_code in [200, 404]

    def test_recommendations_invalid_sport(self) -> None:
        """Should reject invalid sport types."""
        response = client.get("/metrics/recommendations?sport_type=invalid")
        assert response.status_code == 422


class TestOpenAPISchema:
    """Tests for API documentation."""

    def test_openapi_schema(self) -> None:
        """OpenAPI schema should include metrics endpoints."""
        response = client.get("/openapi.json")
        assert response.status_code == 200
        schema = response.json()

        # Check metrics endpoints are documented
        paths = schema.get("paths", {})
        assert "/metrics/workload" in paths
        assert "/metrics/fitness" in paths
        assert "/metrics/cardio/trimp" in paths
        assert "/metrics/strength/1rm" in paths
        assert "/metrics/strength/inol" in paths
        assert "/metrics/recommendations" in paths
        assert "/metrics/player-stats" in paths


class TestPlayerStatsEndpoint:
    """Tests for GET /metrics/player-stats."""

    def test_player_stats_returns_200(self) -> None:
        """Endpoint should always return 200 with valid structure."""
        response = client.get("/metrics/player-stats")
        assert response.status_code == 200
        data = response.json()
        assert "hp" in data
        assert "mp" in data
        assert "xp" in data
        assert "level" in data

    def test_player_stats_structure(self) -> None:
        """Each stat bar should have current, max, label."""
        response = client.get("/metrics/player-stats")
        assert response.status_code == 200
        data = response.json()

        for key in ("hp", "mp", "xp"):
            bar = data[key]
            assert "current" in bar
            assert "max" in bar
            assert "label" in bar
            assert isinstance(bar["current"], (int, float))
            assert isinstance(bar["max"], (int, float))
            assert bar["max"] > 0

    def test_player_stats_bounds(self) -> None:
        """HP and MP should be 0-100, XP >= 0, level >= 0."""
        response = client.get("/metrics/player-stats")
        assert response.status_code == 200
        data = response.json()

        assert 0 <= data["hp"]["current"] <= 100
        assert data["hp"]["max"] == 100
        assert 0 <= data["mp"]["current"] <= 100
        assert data["mp"]["max"] == 100
        assert data["xp"]["current"] >= 0
        assert data["xp"]["max"] > 0
        assert data["level"] >= 0


class TestPlayerStatsSemantics:
    """The bars must reflect settings and real recovery, not hard-coded targets."""

    def test_weekly_goal_comes_from_settings(self):
        from arete.services.metrics import TSS_PER_SESSION, _weekly_goal_tss

        assert _weekly_goal_tss({"weekly_training_goal": 6}) == 6 * TSS_PER_SESSION
        assert _weekly_goal_tss({}) == 6 * TSS_PER_SESSION  # default
        assert (
            _weekly_goal_tss({"weekly_training_goal": 0}) == 6 * TSS_PER_SESSION
        )  # never zero

    def test_hp_uses_garmin_readiness_when_available(self, client):
        with patch("arete.services.metrics.compute_readiness", return_value=73):
            body = client.get("/metrics/player-stats").json()
        assert body["hp"]["current"] == 73.0
        assert body["hp"]["source"] == "garmin"
        assert body["hp"]["label"] == "Récupération"

    def test_hp_uses_yesterday_before_the_model(self, client):
        # Garmin publishes the night's HRV at wake-up: early in the day only
        # yesterday is complete.
        with patch(
            "arete.services.metrics.compute_readiness", side_effect=[None, 47]
        ) as readiness:
            body = client.get("/metrics/player-stats").json()
        assert body["hp"]["current"] == 47.0
        assert body["hp"]["source"] == "garmin_previous"
        assert "Garmin" in body["hp"]["detail"]
        asked = [call.args[0] for call in readiness.call_args_list]
        assert asked[1] == asked[0] - timedelta(days=1)

    def test_hp_falls_back_to_the_model_without_any_measurement(self, client):
        with patch("arete.services.metrics.compute_readiness", return_value=None):
            body = client.get("/metrics/player-stats").json()
        assert body["hp"]["source"] == "model"
        assert "charge" in body["hp"]["detail"]

    def test_hp_looks_back_one_day_only(self, client):
        with patch(
            "arete.services.metrics.compute_readiness", return_value=None
        ) as readiness:
            client.get("/metrics/player-stats").json()
        assert readiness.call_count == 2

    def test_mp_maps_tsb_and_reports_it(self, client):
        with patch("arete.services.metrics.compute_readiness", return_value=None):
            body = client.get("/metrics/player-stats").json()
        assert 0 <= body["mp"]["current"] <= 100
        assert body["mp"]["detail"].startswith("TSB ")

    def test_level_is_a_streak_of_finished_weeks(self):
        from arete.services import metrics

        today = date.today()
        monday = today - timedelta(days=today.weekday())
        # oldest -> newest finished weeks: ok, missed, ok, ok
        by_date = {
            monday - timedelta(days=28): 400.0,
            monday - timedelta(days=21): 100.0,
            monday - timedelta(days=14): 400.0,
            monday - timedelta(days=7): 400.0,
            today: 999.0,  # the current week never counts
        }
        weeks = metrics._week_history(300.0, by_date, today)
        assert weeks.streak == 2  # only the two most recent count
        assert weeks.total == 3

    def test_a_week_without_sessions_breaks_the_streak(self):
        from arete.services import metrics

        today = date.today()
        monday = today - timedelta(days=today.weekday())
        by_date = {monday - timedelta(days=14): 400.0}  # then an empty week
        assert metrics._week_history(300.0, by_date, today) == (0, 1, 1, 2)

    def test_a_missed_week_lowers_the_regularity_by_one(self):
        from arete.services import metrics

        today = date.today()
        monday = today - timedelta(days=today.weekday())
        # oldest -> newest finished weeks: ok, ok, missed, ok
        by_date = {
            monday - timedelta(days=28): 400.0,
            monday - timedelta(days=21): 400.0,
            monday - timedelta(days=14): 100.0,
            monday - timedelta(days=7): 400.0,
        }
        weeks = metrics._week_history(300.0, by_date, today)
        assert (weeks.recent, weeks.window) == (3, 4)  # "3 des 4 dernières"
        assert weeks.streak == 1

    def test_regularity_counts_the_last_twelve_finished_weeks(self):
        from arete.services import metrics

        today = date.today()
        monday = today - timedelta(days=today.weekday())
        # 20 finished weeks: the 8 oldest at goal, then 3 of the last 12.
        hits = {13, 9, 2}  # weeks ago
        by_date = {
            monday - timedelta(days=7 * ago): 400.0 if ago > 12 or ago in hits else 50.0
            for ago in range(1, 21)
        }
        weeks = metrics._week_history(300.0, by_date, today)
        assert (weeks.recent, weeks.window) == (2, 12)  # week 13 is outside
        assert weeks.total == 10

    def test_a_first_week_joined_midway_is_not_a_miss(self):
        from arete.services import metrics

        today = date.today()
        monday = today - timedelta(days=today.weekday())
        # Joined on the Saturday of a week, short of the goal, then one full week.
        saturday = monday - timedelta(days=9)
        by_date = {saturday: 100.0, monday - timedelta(days=7): 400.0}
        weeks = metrics._week_history(300.0, by_date, today)
        assert (weeks.recent, weeks.window) == (1, 1)
        assert (weeks.streak, weeks.total) == (1, 1)  # level/weeks_at_goal unchanged
        # Joined last Saturday: no finished full week yet, nothing to show.
        last_saturday = monday - timedelta(days=2)
        assert metrics._week_history(300.0, {last_saturday: 100.0}, today).window == 0
        # A first partial week that reached the goal still counts.
        by_date[saturday] = 400.0
        assert metrics._week_history(300.0, by_date, today)[2:] == (2, 2)
        # A first week starting on Monday is a full week: its miss counts.
        assert metrics._week_history(
            300.0,
            {monday - timedelta(days=14): 100.0, monday - timedelta(days=7): 400.0},
            today,
        )[2:] == (1, 2)

    def test_player_stats_reports_the_regularity_and_keeps_older_fields(self):
        from arete.services import metrics

        today = date.today()
        monday = today - timedelta(days=today.weekday())
        # 14 finished weeks: the last 12 have 9 at goal, the streak is 2.
        missed = {3, 6, 10}  # weeks ago
        by_date = {
            monday - timedelta(days=7 * ago): 50.0 if ago in missed else 400.0
            for ago in range(1, 15)
        }
        stats = metrics.player_stats(
            {"weekly_training_goal": 6}, today, metrics.Form(by_date, None, None)
        )
        assert (stats.recent_weeks_at_goal, stats.recent_weeks) == (9, 12)
        assert (stats.level, stats.weeks_at_goal) == (2, 11)
        assert stats.xp.detail == "Objectif 300 TSS · 6 séances"

    def test_a_form_near_zero_reads_as_the_dashboard_card_shows_it(self):
        from types import SimpleNamespace

        from arete.services import metrics

        for tsb, shown in (
            (-0.04, "TSB 0,0"),
            (0.0, "TSB 0,0"),
            (4.23, "TSB +4,2"),
            (-4.25, "TSB -4,2"),
        ):
            form = metrics.Form({}, SimpleNamespace(tsb=tsb), None)  # type: ignore[arg-type]
            assert metrics.player_stats({}, date.today(), form).mp.detail == shown

    def test_player_stats_reads_the_database_in_four_statements(
        self, monkeypatch, statement_log
    ):
        from arete.dataio import db, settings
        from arete.features import banister
        from arete.garmin import readiness
        from arete.services import metrics

        def counting_connect(*args, **kwargs):
            return statement_log.wrap(db.connect(*args, **kwargs))

        # One loaded day, so the model runs and reads the Banister coefficients.
        con = db.connect()
        con.execute(
            "INSERT INTO app.actual_sessions (user_id, date, sport, duration_sec, rpe, source)"
            " VALUES (1, CURRENT_DATE - 3, 'running', 3600, 6, 'test-count')"
        )
        con.close()
        try:
            for module in (metrics, settings, banister, readiness):
                monkeypatch.setattr(module, "connect", counting_connect)
            metrics.get_player_stats()
        finally:
            con = db.connect()
            con.execute("DELETE FROM app.actual_sessions WHERE source = 'test-count'")
            con.close()
        assert len(statement_log) == 4
