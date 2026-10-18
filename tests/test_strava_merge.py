"""Garmin/Strava merge rules and the overlap lookup on a real temp DB."""

from __future__ import annotations

from datetime import datetime

from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.strava.merge import garmin_takeover, strava_extras


def _session(source: ActivitySource, start: datetime, **kw) -> ActualSession:
    return ActualSession(
        date=start.date(),
        sport="running",
        duration_sec=3600,
        start_time=start,
        source=source,
        **kw,
    )


class TestMergeRules:
    def test_strava_extras_only_link_the_copy(self):
        garmin = _session(
            ActivitySource.GARMIN_CONNECT,
            datetime(2026, 6, 1, 8),
            name="Course",
            hr_zones_json="{}",
        )
        strava = _session(
            ActivitySource.STRAVA,
            datetime(2026, 6, 1, 8, 1),
            garmin_activity_id="s1",
            name="Morning Run",
            suffer_score=80,
            best_efforts_json="[...]",
            hr_zones_json='{"z1": 1}',
        )
        # Strava's data may not reach the coach: the copy is linked, never
        # merged into the Garmin row (ARE-126).
        assert strava_extras(garmin, strava) == {"strava_activity_id": "s1"}

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

    def test_known_strava_ids_include_merged(self):
        repo = GarminRepository()
        start = datetime(2031, 4, 4, 7, 0)
        sid = repo.create_actual_session(
            _session(ActivitySource.GARMIN_CONNECT, start, garmin_activity_id="g9")
        )
        sid2 = repo.create_actual_session(
            _session(
                ActivitySource.STRAVA, datetime(2031, 4, 5, 7), garmin_activity_id="s5"
            )
        )
        try:
            repo.update_actual_session_fields(sid, strava_activity_id="s9")
            ids = repo.known_strava_ids()
            assert {"s9", "s5"} <= ids and "g9" not in ids
        finally:
            repo.delete_actual_session(sid)
            repo.delete_actual_session(sid2)


class TestGarminStravaDoNotDuplicate:
    """End to end on the real repository: the same run must stay one row.

    Regression guard for the 2026-09-21 duplicate — a Garmin row at 07:17 and
    a Strava row at 09:17 for one 13.2 km run, two hours apart because the
    Strava copy was parsed as UTC. The merge matches within 120 seconds, so it
    never saw them as the same workout and the load was counted twice.
    """

    def test_the_strava_copy_merges_into_the_garmin_row(self, tmp_path, monkeypatch):
        from datetime import date, datetime

        monkeypatch.setenv("ARETE_DB", str(tmp_path / "merge.duckdb"))
        from arete.dataio.init_duckdb import main as init_db

        init_db()

        from arete.garmin.models import ActivitySource, ActualSession
        from arete.garmin.repository import GarminRepository
        from arete.strava.models import strava_activity_to_actual_session

        repo = GarminRepository()
        repo.create_actual_session(
            ActualSession(
                date=date(2026, 9, 21),
                sport="run",
                name="Paris Running",
                start_time=datetime(2026, 9, 21, 7, 17, 22),
                duration_sec=4197,
                distance_m=13237.36,
                avg_hr=155,
                source=ActivitySource.GARMIN_CONNECT,
                garmin_activity_id="24439724659",
            )
        )

        strava = strava_activity_to_actual_session(
            {
                "id": 20263557277,
                "type": "Run",
                "name": "Morning Run",
                "elapsed_time": 4332,
                "distance": 13237.4,
                # Strava's local time, with the trailing Z it really sends.
                "start_date_local": "2026-09-21T07:17:22Z",
                "start_date": "2026-09-21T05:17:22Z",
            }
        )
        twin = repo.find_overlapping_session(strava.start_time, strava.duration_sec)

        assert twin is not None, "the Strava copy must find its Garmin twin"
        assert twin.name == "Paris Running"
