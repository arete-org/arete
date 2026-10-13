"""Record complete dictated workouts through the deterministic domain parser."""

from __future__ import annotations

import json
from datetime import date
from typing import Annotated, Any

from langchain_core.tools import BaseTool
from pydantic import Field

from arete.agent.runtime.budget import MAX_TOOL_OUTPUT_CHARS
from arete.agent.tools.validation import typed_tool

#: Enough for a long session; past it the text is not a workout.
MAX_WORKOUT_TEXT_CHARS = 4_000
#: An exercise name, not a paragraph.
MAX_EXERCISE_NAME_CHARS = 100


def _out(payload: Any) -> str:
    rendered = json.dumps(payload, ensure_ascii=False, default=str)
    if len(rendered) > MAX_TOOL_OUTPUT_CHARS:
        return json.dumps({"error": f"Result too large ({len(rendered)} chars)."})
    return rendered


def _error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _checked(text: str, date_str: str) -> tuple[str, date | None] | str:
    """Validated (text, date), or an error payload."""
    if not text or not text.strip():
        return _error("text is empty; give the session as the athlete said it")
    if len(text) > MAX_WORKOUT_TEXT_CHARS:
        return _error(
            f"text too long ({len(text)} chars, max {MAX_WORKOUT_TEXT_CHARS})"
        )
    if not date_str:
        return text, None
    try:
        return text, date.fromisoformat(date_str)
    except ValueError:
        return _error(f"date_str must be YYYY-MM-DD, got {date_str!r}")


def _summarize(parsed: Any) -> dict[str, Any]:
    from arete.strength.logging_service import dropped_exercises

    dropped = dropped_exercises(parsed)
    return {
        "date": parsed.date.isoformat(),
        "name": parsed.name,
        "duration_min": parsed.duration_min,
        "overall_rpe": parsed.overall_rpe,
        "exercises": [
            {
                "name": exercise.name,
                "matched": exercise.exercise_id is not None,
                "sets": [
                    {
                        "reps": s.reps,
                        "weight_kg": s.weight_kg,
                        "rpe": s.rpe,
                        "rir": s.rir,
                        "warmup": s.is_warmup,
                    }
                    for s in exercise.sets
                ],
            }
            for exercise in parsed.exercises
        ],
        "not_recognised": [
            {"name": d.name, "did_you_mean": d.suggestions} for d in dropped
        ],
        "unparsed_lines": parsed.unparsed_lines,
    }


@typed_tool
def save_workout(
    text: Annotated[str, Field(min_length=1, max_length=4000)],
    date_str: date | None = None,
) -> str:
    """Save a completed strength workout in one call, only if every line and exercise is recognized.

    Pass the athlete's exact words. Missing date means today. A rejected parse writes nothing;
    use its unparsed_lines and not_recognised suggestions to ask for a correction.
    """
    checked = _checked(text, date_str.isoformat() if date_str else "")
    if isinstance(checked, str):
        return checked
    workout_text, workout_date = checked
    try:
        from arete.strength.logging_service import (
            parse_for_athlete,
            save_parsed_session,
        )

        parsed = parse_for_athlete(workout_text, workout_date=workout_date)
        outcome = save_parsed_session(parsed, require_complete=True)
    except ValueError as exc:
        return _error(f"Nothing readable as an exercise: {exc}")
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")

    if outcome.session_id is None:
        return _out({"error": outcome.message, "saved": False, **_summarize(parsed)})
    return _out(
        {
            "saved": True,
            "session_id": outcome.session_id,
            "saved_exercises": outcome.saved,
            "message": outcome.message,
            "personal_records": [r.as_dict() for r in outcome.records],
            **{
                k: v
                for k, v in _summarize(parsed).items()
                if k in ("date", "name", "not_recognised", "unparsed_lines")
            },
        }
    )


@typed_tool
def list_strength_sessions(date_str: date | None = None) -> str:
    """Strength sessions already logged on one day: session_id, name and sets.

    Missing date means today. Read it before correcting a logged session.
    """
    try:
        from arete.strength.logging_service import logged_sessions

        return _out({"sessions": logged_sessions(date_str)})
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")


@typed_tool
def update_workout(
    session_id: Annotated[int, Field(gt=0)],
    text: Annotated[str, Field(min_length=1, max_length=4000)],
) -> str:
    """Correct a logged strength session in place: same id and date, no new session.

    Pass the complete corrected session (every exercise and set): it replaces the
    session's exercises. A rejected parse or an unknown session_id writes nothing.
    """
    checked = _checked(text, "")
    if isinstance(checked, str):
        return checked
    try:
        from arete.strength.logging_service import update_logged_session

        outcome = update_logged_session(session_id, checked[0])
    except ValueError as exc:
        return _error(f"Nothing readable as an exercise: {exc}")
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")

    if outcome.session_id is None:
        return _out(
            {
                "error": outcome.message,
                "saved": False,
                "not_recognised": [
                    {"name": d.name, "did_you_mean": d.suggestions}
                    for d in outcome.dropped
                ],
                "unparsed_lines": outcome.unparsed_lines,
            }
        )
    return _out(
        {
            "saved": True,
            "session_id": outcome.session_id,
            "saved_exercises": outcome.saved,
            "message": outcome.message,
            "personal_records": [r.as_dict() for r in outcome.records],
        }
    )


@typed_tool
def get_strength_progress(
    exercise: Annotated[str, Field(min_length=1, max_length=100)],
) -> str:
    """Progression of one strength exercise: e1RM trend (last sessions),
    personal records and the next-session load. `next_session` is computed
    by fixed rules (double progression, RIR/RPE) and becomes a deload when
    today's readiness is low; quote its numbers and `reason`, never invent
    a load. Warm-up sets are excluded everywhere.

    Args:
        exercise: The exercise as the athlete names it ("squat", "développé couché").
    """
    if not exercise or not exercise.strip():
        return _error("exercise is empty; name the exercise")
    if len(exercise) > MAX_EXERCISE_NAME_CHARS:
        return _error(f"exercise name too long (max {MAX_EXERCISE_NAME_CHARS})")
    try:
        from arete.services.strength_progress import strength_progress

        return _out(strength_progress(exercise.strip()))
    except Exception as exc:
        return _error(f"{type(exc).__name__}: {exc}")


STRENGTH_TOOLS: list[BaseTool] = [
    save_workout,
    list_strength_sessions,
    update_workout,
    get_strength_progress,
]
