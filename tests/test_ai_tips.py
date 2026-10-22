"""Tests for /tips endpoints (post-session feedback)."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from arete.api.ai_tips import router


@pytest.fixture
def client(router_client):
    return router_client(router)


# ─── Strength tests ──────────────────────────────────────────────────


def _make_strength_session(exercises=None, overall_rpe=7):
    """Build a minimal mock StrengthSession."""
    session = MagicMock()
    session.date = date(2025, 5, 10)
    session.overall_rpe = overall_rpe
    session.exercises = exercises or []
    return session


def _make_exercise(muscle_value: str, sets_data: list[tuple[int, float]]):
    """Create a mock SessionExercise with sets.

    sets_data: list of (reps, weight_kg) tuples.
    """
    ex = MagicMock()
    ex.exercise = MagicMock()
    ex.exercise.primary_muscle = MagicMock()
    ex.exercise.primary_muscle.value = muscle_value

    sets = []
    for reps, weight in sets_data:
        s = MagicMock()
        s.is_warmup = False
        s.reps = reps
        s.weight_kg = weight
        sets.append(s)
    ex.sets = sets
    return ex


@pytest.fixture
def rules_only():
    """Keep the agent out of tests about the rule-based facts.

    The feedback path runs the coaching agent now; these tests are about the
    numbers underneath it, so they assert on the floor.
    """
    with patch(
        "arete.coaching.enrich_session_feedback",
        side_effect=lambda text, highlights, evidence=None: (text, "rules"),
    ):
        yield


class TestPostSessionStrength:
    """POST /tips/post-session with session_type=strength."""

    @pytest.fixture(autouse=True)
    def _floor(self, rules_only):
        pass

    @patch("arete.services.coaching_rules.StrengthRepository")
    def test_strength_feedback_with_volume(self, mock_repo_cls, client):
        repo = mock_repo_cls.return_value
        exercises = [
            _make_exercise("chest", [(10, 80), (10, 80), (8, 85)]),
        ]
        repo.get_session.return_value = _make_strength_session(exercises)
        repo.get_volume_by_muscle.return_value = {"chest": 6000.0}

        resp = client.post(
            "/tips/post-session",
            json={"session_type": "strength", "session_id": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "feedback" in data
        assert "pectoraux" in data["feedback"].lower() or any(
            "pectoraux" in h.lower() for h in data["highlights"]
        )
        assert len(data["highlights"]) >= 1

    @patch("arete.services.coaching_rules.StrengthRepository")
    def test_strength_not_found(self, mock_repo_cls, client):
        repo = mock_repo_cls.return_value
        repo.get_session.return_value = None

        resp = client.post(
            "/tips/post-session",
            json={"session_type": "strength", "session_id": 999},
        )
        assert resp.status_code == 404


# ─── Cardio tests ────────────────────────────────────────────────────


def _make_actual_session(
    avg_hr=145,
    max_hr=172,
    avg_pace_sec_km=330,
    distance_m=10000,
    calories=650,
    sport="running",
    duration_sec=3600,
    start_time=None,
    name="Footing",
):
    session = MagicMock()
    session.sport = sport
    session.start_time = start_time
    session.name = name
    session.duration_sec = duration_sec
    session.avg_hr = avg_hr
    session.max_hr = max_hr
    session.avg_pace_sec_km = avg_pace_sec_km
    session.distance_m = distance_m
    session.calories = calories
    return session


class TestPostSessionCardio:
    @pytest.fixture(autouse=True)
    def _floor(self, rules_only):
        pass

    """POST /tips/post-session with session_type=cardio."""

    @patch("arete.services.coaching_rules.GarminRepository")
    def test_cardio_feedback_with_hr_and_pace(self, mock_repo_cls, client):
        repo = mock_repo_cls.return_value
        repo.get_actual_session.return_value = _make_actual_session()

        resp = client.post(
            "/tips/post-session",
            json={"session_type": "cardio", "session_id": 42},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "séance de course terminée" in data["feedback"].lower()
        assert any("bpm" in h for h in data["highlights"])
        assert any("/km" in h for h in data["highlights"])

    @patch("arete.services.coaching_rules.GarminRepository")
    def test_two_same_named_runs_of_a_day_get_two_journal_titles(self, mock_repo_cls):
        from datetime import datetime

        from arete.services.coaching_rules import _generate_cardio_feedback

        repo = mock_repo_cls.return_value
        titles = []
        for hour in (7, 18, 18):
            repo.get_actual_session.return_value = _make_actual_session(
                start_time=datetime(2026, 10, 1, hour, 5)
            )
            titles.append(_generate_cardio_feedback(42)[1].title)
        assert titles[0] != titles[1]  # morning and evening: two entries
        assert titles[1] == titles[2]  # the same run twice: one entry
        assert titles[0] == "running — Footing (07:05)"

    @patch("arete.services.coaching_rules.GarminRepository")
    def test_the_rule_feedback_says_tu(self, mock_repo_cls, client):
        repo = mock_repo_cls.return_value
        for session in (
            _make_actual_session(
                avg_hr=None,
                max_hr=None,
                avg_pace_sec_km=None,
                distance_m=None,
                calories=None,
            ),
            _make_actual_session(avg_hr=175, max_hr=190),
        ):
            repo.get_actual_session.return_value = session
            data = client.post(
                "/tips/post-session", json={"session_type": "cardio", "session_id": 1}
            ).json()
            text = " ".join([data["feedback"], *data["highlights"]])
            assert "vous" not in text.lower() and "continuez" not in text.lower()

    @patch("arete.services.coaching_rules.GarminRepository")
    def test_cardio_not_found(self, mock_repo_cls, client):
        repo = mock_repo_cls.return_value
        repo.get_actual_session.return_value = None

        resp = client.post(
            "/tips/post-session",
            json={"session_type": "cardio", "session_id": 999},
        )
        assert resp.status_code == 404

    @patch("arete.services.coaching_rules.GarminRepository")
    def test_cardio_no_hr_data(self, mock_repo_cls, client):
        repo = mock_repo_cls.return_value
        repo.get_actual_session.return_value = _make_actual_session(
            avg_hr=None,
            max_hr=None,
            avg_pace_sec_km=None,
            distance_m=None,
            calories=None,
        )

        resp = client.post(
            "/tips/post-session",
            json={"session_type": "cardio", "session_id": 10},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "Séance complétée" in data["highlights"][0]


class TestTipUsesSettings:
    """The threshold and the goal come from the athlete's settings, not constants."""

    def test_readiness_is_read_against_the_athletes_threshold(self):
        from arete.services.coaching_rules import generate_daily_tip

        tip, priority = generate_daily_tip(1.0, 0.0, 82.0, fatigue_threshold=75)
        assert "82/100" in tip and "75" in tip
        assert priority == "info"

    def test_the_tip_names_where_the_readiness_comes_from(self):
        from arete.services.coaching_rules import generate_daily_tip

        garmin, _ = generate_daily_tip(
            1.0, 0.0, 88.0, fatigue_threshold=85, readiness_source="garmin"
        )
        estimated, _ = generate_daily_tip(1.0, 0.0, 88.0, fatigue_threshold=85)
        assert "Préparation Garmin à 88/100" in garmin
        assert "Préparation estimée à 88/100" in estimated

    def test_rule_facts_carry_the_garmin_readiness(self):
        from unittest.mock import patch

        from arete.services.coaching_rules import rule_facts
        from arete.services.metrics import Readiness

        day = date(2031, 3, 4)
        readiness = Readiness(score=77.0, source="garmin", measured_on=day)
        with patch("arete.services.metrics.load_form", return_value=(None, readiness)):
            facts = rule_facts(day)
        assert (facts.readiness_score, facts.readiness_source) == (77.0, "garmin")
        assert facts.readiness_measured_on == day

    def test_readiness_below_threshold_falls_through(self):
        from arete.services.coaching_rules import generate_daily_tip

        tip, _ = generate_daily_tip(1.0, 0.0, 82.0, fatigue_threshold=90)
        assert "ACWR 1,00" in tip  # a decimal comma, as the French tip reads

    def test_goal_closes_the_balanced_load_tip(self):
        from arete.services.coaching_rules import GOAL_ADVICE, generate_daily_tip

        for goal, advice in GOAL_ADVICE.items():
            tip, _ = generate_daily_tip(1.0, 0.0, None, fitness_goal=goal)
            assert advice in tip

    def test_unknown_goal_falls_back_to_build(self):
        from arete.services.coaching_rules import GOAL_ADVICE, generate_daily_tip

        tip, _ = generate_daily_tip(1.0, 0.0, None, fitness_goal="whatever")
        assert GOAL_ADVICE["build"] in tip

    def test_the_rule_floor_passes_settings_through(self):
        from unittest.mock import patch

        from arete.services.coaching_rules import daily_rule_tip, rule_facts

        with patch(
            "arete.services.coaching_rules.get_user_settings",
            return_value={"fatigue_threshold": 60, "fitness_goal": "recovery"},
        ):
            tip, _ = daily_rule_tip(rule_facts())
        assert isinstance(tip, str) and tip


class TestDailyEndpoint:
    """GET /tips/daily reads the day's briefing; POST produces it once."""

    def test_serves_the_stored_briefing_without_producing_another(self, client):
        from unittest.mock import patch

        from arete.services.coaching_repository import BriefingRepository
        from arete.services.settings import athlete_today

        repo = BriefingRepository()
        repo.delete_for_day(athlete_today())
        repo.create(
            text="Ta charge monte vite.",
            priority="warning",
            source="agent",
            briefing_date=athlete_today(),
        )
        try:
            with patch("arete.services.briefing.generate_briefing") as produce:
                body = client.get("/tips/daily").json()
                assert client.post("/tips/daily").json() == body
            produce.assert_not_called()
        finally:
            repo.delete_for_day(athlete_today())

        assert body["status"] == "ready"
        assert body["tip"] == "Ta charge monte vite."
        assert body["priority"] == "warning"
        assert body["source"] == "agent"
        assert body["generated_at"]

    def test_reading_a_day_without_briefing_answers_pending(self, client):
        from unittest.mock import patch

        from arete.services.coaching_repository import BriefingRepository
        from arete.services.settings import athlete_today

        BriefingRepository().delete_for_day(athlete_today())
        with patch("arete.services.briefing.get_or_create_briefing") as produce:
            body = client.get("/tips/daily").json()
        produce.assert_not_called()
        assert body["status"] == "pending"
        assert body["tip"] is None

    def test_produces_one_when_the_day_has_none(self, client):
        from unittest.mock import patch

        from arete.services.coaching_repository import BriefingRepository
        from arete.services.coaching_rules import RuleFacts
        from arete.services.settings import athlete_today

        trained = RuleFacts(
            acwr=1.0,
            tsb=-3.0,
            readiness_score=71.0,
            fatigue_threshold=85,
            fitness_goal="build",
        )
        repo = BriefingRepository()
        repo.delete_for_day(athlete_today())
        try:
            with (
                patch("arete.services.briefing.briefing_enabled", return_value=True),
                patch("arete.coaching.run_briefing", return_value="Écrit ce matin."),
                patch(
                    "arete.services.briefing._rule_floor",
                    return_value=("floor", "info", trained),
                ),
            ):
                assert client.get("/tips/daily").json()["status"] == "pending"
                body = client.post("/tips/daily").json()
                assert client.get("/tips/daily").json() == body
        finally:
            repo.delete_for_day(athlete_today())

        assert body["status"] == "ready"
        assert body["updated_after_sync"] is False
        assert body["tip"] == "Écrit ce matin."
        assert body["source"] == "agent"

    def test_a_dead_model_still_answers_with_the_rule_text(self, client):
        from unittest.mock import patch

        from arete.services.coaching_repository import BriefingRepository
        from arete.services.settings import athlete_today

        repo = BriefingRepository()
        repo.delete_for_day(athlete_today())
        try:
            with (
                patch("arete.services.briefing.briefing_enabled", return_value=True),
                patch(
                    "arete.coaching.run_briefing",
                    side_effect=RuntimeError("model is away"),
                ),
            ):
                resp = client.post("/tips/daily")
        finally:
            repo.delete_for_day(athlete_today())

        assert resp.status_code == 200
        body = resp.json()
        assert body["source"] == "rules"
        assert body["tip"]


def test_reading_without_a_briefing_is_fast_and_leaves_the_agent_out(tmp_path):
    """A cold instance answers the dashboard's GET without the agent stack.

    Its own process: the suite imports ``arete.coaching`` everywhere else.
    """
    import json
    import os
    import subprocess
    import sys

    code = """
import json, sys, time
from fastapi.testclient import TestClient
from arete.dataio.init_duckdb import main as init_schema
init_schema()
from arete.api.main import app
client = TestClient(app)
client.get("/tips/daily")  # the instance's first request opens the database
start = time.perf_counter()
response = client.get("/tips/daily")
elapsed = time.perf_counter() - start
print(json.dumps({
    "body": response.json(),
    "ms": elapsed * 1000,
    "coaching": "arete.coaching" in sys.modules,
    "timing": response.headers.get("server-timing"),
}))
"""
    env = {
        **os.environ,
        "ARETE_DB": str(tmp_path / "pending.duckdb"),
        "ARETE_DATA_DIR": str(tmp_path / "files"),
        "PYTHON_DOTENV_DISABLED": "1",
    }
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env
    )
    assert out.returncode == 0, out.stderr
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["body"]["status"] == "pending"
    assert result["coaching"] is False
    # The model run took seconds; the bound is loose for shared CI runners.
    assert result["ms"] < 500, result


def test_concurrent_writes_produce_the_day_once(client):
    """Two tabs ask for the day's briefing: one model run, the other waits for
    nothing and answers pending."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from arete.services.coaching_repository import BriefingRepository
    from arete.services.coaching_rules import RuleFacts
    from arete.services.settings import athlete_today

    trained = RuleFacts(
        acwr=1.0,
        tsb=-3.0,
        readiness_score=71.0,
        fatigue_threshold=85,
        fitness_goal="build",
    )
    running, release = threading.Event(), threading.Event()

    def produce(_facts: str) -> str:
        running.set()
        assert release.wait(timeout=5)
        return "Écrit une fois."

    repo = BriefingRepository()
    repo.delete_for_day(athlete_today())
    try:
        with (
            patch("arete.services.briefing.briefing_enabled", return_value=True),
            patch("arete.coaching.run_briefing", side_effect=produce) as run,
            patch(
                "arete.services.briefing._rule_floor",
                return_value=("floor", "info", trained),
            ),
            ThreadPoolExecutor(max_workers=3) as pool,
        ):
            first = pool.submit(client.post, "/tips/daily")
            assert running.wait(timeout=5)
            others = [client.post("/tips/daily").json() for _ in range(2)]
            assert client.get("/tips/daily").json()["status"] == "pending"
            release.set()
            written = first.result(timeout=10).json()
    finally:
        repo.delete_for_day(athlete_today())

    assert run.call_count == 1
    assert [o["status"] for o in others] == ["pending", "pending"]
    assert written["status"] == "ready"
    assert written["tip"] == "Écrit une fois."


class TestLowLoadIsNotSilence:
    """An athlete training under their chronic load still gets a reading."""

    def test_undertrained_acwr_has_its_own_tip(self):
        from arete.services.coaching_rules import generate_daily_tip

        tip, priority = generate_daily_tip(0.41, -8.2, 65.5)
        assert "ACWR 0,41" in tip
        assert priority == "info"

    def test_generic_tip_only_without_any_metric(self):
        from arete.services.coaching_rules import generate_daily_tip

        tip, _ = generate_daily_tip(None, None, None)
        assert "Enregistre tes séances" in tip
