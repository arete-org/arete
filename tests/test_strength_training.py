"""Tests for strength training module (sessions, exercises, sets)."""

from datetime import date

import pytest

from arete.strength.models import (
    Exercise,
    ExerciseCategory,
    ExerciseSet,
    MuscleGroup,
    SessionExercise,
    StrengthSession,
)
from arete.strength.repository import StrengthRepository


class TestExerciseModel:
    """Tests for Exercise model."""

    def test_defaults(self):
        """Test default values."""
        exercise = Exercise(name="Test")
        assert exercise.name == "Test"
        assert exercise.category == ExerciseCategory.OTHER
        assert exercise.primary_muscle == MuscleGroup.FULL_BODY
        assert exercise.secondary_muscles == []
        assert exercise.is_unilateral is False

    def test_to_dict(self):
        """Test conversion to dictionary."""
        exercise = Exercise(
            name="Squat",
            category=ExerciseCategory.SQUAT,
            primary_muscle=MuscleGroup.QUADS,
            secondary_muscles=[MuscleGroup.GLUTES, MuscleGroup.HAMSTRINGS],
            equipment="barbell",
        )
        d = exercise.to_dict()
        assert d["name"] == "Squat"
        assert d["category"] == "squat"
        assert d["primary_muscle"] == "quads"
        assert '"glutes"' in d["secondary_muscles_json"]


class TestExerciseSetModel:
    """Tests for ExerciseSet model."""

    def test_volume_calculation(self):
        """Test volume calculation."""
        s = ExerciseSet(reps=10, weight_kg=100)
        assert s.volume == 1000

    def test_volume_no_weight(self):
        """Test volume with no weight."""
        s = ExerciseSet(reps=10, weight_kg=None)
        assert s.volume == 0

    def test_estimated_1rm(self):
        """Test 1RM estimation using Epley formula."""
        # 100kg x 5 reps -> 1RM = 100 * (1 + 5/30) = 116.67
        s = ExerciseSet(reps=5, weight_kg=100)
        assert s.estimated_1rm == pytest.approx(116.67, rel=0.01)

    def test_estimated_1rm_single(self):
        """Test 1RM for single rep."""
        s = ExerciseSet(reps=1, weight_kg=100)
        assert s.estimated_1rm == 100

    def test_rpe_from_rir(self):
        """Test RPE calculation from RIR."""
        s = ExerciseSet(rir=2)
        assert s.rpe_from_rir == 8


class TestSessionExerciseModel:
    """Tests for SessionExercise model."""

    def test_total_volume(self):
        """Test total volume across sets."""
        ex = SessionExercise()
        ex.sets = [
            ExerciseSet(reps=10, weight_kg=100, is_warmup=True),  # Excluded
            ExerciseSet(reps=8, weight_kg=100),
            ExerciseSet(reps=8, weight_kg=100),
            ExerciseSet(reps=6, weight_kg=100),
        ]
        # Only working sets: 8*100 + 8*100 + 6*100 = 2200
        assert ex.total_volume == 2200

    def test_working_sets_count(self):
        """Test counting working sets."""
        ex = SessionExercise()
        ex.sets = [
            ExerciseSet(is_warmup=True),
            ExerciseSet(is_warmup=True),
            ExerciseSet(),
            ExerciseSet(),
            ExerciseSet(),
        ]
        assert ex.working_sets_count == 3

    def test_avg_rpe(self):
        """Test average RPE calculation."""
        ex = SessionExercise()
        ex.sets = [
            ExerciseSet(rpe=7, is_warmup=True),  # Excluded
            ExerciseSet(rpe=8),
            ExerciseSet(rpe=9),
            ExerciseSet(rpe=10),
        ]
        assert ex.avg_rpe == 9.0

    def test_top_set(self):
        """Test finding top set."""
        ex = SessionExercise()
        ex.sets = [
            ExerciseSet(weight_kg=80, is_warmup=True),
            ExerciseSet(weight_kg=100),
            ExerciseSet(weight_kg=110),
            ExerciseSet(weight_kg=105),
        ]
        assert ex.top_set.weight_kg == 110


class TestStrengthSessionModel:
    """Tests for StrengthSession model."""

    def test_defaults(self):
        """Test default values."""
        session = StrengthSession()
        assert session.user_id is None
        assert session.date == date.today()
        assert session.exercises == []

    def test_total_volume(self):
        """Test total session volume."""
        session = StrengthSession()

        ex1 = SessionExercise()
        ex1.sets = [
            ExerciseSet(reps=8, weight_kg=100),
            ExerciseSet(reps=8, weight_kg=100),
        ]

        ex2 = SessionExercise()
        ex2.sets = [
            ExerciseSet(reps=10, weight_kg=50),
            ExerciseSet(reps=10, weight_kg=50),
        ]

        session.exercises = [ex1, ex2]

        # (8*100 + 8*100) + (10*50 + 10*50) = 1600 + 1000 = 2600
        assert session.total_volume == 2600

    def test_total_sets(self):
        """Test total working sets count."""
        session = StrengthSession()

        ex1 = SessionExercise()
        ex1.sets = [
            ExerciseSet(is_warmup=True),
            ExerciseSet(),
            ExerciseSet(),
        ]

        ex2 = SessionExercise()
        ex2.sets = [ExerciseSet(), ExerciseSet()]

        session.exercises = [ex1, ex2]
        assert session.total_sets == 4

    def test_muscles_worked(self):
        """Test muscle groups detection."""
        session = StrengthSession()

        ex1 = SessionExercise(exercise=Exercise(primary_muscle=MuscleGroup.CHEST))
        ex2 = SessionExercise(exercise=Exercise(primary_muscle=MuscleGroup.TRICEPS))
        ex3 = SessionExercise(exercise=Exercise(primary_muscle=MuscleGroup.SHOULDERS))

        session.exercises = [ex1, ex2, ex3]
        muscles = session.muscles_worked

        assert MuscleGroup.CHEST in muscles
        assert MuscleGroup.TRICEPS in muscles
        assert MuscleGroup.SHOULDERS in muscles

    def test_to_summary(self):
        """Test summary generation."""
        session = StrengthSession(
            id=1,
            date=date(2025, 12, 3),
            name="Push Day",
            program="PPL",
            duration_min=60,
            overall_rpe=8.0,
        )

        ex = SessionExercise(exercise=Exercise(primary_muscle=MuscleGroup.CHEST))
        ex.sets = [ExerciseSet(reps=10, weight_kg=100)]
        session.exercises = [ex]

        summary = session.to_summary()
        assert summary["id"] == 1
        assert summary["name"] == "Push Day"
        assert summary["exercises_count"] == 1
        assert summary["total_volume"] == 1000
        assert "chest" in summary["muscles_worked"]


@pytest.fixture
def strength_repo(tmp_path, monkeypatch):
    """Create a repository with temporary test database."""

    # Point to temp database
    db_path = str(tmp_path / "test_strength.duckdb")
    monkeypatch.setenv("ARETE_DB", db_path)

    # Initialize tables using the real init_duckdb
    from arete.dataio.init_duckdb import main as init_db

    init_db()

    return StrengthRepository(db_path)


def test_default_db_path_honours_arete_db(tmp_path, monkeypatch):
    """Without explicit path the repository must follow ARETE_DB, not data/arete.duckdb."""
    db_path = tmp_path / "from_env.duckdb"
    monkeypatch.setenv("ARETE_DB", str(db_path))
    assert StrengthRepository().db_path == str(db_path)


class TestStrengthRepository:
    """Tests for StrengthRepository."""

    def test_create_and_get_exercise(self, strength_repo):
        """Test creating and retrieving an exercise."""
        exercise = Exercise(
            name="Test Bench Press Repo",
            category=ExerciseCategory.PUSH_HORIZONTAL,
            primary_muscle=MuscleGroup.CHEST,
            secondary_muscles=[MuscleGroup.TRICEPS, MuscleGroup.SHOULDERS],
            equipment="barbell",
        )

        exercise_id = strength_repo.create_exercise(exercise)
        assert exercise_id is not None

        retrieved = strength_repo.get_exercise(exercise_id)
        assert retrieved is not None
        assert retrieved.name == "Test Bench Press Repo"
        assert retrieved.category == ExerciseCategory.PUSH_HORIZONTAL
        assert retrieved.primary_muscle == MuscleGroup.CHEST
        assert MuscleGroup.TRICEPS in retrieved.secondary_muscles

    def test_list_exercises_by_muscle(self, strength_repo):
        """Test filtering exercises by muscle group."""
        # Create chest exercise
        strength_repo.create_exercise(
            Exercise(
                name="Test Chest Fly Repo",
                category=ExerciseCategory.ISOLATION,
                primary_muscle=MuscleGroup.CHEST,
            )
        )

        chest_exercises = strength_repo.list_exercises(muscle=MuscleGroup.CHEST)
        assert len(chest_exercises) >= 1

    def test_create_and_get_session(self, strength_repo):
        """Test creating and retrieving a full session."""
        # First create an exercise
        exercise_id = strength_repo.create_exercise(
            Exercise(
                name="Test Squat Repo",
                category=ExerciseCategory.SQUAT,
                primary_muscle=MuscleGroup.QUADS,
            )
        )

        # Create session with exercises and sets
        session = StrengthSession(
            date=date.today(),
            name="Test Leg Day Repo",
            program="PPL",
            duration_min=60,
            overall_rpe=8.5,
        )

        session_exercise = SessionExercise(
            exercise_id=exercise_id,
            order=1,
            target_sets=3,
            target_reps="8-12",
            target_rpe=8.0,
        )

        session_exercise.sets = [
            ExerciseSet(set_number=1, reps=10, weight_kg=60, is_warmup=True),
            ExerciseSet(set_number=2, reps=10, weight_kg=100, rpe=7),
            ExerciseSet(set_number=3, reps=8, weight_kg=100, rpe=8),
            ExerciseSet(set_number=4, reps=6, weight_kg=100, rpe=9),
        ]

        session.exercises = [session_exercise]

        session_id = strength_repo.create_session(session)
        assert session_id is not None

        # Retrieve full session
        retrieved = strength_repo.get_session(session_id)
        assert retrieved is not None
        assert retrieved.name == "Test Leg Day Repo"
        assert retrieved.overall_rpe == 8.5
        assert len(retrieved.exercises) == 1

        ex = retrieved.exercises[0]
        assert len(ex.sets) == 4
        assert ex.working_sets_count == 3
        assert ex.total_volume == 2400  # (10+8+6) * 100

        # Cleanup
        strength_repo.delete_session(session_id)

    def _seed_sessions(self, repo, count: int) -> list[int]:
        ids = []
        for n in range(count):
            exercises = []
            for order in (1, 2):
                exercise_id = repo.create_exercise(
                    Exercise(
                        name=f"Test List Exercise {n}-{order}",
                        category=ExerciseCategory.SQUAT,
                        primary_muscle=MuscleGroup.QUADS,
                        secondary_muscles=[MuscleGroup.GLUTES],
                    )
                )
                exercise = SessionExercise(exercise_id=exercise_id, order=order)
                exercise.sets = [
                    ExerciseSet(set_number=i, reps=5 + i, weight_kg=50 + 10 * n)
                    for i in (1, 2, 3)
                ]
                exercises.append(exercise)
            session = StrengthSession(date=date(2030, 1, 1 + n), name=f"List {n}")
            session.exercises = exercises
            ids.append(repo.create_session(session))
        return ids

    def test_list_with_details_matches_get_session(self, strength_repo):
        ids = self._seed_sessions(strength_repo, 3)
        listed = strength_repo.list_sessions(
            start_date=date(2030, 1, 1), include_details=True
        )
        assert listed == [strength_repo.get_session(i) for i in reversed(ids)]
        assert all(len(s.exercises) == 2 for s in listed)

    def test_list_with_details_costs_three_statements(
        self, strength_repo, statement_log
    ):
        self._seed_sessions(strength_repo, 3)
        connect = strength_repo._get_connection
        strength_repo._get_connection = lambda: statement_log.wrap(connect())
        strength_repo.list_sessions(start_date=date(2030, 1, 1), include_details=True)
        assert len(statement_log) == 3

    def test_exercise_history(self, strength_repo):
        """Test getting exercise history."""
        # Create exercise
        exercise_id = strength_repo.create_exercise(
            Exercise(name="Test Deadlift Repo", primary_muscle=MuscleGroup.HAMSTRINGS)
        )

        # Create a session with this exercise
        session = StrengthSession(date=date.today())
        session_exercise = SessionExercise(exercise_id=exercise_id, order=1)
        session_exercise.sets = [
            ExerciseSet(set_number=1, reps=5, weight_kg=140),
            ExerciseSet(set_number=2, reps=5, weight_kg=140),
        ]
        session.exercises = [session_exercise]

        session_id = strength_repo.create_session(session)

        # Get history
        history = strength_repo.get_exercise_history(exercise_id)
        assert len(history) >= 1
        assert history[0]["max_weight"] == 140
        assert history[0]["volume"] == 1400

        # Cleanup
        strength_repo.delete_session(session_id)

    def test_personal_records(self, strength_repo):
        """Test getting personal records."""
        exercise_id = strength_repo.create_exercise(
            Exercise(name="Test OHP Repo", primary_muscle=MuscleGroup.SHOULDERS)
        )

        session = StrengthSession(date=date.today())
        session_exercise = SessionExercise(exercise_id=exercise_id, order=1)
        session_exercise.sets = [
            ExerciseSet(set_number=1, reps=5, weight_kg=60, rpe=8),
        ]
        session.exercises = [session_exercise]

        session_id = strength_repo.create_session(session)

        prs = strength_repo.get_personal_records(exercise_id)
        assert prs["max_weight"] == 60
        assert prs["max_weight_reps"] == 5
        # Epley: 60 * (1 + 5/30) = 70
        assert prs["estimated_1rm"] == pytest.approx(70, rel=0.01)

        # Cleanup
        strength_repo.delete_session(session_id)


class TestStrengthRepositoryRagIntegration:
    """Tests for RAG-related methods in strength repository."""


def test_parse_endpoint_reports_unparsed_lines_and_suggestions(client):
    """API contract used by the Log page: unparsed_lines + per-exercise suggestions."""
    resp = client.post(
        "/strength/sessions/parse",
        json={"text": "4x8 @80 bench press\nline that means nothing", "save": False},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["unparsed_lines"] == ["line that means nothing"]
    ex = body["exercises"][0]
    assert ex["exercise_id"] == "bench_press" and ex["exercise_matched"] is True
    assert ex["suggestions"][0]["exercise_id"] == "bench_press"

    resp = client.post(
        "/strength/sessions/parse", json={"text": "hello world", "save": False}
    )
    assert resp.status_code == 422


def _seed_summary_fixture(repo) -> None:
    """Sessions covering what the list totals must get right."""

    def exercise(name, muscle, unilateral=False):
        return repo.create_exercise(
            Exercise(
                name=f"Summary {name}",
                primary_muscle=muscle,
                secondary_muscles=[MuscleGroup.HAMSTRINGS],
                is_unilateral=unilateral,
            )
        )

    squat = exercise("squat", MuscleGroup.QUADS)
    lunge = exercise("lunge", MuscleGroup.GLUTES, unilateral=True)
    press = exercise("press", MuscleGroup.QUADS)

    def sets(*rows):
        return [
            ExerciseSet(set_number=i, reps=reps, weight_kg=kg, is_warmup=warmup)
            for i, (reps, kg, warmup) in enumerate(rows, 1)
        ]

    full = StrengthSession(date=date(2031, 3, 3), name="Full")
    full.exercises = [
        SessionExercise(
            exercise_id=squat,
            order=1,
            sets=sets((5, 40.0, True), (5, 102.5, False), (3, 107.5, False)),
        ),
        SessionExercise(
            exercise_id=lunge, order=2, sets=sets((8, 22.5, False), (8, None, False))
        ),
        SessionExercise(exercise_id=press, order=3, sets=sets((10, 0.1, False))),
    ]
    no_sets = StrengthSession(date=date(2031, 3, 3), name="Same day, no sets")
    no_sets.exercises = [SessionExercise(exercise_id=press, order=1)]
    warmups = StrengthSession(date=date(2031, 3, 2), name="Warm-ups only")
    warmups.exercises = [
        SessionExercise(exercise_id=squat, order=1, sets=sets((5, 60.0, True)))
    ]
    for session in (full, no_sets, warmups, StrengthSession(date=date(2031, 3, 1))):
        repo.create_session(session)


def test_list_summaries_match_the_detailed_totals(strength_repo):
    _seed_summary_fixture(strength_repo)
    detailed = strength_repo.list_sessions(
        start_date=date(2031, 1, 1), include_details=True
    )
    expected = {
        s.id: (
            s.date,
            s.name,
            len(s.exercises),
            s.total_sets,
            round(s.total_volume, 1),
            sorted(m.value for m in s.muscles_worked),
        )
        for s in detailed
    }
    summaries = strength_repo.list_session_summaries(start_date=date(2031, 1, 1))
    assert {
        s.id: (
            s.date,
            s.name,
            s.exercises_count,
            s.total_sets,
            round(s.total_volume, 1),
            s.muscles_worked,
        )
        for s in summaries
    } == expected
    assert len(expected) == 4
    assert [s.date for s in summaries] == sorted(
        (s.date for s in summaries), reverse=True
    )
    assert expected[summaries[-1].id][2:] == (0, 0, 0, [])  # empty session


def test_list_summaries_cost_one_statement(strength_repo, statement_log):
    _seed_summary_fixture(strength_repo)
    connect = strength_repo._get_connection
    strength_repo._get_connection = lambda: statement_log.wrap(connect())
    assert len(strength_repo.list_session_summaries(limit=200)) == 4
    assert len(statement_log) == 1
