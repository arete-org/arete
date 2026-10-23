"""GET /strength/stats/muscles: what the heat map reads."""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from arete.api.strength import router


@pytest.fixture
def client(router_client):
    # The window ends on the athlete's day; the rows below are dated TODAY.
    with patch("arete.api.strength.athlete_today", return_value=TODAY):
        yield router_client(router)


TODAY = date.today()


def sets(muscle, kg_per_set, count=1, day=TODAY):
    """Working-set rows as ``muscle_set_rows`` returns them: one rep at ``kg``."""
    return [(day, muscle, None, 1, kg_per_set)] * count


class TestMuscleStats:
    @patch("arete.api.strength._cardio_sessions", return_value=[])
    @patch("arete.api.strength._repo")
    def test_window_and_every_region(self, repo, _cardio, client):
        repo.muscle_set_rows.return_value = sets("lats", 1000.0)
        data = client.get("/strength/stats/muscles?days=7").json()
        assert data["days"] == 7
        assert data["end"] == TODAY.isoformat()
        assert data["start"] == (TODAY - timedelta(days=6)).isoformat()
        assert len(data["muscles"]) == 20

    @patch("arete.api.strength._cardio_sessions", return_value=[])
    @patch("arete.api.strength._repo")
    def test_coarse_muscle_is_spread(self, repo, _cardio, client):
        repo.muscle_set_rows.return_value = sets("back", 100.0, count=10)
        muscles = {
            m["muscle"]: m
            for m in client.get("/strength/stats/muscles").json()["muscles"]
        }
        assert muscles["lats"]["volume"] == 500.0
        assert muscles["traps"]["volume"] == 250.0
        assert muscles["lats"]["level"] == 4
        assert muscles["traps"]["level"] == 2
        assert muscles["chest"]["level"] == 0

    @patch("arete.api.strength._cardio_sessions")
    @patch("arete.api.strength._repo")
    def test_cardio_adds_volume_and_freshness(self, repo, cardio, client):
        repo.muscle_set_rows.return_value = sets("lats", 100.0)
        cardio.return_value = [
            SimpleNamespace(date=TODAY, sport="running", duration_sec=3600)
        ]
        muscles = {
            m["muscle"]: m
            for m in client.get("/strength/stats/muscles").json()["muscles"]
        }
        assert muscles["quads"]["volume"] > 0
        assert muscles["quads"]["last_trained"] == TODAY.isoformat()

    @patch("arete.api.strength._cardio_sessions", return_value=[])
    @patch("arete.api.strength._repo")
    def test_cardio_can_be_excluded(self, repo, cardio, client):
        repo.muscle_set_rows.return_value = sets("lats", 100.0)
        client.get("/strength/stats/muscles?include_cardio=false")
        cardio.assert_not_called()

    @patch("arete.api.strength._cardio_sessions", return_value=[])
    @patch("arete.api.strength._repo")
    def test_one_read_per_source_covers_both_windows(self, repo, cardio, client):
        repo.muscle_set_rows.return_value = sets("lats", 100.0) + sets(
            "lats", 400.0, day=TODAY - timedelta(days=8)
        )
        muscles = {
            m["muscle"]: m
            for m in client.get("/strength/stats/muscles?days=7").json()["muscles"]
        }
        assert muscles["lats"]["volume"] == 100.0
        assert muscles["lats"]["previous_volume"] == 400.0
        both_windows = (TODAY - timedelta(days=13), TODAY)
        repo.muscle_set_rows.assert_called_once_with(*both_windows)
        cardio.assert_called_once_with(*both_windows)

    @patch("arete.api.strength._cardio_sessions", return_value=[])
    @patch("arete.api.strength._repo")
    def test_no_training_leaves_everything_cold(self, repo, _c, client):
        repo.muscle_set_rows.return_value = []
        muscles = client.get("/strength/stats/muscles").json()["muscles"]
        assert all(m["level"] == 0 and m["volume"] == 0.0 for m in muscles)

    def test_days_out_of_range_is_rejected(self, client):
        assert client.get("/strength/stats/muscles?days=0").status_code == 422
        assert client.get("/strength/stats/muscles?days=400").status_code == 422
