"""Workout text parser: deterministic grammar + semantic exercise matching.

Parses free-text workout logs into structured session data.
Example input:
    Bench press 4x8 80kg
    4x10 @60 incline db press r2'
    5x(8-10 pull ups @20kg, 15 dips) r1'30

Pipeline (see ``parse_workout_text``):
1. extract an optional leading date, normalize typos, expand user abbreviations;
2. parse every line with the Lark grammar (``arete.llm.workout_grammar``);
3. match exercise names against the catalog (``arete.data.exercise_matcher``),
   keeping suggestions for the names that are not confidently matched;
4. report the lines the grammar rejected so the user can fix them.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date

from arete.data.exercise_matcher import Suggestion, match_exercise
from arete.llm.speech_grammar import parse_dictation
from arete.llm.workout_grammar import parse_workout_grammar, unparsed_lines

logger = logging.getLogger(__name__)


@dataclass
class ParsedSet:
    """A parsed set from workout text."""

    set_number: int
    reps: int | None = None  # None for failure sets
    weight_kg: float | None = None
    rpe: float | None = None
    is_warmup: bool = False
    is_failure: bool = False
    rest_sec: int | None = None  # Rest time after set (parsed from r2', r1'30)
    rir: int | None = None  # Reps in reserve ("RIR 2")
    tempo: str | None = None  # "3-1-1-0" (eccentric-pause-concentric-pause)


@dataclass
class ParsedExercise:
    """A parsed exercise from workout text."""

    name: str
    exercise_id: str | None  # Matched ID from catalog (None when not confident)
    sets: list[ParsedSet]
    notes: str | None = None
    target_reps: str | None = None  # Rep range like "8-10" or "5"
    match_score: int = 0
    suggestions: list[Suggestion] = field(default_factory=list)


@dataclass
class ParsedWorkout:
    """Complete parsed workout."""

    date: date
    name: str | None
    exercises: list[ParsedExercise]
    duration_min: int | None = None
    overall_rpe: float | None = None
    notes: str | None = None
    unparsed_lines: list[str] = field(default_factory=list)


def _extract_date_from_text(text: str) -> tuple[date | None, str]:
    """Extract date from beginning of workout text.

    Supports formats:
    - "05/12/25:" or "05/12/2025:" (DD/MM/YY or DD/MM/YYYY)
    - "2025-12-05:" (ISO format)
    - "05-12-25:" (DD-MM-YY)

    Returns:
        Tuple of (extracted_date or None, text_without_date_line)
    """
    lines = text.strip().split("\n")
    if not lines:
        return None, text

    first_line = lines[0].strip()

    # Pattern: DD/MM/YY: or DD/MM/YYYY: at start of text, optionally followed
    # by the first exercise on the same line ("05/12/25: Bench press 4x8 80kg")
    # The tail is sliced, not matched: overlapping `\s*` around the colon
    # would backtrack quadratically on a line of spaces.
    date_pattern = r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})"
    match = re.match(date_pattern, first_line)

    if match:
        day = int(match.group(1))
        month = int(match.group(2))
        year = int(match.group(3))

        # Handle 2-digit years
        if year < 100:
            year += 2000 if year < 50 else 1900

        try:
            extracted_date = date(year, month, day)
            # Return text without the date prefix
            rest_of_line = first_line[match.end() :].lstrip().removeprefix(":").strip()
            remaining_lines = ([rest_of_line] if rest_of_line else []) + lines[1:]
            return extracted_date, "\n".join(remaining_lines)
        except ValueError:
            pass  # Invalid date, continue with original text

    return None, text


def _normalize_workout_text(text: str) -> str:
    """Normalize common typos and shorthand in workout text.

    Fixes:
    - r'130 → r1'30 (rest typo: apostrophe before digits)
    - r'230 → r2'30
    - Curly/smart quotes → straight quotes
    """
    result = text
    # Normalize smart quotes to straight
    result = result.replace("\u2019", "'").replace("\u2018", "'")

    # Fix rest typo: r'NNN → rN'NN (3+ digit rest after apostrophe)
    # e.g., r'130 → r1'30, r'230 → r2'30
    result = re.sub(
        r"\br'(\d)(\d{2})\b",
        r"r\1'\2",
        result,
    )

    return result


def _expand_abbreviations(text: str, abbreviations: dict[str, str]) -> str:
    """Expand user abbreviations in workout text.

    Uses word-boundary matching to avoid partial replacements.
    Longer abbreviations are expanded first to prevent conflicts.
    """
    if not abbreviations:
        return text

    result = text
    # Sort by length descending to expand longer abbreviations first
    for abbrev, full in sorted(
        abbreviations.items(), key=lambda x: len(x[0]), reverse=True
    ):
        pattern = r"\b" + re.escape(abbrev) + r"\b"
        result = re.sub(pattern, full, result, flags=re.IGNORECASE)
    return result


def _read_lines(text: str) -> list[dict]:
    """Notation first, plain French second.

    A line the notation grammar rejects gets a second reading by the speech
    grammar, so "squat 5 séries de 5 à 100 kilos" works typed as well as
    dictated. Order matters: notation is what most lines are.
    """
    read = parse_workout_grammar(text) or []
    spoken = [
        exercise
        for line in unparsed_lines(text)
        for exercise in parse_dictation(line) or []
    ]
    return read + spoken


def parse_workout_text(
    text: str,
    workout_date: date | None = None,
    abbreviations: dict[str, str] | None = None,
) -> ParsedWorkout:
    """Parse workout text into structured data.

    Deterministic: the Lark grammar structures every line it recognises,
    ``match_exercise`` resolves names against the catalog. Lines the grammar
    rejects are returned in ``unparsed_lines`` for the user to correct.

    Args:
        text: Free-form workout text (can start with a date like "05/12/25:")
        workout_date: Date of workout (defaults to extracted date or today)
        abbreviations: User-defined abbreviation mapping (e.g. {"bp": "bench press"})

    Raises:
        ValueError: when no exercise could be extracted at all.
    """
    extracted_date, text = _extract_date_from_text(text)
    if workout_date is None:
        workout_date = extracted_date or date.today()

    text = _expand_abbreviations(_normalize_workout_text(text), abbreviations or {})

    exercises: list[ParsedExercise] = []
    for ex in _read_lines(text):
        match = match_exercise(ex["name"])
        exercises.append(
            ParsedExercise(
                name=ex["name"],
                exercise_id=match.exercise_id,
                sets=[ParsedSet(**st) for st in ex["sets"]],
                notes=ex["notes"],
                target_reps=ex["target_reps"],
                match_score=match.score,
                suggestions=match.suggestions,
            )
        )
    leftovers = [line for line in unparsed_lines(text) if not parse_dictation(line)]
    logger.info(
        "Grammar parsed %d exercises, %d unparsed line(s)",
        len(exercises),
        len(leftovers),
    )

    if not exercises:
        raise ValueError("Failed to parse workout text: no exercises found")

    return ParsedWorkout(
        date=workout_date,
        name=None,
        exercises=exercises,
        unparsed_lines=leftovers,
    )
