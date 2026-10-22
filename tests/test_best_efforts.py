"""All-time records from ``app.best_efforts``, kept as sessions come and go (ARE-178)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from arete.dataio import best_efforts
from arete.dataio.db import db_connection, transaction
from arete.features.strength import estimate_1rm_epley
from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository
from arete.garmin.streams import ActivityStreams
from arete.services import analytics
from arete.services.athlete_scope import athlete_scope
from arete.strength.models import (
    Exercise,
    ExerciseCategory,
    ExerciseSet,
    MuscleGroup,
    SessionExercise,
    StrengthSession,
)
from arete.strength.progression import MAX_E1RM_REPS, WorkSet
from arete.strength.repository import StrengthRepository

ATHLETE = 8139


def _steady(seconds: int, mps: float, jump_at: int | None = None) -> ActivityStreams:
    distance, total = [], 0.0
    for i in range(seconds):
        total += mps if i else 0.0
        if i == jump_at:
            total += 1500.0  # a GPS jump: never a record
        distance.append(round(total, 1))
    return ActivityStreams(t=list(range(seconds)), distance_m=distance)


def _segments(*parts: tuple[int, float]) -> ActivityStreams:
    """Consecutive (seconds, metres per second) segments of one recording."""
    distance, total = [0.0], 0.0
    for seconds, mps in parts:
        for _ in range(seconds):
            total += mps
            distance.append(round(total, 1))
    return ActivityStreams(t=list(range(len(distance))), distance_m=distance)


@pytest.fixture
def garmin_athlete():
    """An athlete whose only data is Garmin runs with streams and logged lifts."""
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.athletes(id) VALUES (?) ON CONFLICT DO NOTHING", [ATHLETE]
        )
    with athlete_scope(ATHLETE):
        with db_connection() as con:
            con.execute(
                "INSERT INTO app.game_profile(id, athlete_id) VALUES (1, ?) "
                "ON CONFLICT DO NOTHING",
                [ATHLETE],
            )
        yield
    with db_connection() as con:
        for table in (
            "best_efforts",
            "exercise_sets",
            "session_exercises",
            "exercises",
            "activity_streams",
            "game_events",
            "game_profile",
        ):
            con.execute(f"DELETE FROM app.{table} WHERE athlete_id = ?", [ATHLETE])
        for table in ("strength_sessions", "actual_sessions"):
            con.execute(f"DELETE FROM app.{table} WHERE user_id = ?", [ATHLETE])


def _run(
    day: date, streams: ActivityStreams, sport: str = "running", name: str = "Footing"
) -> int:
    repo = GarminRepository()
    distance = streams.distance_m[-1] if streams.distance_m else 0.0
    session_id = repo.create_actual_session(
        ActualSession(
            date=day,
            sport=sport,
            name=name,
            duration_sec=len(streams),
            distance_m=distance,
            source=ActivitySource.GARMIN_CONNECT,
            start_time=datetime(day.year, day.month, day.day, 7, 0),
        )
    )
    repo.save_activity_streams(session_id, streams)
    return session_id


def _exercise(name: str = "Squat") -> int:
    return StrengthRepository().create_exercise(
        Exercise(
            name=name, category=ExerciseCategory.SQUAT, primary_muscle=MuscleGroup.QUADS
        )
    )


def _sets(sets: list[tuple[int, float]], exercise_id: int) -> list[SessionExercise]:
    return [
        SessionExercise(
            exercise_id=exercise_id,
            sets=[
                ExerciseSet(set_number=i + 1, reps=reps, weight_kg=kg)
                for i, (reps, kg) in enumerate(sets)
            ]
            # A heavy warm-up never counts.
            + [ExerciseSet(set_number=9, reps=10, weight_kg=200.0, is_warmup=True)],
        )
    ]


def _lift(day: date, exercise_id: int, sets: list[tuple[int, float]]) -> int:
    return StrengthRepository().create_session(
        StrengthSession(date=day, name="Force", exercises=_sets(sets, exercise_id))
    )


def _bests(session_id: int) -> tuple[int | None, ...]:
    """A run's stored seconds per record distance, None where it has none."""
    with db_connection() as con:
        stored = dict(
            con.execute(
                "SELECT effort_key, value FROM app.visible_best_efforts "
                "WHERE kind = 'run' AND session_id = ?",
                [session_id],
            ).fetchall()
        )
    return tuple(
        None if key not in stored else int(stored[key])
        for key in best_efforts.RUN_KEYS.values()
    )


def _records() -> dict:
    return analytics.get_overview("30d")["records"]


def test_records_populate_from_garmin_streams_and_lifts(garmin_athlete):
    today = analytics.athlete_today()
    slow = _run(today - timedelta(days=20), _steady(1900, 3.0), name="Footing lent")
    fast = _run(today - timedelta(days=10), _steady(3100, 3.5), name="Tempo")
    _run(today - timedelta(days=5), _steady(1200, 3.0, jump_at=300), name="GPS fou")
    ride = _run(
        today - timedelta(days=3), _steady(3600, 8.0), sport="cycling", name="Vélo"
    )
    squat = _exercise()
    first = _lift(today - timedelta(days=12), squat, [(5, 100.0), (5, 100.0)])
    _lift(today - timedelta(days=4), squat, [(3, 100.0)])  # a lower e1RM

    found = _records()

    assert set(found) == {"runs", "lifts"}
    assert _bests(ride) == (None,) * 5  # a ride is not a run
    by_name = {r["name"]: r for r in found["runs"]}
    assert list(by_name) == ["1 km", "5 km", "10 km"]
    # 1000 m at 3.5 m/s needs 286 samples; the GPS jump counts for nothing.
    assert by_name["1 km"]["time_sec"] == 286
    assert by_name["1 km"]["session_id"] == fast
    assert by_name["1 km"]["session_name"] == "Tempo"
    assert by_name["1 km"]["date"] == (today - timedelta(days=10)).isoformat()
    assert by_name["5 km"]["time_display"] == "23:49"
    assert by_name["10 km"]["pace_display"] == "4:46 /km"
    assert slow not in {r["session_id"] for r in found["runs"]}
    (lift,) = found["lifts"]
    assert lift["exercise"] == "Squat" and lift["sessions"] == 2
    assert (lift["e1rm_kg"], lift["weight_kg"], lift["reps"]) == (116.7, 100.0, 5)
    assert lift["session_id"] == first


def test_a_marathon_older_than_the_latest_hundred_runs_keeps_its_record(
    garmin_athlete,
):
    today = analytics.athlete_today()
    marathon = _run(
        today - timedelta(days=730), _steady(12100, 3.5), name="Marathon de Paris"
    )
    for i in range(101):
        _run(today - timedelta(days=i), _steady(400, 3.0))
    runs = {r["name"]: r for r in _records()["runs"]}
    assert runs["Marathon"]["session_id"] == marathon
    assert runs["Marathon"]["time_display"] == "3:20:56"
    assert runs["Marathon"]["date"] == (today - timedelta(days=730)).isoformat()
    # The old marathon is also the fastest kilometre: all time, not recent.
    assert runs["1 km"]["session_id"] == marathon


def test_deleting_the_record_run_recomputes_it(garmin_athlete):
    today = analytics.athlete_today()
    slow = _run(today - timedelta(days=20), _steady(1900, 3.0))
    fast = _run(today - timedelta(days=10), _steady(1900, 3.5))
    assert _records()["runs"][0]["session_id"] == fast

    assert GarminRepository().delete_actual_session(fast)

    (one_km, five_km) = _records()["runs"]
    assert (one_km["session_id"], one_km["time_sec"]) == (slow, 334)
    assert five_km["session_id"] == slow
    with db_connection() as con:
        assert con.execute(
            "SELECT count(*) FROM app.best_efforts WHERE session_id = ?", [fast]
        ).fetchone() == (0,)


def test_replaced_streams_replace_the_run_s_bests(garmin_athlete):
    session = _run(analytics.athlete_today(), _steady(1900, 3.0))
    assert _bests(session)[:2] == (334, 1667)
    # A reprocess keeps the session and stores its streams again.
    GarminRepository().save_activity_streams(session, _steady(400, 3.0))
    assert _bests(session) == (334, None, None, None, None)


def test_a_corrected_or_deleted_log_recomputes_its_lift(garmin_athlete):
    today = analytics.athlete_today()
    squat = _exercise()
    older = _lift(today - timedelta(days=9), squat, [(5, 100.0)])
    newer = _lift(today - timedelta(days=2), squat, [(5, 90.0)])
    assert _records()["lifts"][0]["session_id"] == older

    repo = StrengthRepository()
    assert repo.update_session(newer, _sets([(5, 120.0), (3, 120.0)], squat))
    (lift,) = _records()["lifts"]
    assert (lift["session_id"], lift["e1rm_kg"], lift["reps"]) == (newer, 140.0, 5)

    assert repo.delete_session(newer)
    (lift,) = _records()["lifts"]
    assert (lift["session_id"], lift["e1rm_kg"], lift["sessions"]) == (older, 116.7, 1)


def test_the_hook_follows_a_path_that_writes_activities_on_its_own(garmin_athlete):
    session = _run(analytics.athlete_today(), _steady(1900, 3.0))
    # Another path deletes it with its own SQL, then calls the hook.
    with db_connection() as con:
        con.execute(
            "UPDATE app.actual_sessions SET deleted_at = current_timestamp "
            "WHERE id = ? RETURNING id",
            [session],
        ).fetchall()
    best_efforts.refresh_activity_records([session])
    with db_connection() as con:
        assert con.execute(
            "SELECT count(*) FROM app.best_efforts WHERE session_id = ?", [session]
        ).fetchone() == (0,)
    assert _records()["runs"] == []


def test_an_equal_lift_stays_with_the_first_session(garmin_athlete):
    today = analytics.athlete_today()
    squat = _exercise()
    first = _lift(today - timedelta(days=9), squat, [(5, 100.0)])
    _lift(today - timedelta(days=2), squat, [(5, 100.0)])
    assert _records()["lifts"][0]["session_id"] == first


def test_the_sql_e1rm_is_the_progression_rule():
    with transaction() as con:
        for reps in range(1, MAX_E1RM_REPS + 1):
            (sql,) = con.execute(
                f"SELECT {best_efforts.E1RM_SQL} FROM (SELECT ? AS reps, 82.5 "
                "AS weight_kg) es",
                [reps],
            ).fetchone()
            expected = WorkSet(reps=reps, weight_kg=82.5).e1rm
            assert sql == pytest.approx(expected)
            assert expected == pytest.approx(estimate_1rm_epley(82.5, reps))


def test_a_car_ride_with_the_watch_on_holds_no_record(garmin_athlete):
    # 30 min of running at 3 m/s, then 15 min in a car at 12 m/s: capping the
    # car at 6.5 m/s would give 1 km in 2:34 and 5 km in 12:50.
    session = _run(analytics.athlete_today(), _segments((1800, 3.0), (900, 12.0)))
    assert _bests(session) == (334, 1667, None, None, None)


def test_a_burst_of_gps_jumps_holds_no_record(garmin_athlete):
    # Twenty samples 30 m apart in the middle of an easy run.
    session = _run(
        analytics.athlete_today(), _segments((300, 3.0), (20, 30.0), (900, 3.0))
    )
    # 1 km at 3 m/s, plus the 20 s of the burst inside the best window at most.
    assert _bests(session)[0] == 334


def test_a_shorter_run_holds_no_longer_record(garmin_athlete):
    session = _run(analytics.athlete_today(), _steady(400, 3.0))
    assert _bests(session) == (334, None, None, None, None)
