"""Garmin taking over a legacy Strava row, and the overlap lookup that finds it.

Strava was retired as a data source (ARE-126); the rows it created stay, and
Garmin importing the same workout turns such a row into a Garmin row.
"""

from __future__ import annotations

from datetime import datetime

from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.garmin.sync import STRAVA_ONLY_FIELDS, garmin_takeover


def _session(source: ActivitySource, start: datetime, **kw) -> ActualSession:
    kw.setdefault("duration_sec", 3600)
    return ActualSession(
        date=start.date(), sport="running", start_time=start, source=source, **kw
    )


class TestTakeoverRules:
    def test_garmin_takeover_changes_provenance(self):
        garmin = _session(
            ActivitySource.GARMIN_CONNECT,
            datetime(2026, 6, 1, 8),
            garmin_activity_id="g1",
            session_type="running",
            hr_zones_json="{}",
        )
        fields = garmin_takeover(garmin)
        assert fields["source"] == "garmin_connect"
        assert fields["garmin_activity_id"] == "g1"
        assert fields["session_type"] == "running"


class TestOverlapLookup:
    def test_finds_twin_within_two_minutes(self):
        repo = GarminRepository()
        start = datetime(2031, 3, 3, 7, 0)
        sid = repo.create_actual_session(
            _session(ActivitySource.GARMIN_CONNECT, start, garmin_activity_id="twin")
        )
        try:
            hit = repo.find_overlapping_session(datetime(2031, 3, 3, 7, 1, 30), 3600)
            assert hit is not None and hit.id == sid
            assert (
                repo.find_overlapping_session(datetime(2031, 3, 3, 7, 10), 3600) is None
            )
            assert repo.find_overlapping_session(None, 3600) is None
        finally:
            repo.delete_actual_session(sid)


class TestGarminWinsOnTakeover:
    """End to end on the real repository: the legacy row becomes Garmin's."""

    def test_the_strava_row_keeps_only_garmin_values(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARETE_DB", str(tmp_path / "takeover.duckdb"))
        from arete.dataio.init_duckdb import main as init_db

        init_db()
        repo = GarminRepository()
        start = datetime(2026, 9, 21, 7, 17, 22)
        strava_id = repo.create_actual_session(
            _session(
                ActivitySource.STRAVA,
                start,
                garmin_activity_id="20263557277",
                name="Morning Run",
                notes="Description Strava",
                duration_sec=4332,
                distance_m=13300.0,
                avg_hr=150,
                max_hr=181,
                calories=900,
                suffer_score=80,
                best_efforts_json="[]",
                splits_json="[]",
                avg_watts=250,
                device_name="Strava app",
                rpe=6,
            )
        )
        garmin = _session(
            ActivitySource.GARMIN_CONNECT,
            datetime(2026, 9, 21, 7, 17, 30),
            garmin_activity_id="24439724659",
            name="Paris Running",
            duration_sec=4197,
            distance_m=13237.36,
            avg_hr=155,
        )

        twin = repo.find_overlapping_session(garmin.start_time, garmin.duration_sec)
        assert twin is not None and twin.id == strava_id
        repo.update_actual_session_fields(strava_id, **garmin_takeover(garmin))
        row = repo.get_actual_session(strava_id)

        assert row is not None
        assert row.source == ActivitySource.GARMIN_CONNECT
        assert row.garmin_activity_id == "24439724659"
        assert (row.name, row.duration_sec, row.distance_m, row.avg_hr) == (
            "Paris Running",
            4197,
            13237.36,
            155,
        )
        # Garmin measured no max HR or calories: Strava's do not stay.
        assert row.max_hr is None and row.calories is None
        assert all(getattr(row, column) is None for column in STRAVA_ONLY_FIELDS)
        assert row.rpe == 6  # the athlete's own
