"""Turning workout text into a saved session, for the route and the agent alike.

This used to live inside ``POST /strength/sessions/parse``. The coaching agent
needs the same behaviour — the athlete's abbreviations, the catalog matching,
the planned session completed on save — and a second copy would have drifted
from the first within a month.

One thing changes in the move: an exercise the catalog could not match was
silently skipped on the way in, leaving no trace of what was lost. It is
reported now. That was tolerable when a human was looking at the form; it is
not when an agent is dictating and the athlete only reads a sentence.
"""

from __future__ import annotations

import logging
from collections.abc import Collection
from dataclasses import dataclass, field, replace
from datetime import date as date_type
from typing import TYPE_CHECKING

from arete.services.athlete_scope import resolve_athlete_id
from arete.strength.models import ExerciseSet, SessionExercise, StrengthSession
from arete.strength.progression import Record, new_records
from arete.strength.repository import StrengthRepository

if TYPE_CHECKING:
    # The grammars are built at import; only parsing needs them, not boot.
    from arete.llm.workout_parser import ParsedWorkout

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DroppedExercise:
    """An exercise the catalog would not confidently match, and its near misses."""

    name: str
    suggestions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SessionRecord:
    """A personal record set by the session just saved."""

    exercise_id: int
    exercise: str
    record: Record

    def as_dict(self) -> dict:
        return {
            "exercise_id": self.exercise_id,
            "exercise": self.exercise,
            **self.record.as_dict(),
        }


@dataclass(frozen=True)
class SaveOutcome:
    """What a save actually did — including what it refused to write."""

    session_id: int | None
    saved: list[str] = field(default_factory=list)
    dropped: list[DroppedExercise] = field(default_factory=list)
    message: str = ""
    records: list[SessionRecord] = field(default_factory=list)


def athlete_abbreviations(user_id: int | None = None) -> dict[str, str]:
    """The athlete's own shorthand, e.g. ``{"bp": "bench press"}``."""
    user_id = resolve_athlete_id(user_id)
    from arete.dataio.settings import get_user_settings

    settings = get_user_settings(user_id=user_id)
    return settings.get("exercise_abbreviations", {}) if settings else {}


def parse_for_athlete(
    text: str, workout_date: date_type | None = None, user_id: int | None = None
) -> ParsedWorkout:
    """Read workout text with the athlete's abbreviations applied.

    Deterministic — Lark grammar plus catalog matching, no model. Raises
    ValueError when nothing in the text looks like an exercise.
    """
    user_id = resolve_athlete_id(user_id)
    from arete.llm.workout_parser import parse_workout_text
    from arete.services.settings import athlete_today

    return parse_workout_text(
        text=text,
        workout_date=workout_date,
        abbreviations=athlete_abbreviations(user_id),
        today=athlete_today() if workout_date is None else None,
    )


def dropped_exercises(parsed: ParsedWorkout) -> list[DroppedExercise]:
    """Exercises that would not be saved, because nothing matched them."""
    return [
        DroppedExercise(
            name=exercise.name,
            suggestions=[s.name for s in exercise.suggestions[:3]],
        )
        for exercise in parsed.exercises
        if exercise.exercise_id is None
    ]


def save_parsed_session(
    parsed: ParsedWorkout,
    repo: StrengthRepository | None = None,
    *,
    require_complete: bool = False,
) -> SaveOutcome:
    """Persist a parsed workout. Reports what went in and what did not.

    Never raises: a save that fails comes back as a message, because the
    parsing result is still worth showing.
    """
    repo = repo or StrengthRepository()
    dropped = dropped_exercises(parsed)

    if require_complete and (dropped or parsed.unparsed_lines):
        return SaveOutcome(
            session_id=None,
            dropped=dropped,
            message="Séance non enregistrée : corrige les éléments non reconnus.",
        )

    session = StrengthSession(
        date=parsed.date,
        name=parsed.name,
        duration_min=parsed.duration_min,
        overall_rpe=parsed.overall_rpe,
        notes=parsed.notes,
    )
    saved: list[str] = []

    try:
        for index, parsed_exercise in enumerate(parsed.exercises):
            if not parsed_exercise.exercise_id:
                continue
            exercise = repo.get_or_create_exercise_from_catalog(
                parsed_exercise.exercise_id
            )
            if exercise is None:
                if require_complete:
                    return SaveOutcome(
                        session_id=None,
                        message=f"Exercice indisponible : {parsed_exercise.name}",
                    )
                dropped.append(DroppedExercise(name=parsed_exercise.name))
                continue
            session_exercise = SessionExercise(
                exercise_id=exercise.id,
                exercise=exercise,
                order=index + 1,
            )
            for parsed_set in parsed_exercise.sets:
                session_exercise.sets.append(
                    ExerciseSet(
                        set_number=parsed_set.set_number,
                        reps=parsed_set.reps if parsed_set.reps is not None else 0,
                        weight_kg=parsed_set.weight_kg,
                        rpe=parsed_set.rpe,
                        rir=parsed_set.rir,
                        rest_sec=parsed_set.rest_sec,
                        tempo=parsed_set.tempo,
                        is_warmup=parsed_set.is_warmup,
                        is_failure=parsed_set.is_failure,
                    )
                )
            session.exercises.append(session_exercise)
            saved.append(exercise.name)

        if not session.exercises:
            return SaveOutcome(
                session_id=None,
                dropped=dropped,
                message="No exercises matched - session not saved",
            )

        session_id = repo.create_session(session)
        complete_planned_strength(session.date)
        link_garmin_strength(repo, [session.date])
    except Exception as exc:  # noqa: BLE001 - the parse is still worth returning
        logger.error("Failed to save parsed session: %s", exc)
        return SaveOutcome(
            session_id=None,
            dropped=dropped,
            message=f"Parsing succeeded but save failed: {exc}",
        )

    message = f"Session saved with {len(session.exercises)} exercises"
    if dropped:
        message += f"; {len(dropped)} not recognised and left out"
    return SaveOutcome(
        session_id=session_id,
        saved=saved,
        dropped=dropped,
        message=message,
        records=session_records(repo, session_id, session),
    )


def session_records(
    repo: StrengthRepository, session_id: int, session: StrengthSession
) -> list[SessionRecord]:
    """The personal records the saved session beat, against every other one.

    Never raises: a failed comparison costs the celebration, not the save.
    """
    names = {
        ex.exercise_id: ex.exercise.name
        for ex in session.exercises
        if ex.exercise_id is not None and ex.exercise is not None
    }
    try:
        history = repo.working_sessions(list(names))
    except Exception as exc:  # noqa: BLE001 - the session is already saved
        logger.warning("Could not compare session %s to records: %s", session_id, exc)
        return []
    found: list[SessionRecord] = []
    for exercise_id, name in names.items():
        sessions = history.get(exercise_id, [])
        current = [s for s in sessions if s.session_id == session_id]
        previous = [s for s in sessions if s.session_id != session_id]
        if not current:
            continue
        # An exercise logged twice in one session is one performance.
        done = replace(current[0], sets=[st for s in current for st in s.sets])
        found.extend(
            SessionRecord(exercise_id, name, record)
            for record in new_records(previous, done)
        )
    return found


def complete_planned_strength(day: date_type) -> None:
    """A logged strength session fulfils the planned strength session of that day."""
    from arete.garmin.repository import GarminRepository
    from arete.garmin.sync import complete_planned

    try:
        complete_planned(GarminRepository(), day, "strength")
    except Exception as e:  # noqa: BLE001 - never block the save
        logger.warning("Could not update planned session for %s: %s", day, e)


def link_garmin_strength(repo: StrengthRepository, days: Collection[date_type]) -> None:
    """Pair each day's lone Muscu log with its lone Garmin strength activity.

    Runs when a log is saved and after a Garmin sync, whichever comes second.
    Never raises: a failed link leaves the manual link, not a failed save.
    """
    try:
        linked = repo.link_lone_garmin_pairs(days)
    except Exception as e:  # noqa: BLE001 - never block the save or the sync
        logger.warning("Could not link strength logs to Garmin activities: %s", e)
        return
    if linked:
        logger.info("Linked %d strength logs to their Garmin activity", len(linked))
