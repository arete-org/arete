"""Garmin sync taking over a session first imported from a file (ARE-181).

A workout imported as a FIT, TCX or GPX file, then synced from Garmin
Connect, stays one row: Garmin's values, the athlete's notes and RPE, one
feedback, one game event, records from Garmin's streams.
"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import duckdb
import pytest
from activity_samples import gpx_activity
from write_race import race

from arete.dataio.db import connect, db_connection
from arete.dataio.init_duckdb import main as init_schema
from arete.features.hr_zones import ZoneModel
from arete.garmin.models import (
    ActivitySource,
    ActualSession,
    PlannedSession,
    SessionStatus,
)
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams
from arete.garmin.sync import GarminActivity, GarminSyncClient, SyncResult
from arete.services.activity_import import import_upload
from arete.services.analytics import update_session
from arete.services.coaching_repository import SessionFeedbackRepository

ZONES = ZoneModel.from_reference(lthr=165)
DAY = date(2026, 10, 14)
#: The GPX sample's start (06:30 UTC) on the athlete's clock (Europe/Paris).
FILE_START = datetime(2026, 10, 14, 8, 30)
TAKEOVER = r"UPDATE actual_sessions SET .* source IN \("


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "takeover.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    init_schema()
    with db_connection() as con:
        con.execute("INSERT INTO app.athletes (id) VALUES (1) ON CONFLICT DO NOTHING")
    from arete.services import memory as fs

    root = tmp_path / "memory"
    root.mkdir()
    monkeypatch.setattr(fs, "memory_root", lambda: root)
    return tmp_path


def _rows() -> list[tuple]:
    con = connect()
    try:
        return con.execute(
            "SELECT id, source, garmin_activity_id, distance_m, avg_hr, notes, rpe, "
            "planned_session_id, adherence_score FROM app.visible_actual_sessions "
            "ORDER BY id"
        ).fetchall()
    finally:
        con.close()


def _scalar(sql: str, params: list | None = None):
    con = connect()
    try:
        return con.execute(sql, params or []).fetchone()[0]
    finally:
        con.close()


def _import_file() -> int:
    (outcome,) = import_upload("run.gpx", gpx_activity())
    assert outcome.status == "imported" and outcome.session_id is not None
    return outcome.session_id


def _activity(
    activity_id: int = 777,
    *,
    start: datetime = datetime(2026, 10, 14, 8, 30, 20),
    sport: str = "running",
    duration: int = 610,
    elapsed: int | None = None,
) -> GarminActivity:
    return GarminActivity(
        activity_id=activity_id,
        activity_name="Footing Garmin",
        activity_type=sport,
        start_time=start,
        duration_sec=duration,
        distance_m=2000.0,
        avg_hr=148,
        max_hr=170,
        calories=None,
        avg_speed_mps=3.3,
        max_speed_mps=4.0,
        ascent_m=None,
        descent_m=None,
        avg_cadence=None,
        max_cadence=None,
        elapsed_duration_sec=elapsed,
    )


#: Garmin's own samples: 3.5 m/s, faster than the file's 3 m/s over 1 km.
GARMIN_STREAMS = ActivityStreams(
    t=list(range(0, 601, 10)),
    heart_rate=[150.0] * 61,
    distance_m=[3.5 * t for t in range(0, 601, 10)],
)


def _sync(*activities: GarminActivity, streams: ActivityStreams | None = None):
    client = GarminSyncClient(
        client=MagicMock(), repository=GarminRepository(), zones=ZONES
    )

    def enrich(session: ActualSession, path: Path):
        session.source_file = path.name
        return session, streams

    with (
        patch.object(client, "download_fit_file", return_value=Path("777.fit")),
        patch.object(client, "_enrich_from_fit", side_effect=enrich),
    ):
        events = list(
            client.iter_sync_activities(
                activity_batch=list(activities), download_fit=streams is not None
            )
        )
    result = events[-1]
    assert isinstance(result, SyncResult)
    return result


def test_the_garmin_sync_takes_over_the_imported_file(db):
    repo = GarminRepository()
    planned_id = repo.create_planned_session(
        PlannedSession(date=DAY, sport="running", target_duration_min=10)
    )
    file_id = _import_file()
    update_session(file_id, {"notes": "Jambes lourdes", "rpe": 6})
    # The daily catch-up already wrote the file session's feedback.
    from arete.services.coaching_rules import sync_feedback

    produce = MagicMock(return_value="Bien couru.")
    assert len(sync_feedback([file_id], produce=produce)["written"]) == 1
    file_records = _scalar(
        "SELECT value FROM app.best_efforts WHERE session_id = ? AND effort_key = '1000'",
        [file_id],
    )

    result = _sync(_activity(), streams=GARMIN_STREAMS)

    assert result.errors == []
    assert (result.activities_synced, result.activities_merged) == (0, 1)
    assert result.session_ids == [file_id]
    ((row_id, source, garmin_id, distance, avg_hr, notes, rpe, plan, score),) = _rows()
    assert (row_id, source, garmin_id) == (file_id, "garmin_connect", "777")
    assert (distance, avg_hr) == (2000.0, 148)  # Garmin's values win
    assert (notes, rpe) == ("Jambes lourdes", 6)  # the athlete's stay
    assert plan == planned_id and score is not None  # linked, rescored
    session = repo.get_actual_session(file_id)
    assert session is not None
    assert session.name == "Footing Garmin"
    assert session.start_time == datetime(2026, 10, 14, 8, 30, 20)
    # A value Garmin lacks keeps the file's (the same workout).
    assert session.hr_zones_json is not None
    assert session.source_file == "777.fit"  # Garmin's file, not the GPX's
    # Garmin's streams replaced the file's, and the records follow them.
    stored = repo.get_activity_streams(file_id)
    assert stored is not None and stored.heart_rate == GARMIN_STREAMS.heart_rate
    garmin_record = _scalar(
        "SELECT value FROM app.best_efforts WHERE session_id = ? AND effort_key = '1000'",
        [file_id],
    )
    assert garmin_record < file_records
    assert _scalar("SELECT count(*) FROM app.best_efforts WHERE effort_key='1000'") == 1
    # One game event, captured at the import: no second credit.
    assert _scalar("SELECT count(*) FROM app.visible_game_events") == 1
    assert _scalar("SELECT source_key FROM app.visible_game_events") == (
        f"actual:{file_id}"
    )
    # No second feedback: the sync's run and the daily catch-up skip it.
    produce.reset_mock()
    assert sync_feedback(result.session_ids, produce=produce)["written"] == []
    produce.assert_not_called()
    assert SessionFeedbackRepository().pending_garmin() == ([], 0)
    assert _scalar("SELECT count(*) FROM app.visible_session_feedback") == 1
    assert repo.get_planned_session(planned_id).status == SessionStatus.COMPLETED


def test_a_takeover_without_garmin_streams_keeps_the_files(db):
    file_id = _import_file()
    file_streams = GarminRepository().get_activity_streams(file_id)

    result = _sync(_activity())

    assert result.session_ids == [file_id] and result.activities_merged == 1
    assert GarminRepository().get_activity_streams(file_id) == file_streams
    taken = GarminRepository().get_actual_session(file_id)
    assert taken is not None and taken.source_file is None
    # Garmin's 2 km over the same streams: the records are recomputed.
    assert _scalar(
        "SELECT count(*) FROM app.best_efforts WHERE session_id = ?", [file_id]
    )


def test_a_resync_skips_the_activity_taken_over(db):
    file_id = _import_file()
    assert _sync(_activity()).activities_merged == 1

    again = _sync(_activity())

    assert (again.activities_skipped, again.activities_merged) == (1, 0)
    assert again.session_ids == []
    assert [row[0] for row in _rows()] == [file_id]


def test_a_warm_up_of_another_sport_minutes_before_is_not_merged(db):
    file_id = _import_file()
    # A 5-minute bike warm-up from 08:26, then the 08:30 run of the file.
    warm_up = _activity(
        778, start=datetime(2026, 10, 14, 8, 26), sport="cycling", duration=300
    )

    result = _sync(warm_up)

    assert (result.activities_synced, result.activities_merged) == (1, 0)
    rows = _rows()
    assert [row[1] for row in rows] == ["gpx_file", "garmin_connect"]
    assert rows[0][0] == file_id and rows[0][2] is None


def test_a_legacy_fit_row_is_taken_over_by_its_end(db):
    # The old FIT route stored the local end (08:40) as the start.
    repo = GarminRepository()
    legacy_id = repo.create_actual_session(
        ActualSession(
            date=DAY,
            sport="running",
            duration_sec=600,
            distance_m=1800.0,
            source=ActivitySource.FIT_FILE,
            source_file="run.fit",
            start_time=datetime(2026, 10, 14, 8, 40),
            rpe=4,
        )
    )

    result = _sync(_activity(start=FILE_START, duration=600))

    assert result.session_ids == [legacy_id] and result.activities_merged == 1
    ((_, source, garmin_id, distance, *_rest),) = _rows()
    assert (source, garmin_id, distance) == ("garmin_connect", "777", 2000.0)
    session = repo.get_actual_session(legacy_id)
    assert session is not None
    assert session.start_time == FILE_START and session.rpe == 4


def test_a_legacy_fit_row_with_a_long_pause_is_taken_over(db):
    # 10 minutes of timer over 17 of wall clock: the stored end is 08:47.
    repo = GarminRepository()
    legacy_id = repo.create_actual_session(
        ActualSession(
            date=DAY,
            sport="running",
            duration_sec=600,
            source=ActivitySource.FIT_FILE,
            source_file="run.fit",
            start_time=datetime(2026, 10, 14, 8, 47),
        )
    )

    result = _sync(_activity(start=FILE_START, duration=600, elapsed=1020))

    assert result.session_ids == [legacy_id] and result.activities_merged == 1


def test_the_elapsed_duration_is_read_from_garmin():
    activity = GarminActivity.from_api_response(
        {
            "activityId": 1,
            "startTimeLocal": "2026-10-14T08:30:00",
            "duration": 600.0,
            "elapsedDuration": 1020.4,
        }
    )
    assert (activity.duration_sec, activity.elapsed_duration_sec) == (600, 1020)


def _file_row(start: datetime, duration: int, sport: str = "running") -> int:
    return GarminRepository().create_actual_session(
        ActualSession(
            date=start.date(),
            sport=sport,
            duration_sec=duration,
            source=ActivitySource.TCX_FILE,
            source_file=f"{sport}.tcx@{start:%Y-%m-%dT%H:%M:%S}",
            start_time=start,
        )
    )


def test_of_two_file_rows_the_closest_start_is_taken_over(db):
    closest = _file_row(datetime(2026, 10, 14, 8, 30, 30), 600)
    # Listed first (newer id), within the tolerance, but further away.
    _file_row(datetime(2026, 10, 14, 8, 34), 600)

    result = _sync(_activity())

    assert result.session_ids == [closest]


def test_a_short_file_run_ended_before_the_garmin_run_is_not_taken_over(db):
    # 07:00 to 07:03, then Garmin's run from 07:04: no shared time.
    file_id = _file_row(datetime(2026, 10, 14, 7, 0), 180)

    result = _sync(_activity(start=datetime(2026, 10, 14, 7, 4)))

    assert (result.activities_synced, result.activities_merged) == (1, 0)
    assert file_id not in result.session_ids and len(_rows()) == 2


def test_a_file_run_inside_a_long_garmin_session_of_another_sport_stays(db):
    # A 20-minute run from 07:02 inside a 60-minute strength session.
    _file_row(datetime(2026, 10, 14, 7, 2), 1200)
    strength = _activity(
        start=datetime(2026, 10, 14, 7, 0), sport="strength_training", duration=3600
    )

    with (
        patch("arete.garmin.sync.link_garmin_strength"),
        patch("arete.garmin.sync.open_garmin_draft"),
    ):
        result = _sync(strength)

    assert (result.activities_synced, result.activities_merged) == (1, 0)
    assert [row[1] for row in _rows()] == ["tcx_file", "garmin_connect"]


def test_only_a_file_row_is_taken_over(db):
    repo = GarminRepository()
    garmin_id = repo.create_actual_session(
        ActualSession(
            date=DAY,
            sport="running",
            duration_sec=600,
            source=ActivitySource.GARMIN_CONNECT,
            garmin_activity_id="1",
            start_time=FILE_START,
        )
    )
    assert repo.take_over_file_session(garmin_id, {"avg_hr": 1}) is False
    session = repo.get_actual_session(garmin_id)
    assert session is not None and session.avg_hr is None


def test_an_edit_during_the_takeover_wins_and_nothing_is_replayed(db, monkeypatch):
    file_id = _import_file()

    def athlete_edits() -> None:
        update_session(file_id, {"notes": "Écrit pendant la synchro"})

    with race(monkeypatch, TAKEOVER, athlete_edits):
        result = _sync(_activity())

    # The takeover conflicted: one error, no second row, the edit kept.
    assert len(result.errors) == 1 and result.session_ids == []
    ((_, source, garmin_id, _d, _hr, notes, *_rest),) = _rows()
    assert (source, garmin_id, notes) == ("gpx_file", None, "Écrit pendant la synchro")
    # The next sync takes it over, the note still there.
    assert _sync(_activity()).session_ids == [file_id]
    ((_, source, _g, _d, _hr, notes, *_rest),) = _rows()
    assert (source, notes) == ("garmin_connect", "Écrit pendant la synchro")


def test_a_row_deleted_during_the_takeover_is_not_replaced_in_that_run(db, monkeypatch):
    file_id = _import_file()

    def athlete_deletes() -> None:
        assert GarminRepository().delete_actual_session(file_id)

    with race(monkeypatch, TAKEOVER, athlete_deletes):
        result = _sync(_activity())

    assert len(result.errors) == 1 and result.session_ids == []
    assert _rows() == []
    # The next sync imports the activity as a new session.
    again = _sync(_activity())
    assert (again.activities_synced, again.activities_merged) == (1, 0)
    assert [row[1] for row in _rows()] == ["garmin_connect"]


def test_the_conflict_is_the_engines(db, monkeypatch):
    """The edit and the takeover both delete the row version (ARE-150)."""
    file_id = _import_file()

    def athlete_edits() -> None:
        update_session(file_id, {"rpe": 7})

    with (
        race(monkeypatch, TAKEOVER, athlete_edits),
        pytest.raises(duckdb.TransactionException),
    ):
        GarminRepository().take_over_file_session(file_id, {"avg_hr": 150})
    assert GarminRepository().get_actual_session(file_id).avg_hr == 140
