"""Data models for strength training.

Dataclass models for exercises, sets, and strength sessions.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import Any


class MuscleGroup(str, Enum):
    """Muscle regions, as precise as the catalog knows them.

    The fine members match ``arete.features.muscles.CANONICAL`` — the regions
    the silhouette paints. SHOULDERS, BACK and FULL_BODY are kept for rows
    written before the catalog got specific; they are spread over the fine
    regions when read.
    """

    # Upper body - Push
    CHEST = "chest"
    FRONT_DELTS = "front_delts"
    SIDE_DELTS = "side_delts"
    TRICEPS = "triceps"

    # Upper body - Pull
    REAR_DELTS = "rear_delts"
    LATS = "lats"
    TRAPS = "traps"
    RHOMBOIDS = "rhomboids"
    BICEPS = "biceps"
    FOREARMS = "forearms"

    # Core
    ABS = "abs"
    OBLIQUES = "obliques"
    LOWER_BACK = "lower_back"

    # Lower body
    QUADS = "quads"
    HAMSTRINGS = "hamstrings"
    GLUTES = "glutes"
    CALVES = "calves"
    ADDUCTORS = "adductors"
    HIP_FLEXORS = "hip_flexors"
    TIBIALIS = "tibialis"

    # Coarse, kept for rows written before the fine regions existed
    SHOULDERS = "shoulders"
    BACK = "back"
    FULL_BODY = "full_body"


class ExerciseCategory(str, Enum):
    """Exercise categories by movement pattern."""

    # Compound movements
    SQUAT = "squat"
    HINGE = "hinge"  # Deadlifts, RDL
    PUSH_HORIZONTAL = "push_horizontal"  # Bench press
    PUSH_VERTICAL = "push_vertical"  # OHP
    PULL_HORIZONTAL = "pull_horizontal"  # Rows
    PULL_VERTICAL = "pull_vertical"  # Pull-ups, lat pulldown
    CARRY = "carry"  # Farmer walks

    # Isolation
    ISOLATION = "isolation"

    # Accessory
    CORE = "core"
    MOBILITY = "mobility"
    PLYOMETRIC = "plyometric"

    # Other
    CARDIO = "cardio"
    OTHER = "other"


@dataclass
class Exercise:
    """An exercise definition."""

    id: int | None = None
    name: str = ""
    category: ExerciseCategory = ExerciseCategory.OTHER
    primary_muscle: MuscleGroup = MuscleGroup.FULL_BODY
    secondary_muscles: list[MuscleGroup] = field(default_factory=list)
    equipment: str | None = None  # 'barbell', 'dumbbell', 'cable', 'bodyweight'
    is_unilateral: bool = False
    notes: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for DB insertion."""
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category.value,
            "primary_muscle": self.primary_muscle.value,
            "secondary_muscles_json": json.dumps(
                [m.value for m in self.secondary_muscles]
            ),
            "equipment": self.equipment,
            "is_unilateral": self.is_unilateral,
            "notes": self.notes,
        }


@dataclass
class ExerciseSet:
    """A single set within an exercise."""

    id: int | None = None
    session_exercise_id: int | None = None  # FK to session_exercises
    set_number: int = 1
    reps: int = 0
    weight_kg: float | None = None
    rpe: float | None = None  # 1-10 scale
    rir: int | None = None  # Reps In Reserve (alternative to RPE)
    rest_sec: int | None = None  # Rest after this set
    tempo: str | None = None  # e.g., "3-1-1-0" (eccentric-pause-concentric-pause)
    is_warmup: bool = False
    is_failure: bool = False
    notes: str | None = None

    @property
    def volume(self) -> float:
        """Calculate set volume (reps × weight)."""
        return self.reps * (self.weight_kg or 0)

    @property
    def estimated_1rm(self) -> float | None:
        """Estimate 1RM using Epley formula."""
        if not self.weight_kg or self.reps == 0:
            return None
        from arete.features.strength import estimate_1rm_epley

        return estimate_1rm_epley(self.weight_kg, self.reps)

    @property
    def rpe_from_rir(self) -> float | None:
        """Convert RIR to RPE (10 - RIR)."""
        if self.rir is None:
            return None
        return 10 - self.rir

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for DB insertion."""
        return {
            "id": self.id,
            "session_exercise_id": self.session_exercise_id,
            "set_number": self.set_number,
            "reps": self.reps,
            "weight_kg": self.weight_kg,
            "rpe": self.rpe,
            "rir": self.rir,
            "rest_sec": self.rest_sec,
            "tempo": self.tempo,
            "is_warmup": self.is_warmup,
            "is_failure": self.is_failure,
            "notes": self.notes,
        }


@dataclass
class SessionExercise:
    """An exercise performed in a session with its sets."""

    id: int | None = None
    session_id: int | None = None
    exercise_id: int | None = None
    exercise: Exercise | None = None  # Populated when fetching
    order: int = 1
    target_sets: int | None = None
    target_reps: str | None = None  # e.g., "8-12" or "5"
    target_rpe: float | None = None
    sets: list[ExerciseSet] = field(default_factory=list)
    notes: str | None = None

    @property
    def total_volume(self) -> float:
        """Total volume across all working sets."""
        return sum(s.volume for s in self.sets if not s.is_warmup)

    @property
    def working_sets_count(self) -> int:
        """Number of working (non-warmup) sets."""
        return sum(1 for s in self.sets if not s.is_warmup)

    @property
    def avg_rpe(self) -> float | None:
        """Average RPE across working sets."""
        rpes = [s.rpe for s in self.sets if s.rpe and not s.is_warmup]
        return sum(rpes) / len(rpes) if rpes else None

    @property
    def top_set(self) -> ExerciseSet | None:
        """Get the heaviest working set."""
        working = [s for s in self.sets if not s.is_warmup and s.weight_kg]
        return max(working, key=lambda s: s.weight_kg or 0) if working else None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for DB insertion."""
        return {
            "id": self.id,
            "session_id": self.session_id,
            "exercise_id": self.exercise_id,
            "order": self.order,
            "target_sets": self.target_sets,
            "target_reps": self.target_reps,
            "target_rpe": self.target_rpe,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class StrengthSessionSummary:
    """A session's list row: the totals of ``StrengthSession``, computed in SQL.

    Working sets are those not marked warm-up; muscles are the exercises'
    primary ones (secondary muscles do not count), sorted.
    """

    id: int
    date: date
    name: str | None
    program: str | None
    duration_min: int | None
    overall_rpe: float | None
    exercises_count: int
    total_sets: int
    total_volume: float
    muscles_worked: list[str]
    #: Catalog names in session order.
    exercise_names: list[str] = field(default_factory=list)
    actual_session_id: int | None = None


@dataclass
class StrengthSession:
    """A complete strength training session."""

    id: int | None = None
    user_id: int | None = None
    date: date = field(default_factory=date.today)
    name: str | None = None  # e.g., "Push Day", "Upper A"
    program: str | None = None  # e.g., "PPL", "531", "GZCLP"
    duration_min: int | None = None
    overall_rpe: float | None = None  # Session RPE (1-10)
    fatigue_level: int | None = None  # Pre-workout fatigue (1-5)
    sleep_quality: int | None = None  # Night before (1-5)
    notes: str | None = None
    exercises: list[SessionExercise] = field(default_factory=list)
    created_at: datetime | None = None
    actual_session_id: int | None = None  # Link to app.actual_sessions.id

    @property
    def total_volume(self) -> float:
        """Total session volume (all exercises)."""
        return sum(ex.total_volume for ex in self.exercises)

    @property
    def total_sets(self) -> int:
        """Total working sets in session."""
        return sum(ex.working_sets_count for ex in self.exercises)

    @property
    def muscles_worked(self) -> list[MuscleGroup]:
        """List of primary muscles worked."""
        muscles = set()
        for ex in self.exercises:
            if ex.exercise:
                muscles.add(ex.exercise.primary_muscle)
        return list(muscles)

    @property
    def inol(self) -> float | None:
        """Calculate session INOL (Intensity × Number Of Lifts).

        INOL = Σ (reps / (100 - intensity%))
        Only for main compound lifts with known 1RM.
        """
        # This would require 1RM data - placeholder for now
        return None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for DB insertion."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "date": self.date,
            "name": self.name,
            "program": self.program,
            "duration_min": self.duration_min,
            "overall_rpe": self.overall_rpe,
            "fatigue_level": self.fatigue_level,
            "sleep_quality": self.sleep_quality,
            "notes": self.notes,
        }

    def to_summary(self) -> dict[str, Any]:
        """Return a summary for API responses."""
        return {
            "id": self.id,
            "date": str(self.date),
            "name": self.name,
            "program": self.program,
            "duration_min": self.duration_min,
            "exercises_count": len(self.exercises),
            "total_sets": self.total_sets,
            "total_volume": round(self.total_volume, 1),
            "overall_rpe": self.overall_rpe,
            "muscles_worked": [m.value for m in self.muscles_worked],
        }


@dataclass(frozen=True)
class GarminExerciseSummary:
    """One line of Garmin's summary of a strength activity: no load, ever.

    Garmin's own keys: ``category`` (``BENCH_PRESS``) and, when the watch knew
    better, ``sub_category`` (``BARBELL_BENCH_PRESS``). ``reps`` is the total
    over the ``sets``; either count is missing when the watch did not count.
    """

    category: str
    sub_category: str | None = None
    sets: int | None = None
    reps: int | None = None


@dataclass(frozen=True)
class DraftExercise:
    """An exercise a draft starts from: catalog-matched, or free text to confirm."""

    name: str
    exercise_id: str | None = None  # catalog id when the name was recognised
    sets: int | None = None
    reps: int | None = None  # per set, rounded from Garmin's total

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "exercise_id": self.exercise_id,
            "sets": self.sets,
            "reps": self.reps,
        }


@dataclass(frozen=True)
class StrengthDraft:
    """A Garmin strength activity awaiting its loads (``app.strength_drafts``).

    Not a session: nothing reads it but the Journal. Completing it saves a
    Muscu log linked to the activity, and the pair is the one session.
    """

    id: int
    actual_session_id: int
    date: date
    activity_name: str | None
    duration_sec: int | None
    exercises: list[DraftExercise]
    origin: str  # 'import' (Garmin sync) or 'journal' (opened by the athlete)
    created_at: datetime | None = None
