"""Strength progression for the pages and the coach: trend, records, next load.

``strength.progression`` owns the rules; this module feeds them the stored
sets and today's readiness (``services.metrics``), so the Log page, the
progress view and the coach's ``get_strength_progress`` read one answer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING, Any

from arete.services.settings import athlete_today
from arete.strength.models import Exercise, ExerciseCategory
from arete.strength.progression import (
    ExerciseSession,
    Suggestion,
    all_time_records,
    suggest_next,
)
from arete.strength.repository import StrengthRepository

if TYPE_CHECKING:
    from arete.llm.workout_parser import ParsedWorkout

logger = logging.getLogger(__name__)

#: Squats and hinges take the bigger load increment.
LOWER_BODY = frozenset({ExerciseCategory.SQUAT, ExerciseCategory.HINGE})
#: Points of the coach's trend: enough to see a direction, little to read.
COACH_TREND_POINTS = 8
#: Rep records the coach and the page list: the heaviest loads.
REP_RECORDS_SHOWN = 5


@dataclass(frozen=True)
class DayReadiness:
    score: float
    source: str
    level: str

    def as_dict(self) -> dict[str, Any]:
        return {"score": self.score, "source": self.source, "level": self.level}


def today_readiness(today: date | None = None) -> DayReadiness | None:
    """Today's readiness, or None when it cannot be read (never raises)."""
    from arete.services.metrics import load_form

    try:
        _, readiness = load_form(today)
    except Exception as exc:  # noqa: BLE001 - a suggestion without deload
        logger.warning("Readiness unavailable for strength suggestions: %s", exc)
        return None
    if readiness is None:
        return None
    return DayReadiness(readiness.score, readiness.source, readiness.level)


def is_lower_body(exercise: Exercise | None) -> bool:
    return exercise is not None and exercise.category in LOWER_BODY


def suggestion_for(
    exercise: Exercise,
    sessions: list[ExerciseSession],
    readiness: DayReadiness | None,
) -> Suggestion | None:
    """Next-session suggestion from the latest of ``sessions``."""
    if not sessions:
        return None
    return suggest_next(
        sessions[-1],
        lower_body=is_lower_body(exercise),
        readiness=readiness.score if readiness else None,
    )


def exercise_suggestion(
    exercise: Exercise, repo: StrengthRepository | None = None
) -> dict[str, Any]:
    """``GET /strength/exercises/{id}/suggestion``: the load for next time."""
    repo = repo or StrengthRepository()
    assert exercise.id is not None
    sessions = repo.working_sessions([exercise.id]).get(exercise.id, [])
    readiness = today_readiness() if sessions else None
    suggestion = suggestion_for(exercise, sessions, readiness)
    return {
        "suggestion": suggestion.as_dict() if suggestion else None,
        "readiness": readiness.as_dict() if readiness else None,
    }


def suggestions_for_parsed(
    parsed: ParsedWorkout, repo: StrengthRepository | None = None
) -> dict[str, dict[str, Any]]:
    """What was suggested for this session, per catalog id of the preview.

    Only sessions before the logged day count, and the readiness applies only
    when the session is today's: a backdated session had its own morning.
    """
    repo = repo or StrengthRepository()
    exercises: dict[str, Exercise] = {}
    for parsed_exercise in parsed.exercises:
        cid = parsed_exercise.exercise_id
        if cid and cid not in exercises:
            found = repo.get_exercise_by_catalog_id(cid)
            if found is not None and found.id is not None:
                exercises[cid] = found
    if not exercises:
        return {}
    history = repo.working_sessions(
        [e.id for e in exercises.values() if e.id is not None], before=parsed.date
    )
    readiness = (
        today_readiness(parsed.date)
        if history and parsed.date == athlete_today()
        else None
    )
    out: dict[str, dict[str, Any]] = {}
    for cid, exercise in exercises.items():
        assert exercise.id is not None
        suggestion = suggestion_for(exercise, history.get(exercise.id, []), readiness)
        if suggestion is not None:
            out[cid] = suggestion.as_dict()
    return out


def history_points(
    exercise_id: int, repo: StrengthRepository | None = None
) -> dict[int, dict[str, Any]]:
    """Best e1RM and top set per session-exercise id, for ``/history``."""
    repo = repo or StrengthRepository()
    points: dict[int, dict[str, Any]] = {}
    for session in repo.working_sessions([exercise_id]).get(exercise_id, []):
        if session.session_exercise_id is None:
            continue
        top = session.top_set
        best = session.best_e1rm
        points[session.session_exercise_id] = {
            "best_e1rm": round(best, 1) if best is not None else None,
            "top_weight": top.weight_kg if top else None,
            "top_reps": top.reps if top else None,
        }
    return points


def records_summary(sessions: list[ExerciseSession]) -> dict[str, Any]:
    """Best e1RM and the most reps at the heaviest loads, with their dates."""
    best = all_time_records(sessions)
    reps = sorted(best.reps_by_weight.values(), key=lambda r: -(r.weight_kg or 0))
    return {
        "best_e1rm": best.best_e1rm.as_dict() if best.best_e1rm else None,
        "heaviest": best.heaviest.as_dict() if best.heaviest else None,
        "rep_records": [r.as_dict() for r in reps[:REP_RECORDS_SHOWN]],
    }


def resolve_exercise(
    name: str, repo: StrengthRepository | None = None
) -> Exercise | None:
    """A logged exercise from what the athlete or the coach calls it."""
    from arete.data.exercise_matcher import match_exercise

    repo = repo or StrengthRepository()
    exact = repo.get_exercise_by_name(name)
    if exact is not None:
        return exact
    match = match_exercise(name)
    if match.exercise_id:
        return repo.get_exercise_by_catalog_id(match.exercise_id)
    return None


def strength_progress(
    name: str, repo: StrengthRepository | None = None
) -> dict[str, Any]:
    """The coach's compact read: trend, records and next load of one exercise."""
    repo = repo or StrengthRepository()
    exercise = resolve_exercise(name, repo)
    if exercise is None or exercise.id is None:
        return {"error": f"No logged exercise matches {name!r}."}
    sessions = repo.working_sessions([exercise.id]).get(exercise.id, [])
    if not sessions:
        return {"exercise": exercise.name, "sessions_logged": 0}
    readiness = today_readiness()
    suggestion = suggestion_for(exercise, sessions, readiness)
    trend = []
    for session in sessions[-COACH_TREND_POINTS:]:
        top = session.top_set
        best = session.best_e1rm
        trend.append(
            {
                "date": session.date.isoformat(),
                "e1rm": round(best, 1) if best is not None else None,
                "top_set": f"{top.weight_kg or 0:g}kg x {top.reps}" if top else None,
            }
        )
    return {
        "exercise": exercise.name,
        "exercise_id": exercise.id,
        "sessions_logged": len(sessions),
        "trend": trend,
        "records": records_summary(sessions),
        "next_session": suggestion.as_dict() if suggestion else None,
        "readiness": readiness.as_dict() if readiness else None,
    }
