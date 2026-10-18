"""Garmin strength activities as sessions awaiting their loads (ARE-132).

The watch recognises exercises and counts sets and reps, never the kilos. An
imported strength activity no Muscu log completes gets a draft holding what
Garmin recognised; the athlete adds the loads in the Log's notation (typed or
dictated, read by the grammar, no model) and the draft becomes a Muscu log
linked to the activity: one session, as any linked pair (ARE-97).

A draft is not a session. Nothing but the Journal reads it: until it is
completed, the Garmin activity alone counts (load, gamification, the week's
facts, the missed-session check, which already counts that activity by its own
rules), and the muscle map and weekly volume have no sets to add. Once
completed, the log counts as every linked log does.

Backfill: an import opens a draft only for an activity of the last
``DRAFT_WINDOW_DAYS`` days, so a first full-history import (hundreds of old
activities) does not flood the Journal. An older unlinked activity gets its
draft when the athlete asks for it (« Ajoute tes charges »), one at a time.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import date as date_type

from arete.strength.logging_service import (
    SaveOutcome,
    _session_exercises,
    complete_planned_strength,
    dropped_exercises,
    parse_for_athlete,
    session_records,
)
from arete.strength.models import (
    DraftExercise,
    GarminExerciseSummary,
    StrengthDraft,
    StrengthSession,
)
from arete.strength.repository import StrengthRepository

logger = logging.getLogger(__name__)

#: An import opens a draft for an activity of today or the six days before.
DRAFT_WINDOW_DAYS = 7
#: A draft holds at most this many of Garmin's exercises.
MAX_DRAFT_EXERCISES = 20


class DraftNotFound(LookupError):
    """No draft of this athlete has this id."""


class DraftSettled(RuntimeError):
    """The draft is no longer awaiting loads: completed, dismissed or logged."""


def draft_exercises(summaries: Iterable[GarminExerciseSummary]) -> list[DraftExercise]:
    """Garmin's names through the catalog: French name when recognised, else as is.

    The finer name is tried first, then the category. An unrecognised name
    stays as free text the athlete confirms when the session is read back;
    Garmin's ``UNKNOWN`` carries no name and is left out.
    """
    from arete.data.exercise_matcher import match_exercise
    from arete.data.exercises_catalog import EXERCISES_BY_ID

    exercises: list[DraftExercise] = []
    for summary in summaries:
        keys = [
            key.replace("_", " ").strip().lower()
            for key in (summary.sub_category, summary.category)
            if key and key.strip() and key.strip().upper() != "UNKNOWN"
        ]
        if not keys:
            continue
        catalog_id = next(
            (found for key in keys if (found := match_exercise(key).exercise_id)),
            None,
        )
        name = EXERCISES_BY_ID[catalog_id]["name_fr"] if catalog_id else keys[0]
        sets = summary.sets if summary.sets and summary.sets > 0 else None
        reps = round(summary.reps / sets) if sets and summary.reps else None
        exercises.append(DraftExercise(name, catalog_id, sets, reps or None))
        if len(exercises) == MAX_DRAFT_EXERCISES:
            break
    return exercises


def draft_notation(exercises: Iterable[DraftExercise]) -> str:
    """The Log's text a draft opens with: one line per exercise, loads to add.

    ``Développé couché 3x10`` reads back as the same catalog exercise; the
    athlete appends ``@80``. A line without counts is the name alone.
    """
    return "\n".join(
        f"{e.name} {e.sets}x{e.reps}" if e.sets and e.reps else e.name
        for e in exercises
    )


def open_garmin_draft(
    actual_session_id: int,
    day: date_type,
    summaries: Iterable[GarminExerciseSummary],
    *,
    today: date_type | None = None,
) -> int | None:
    """Open the draft of a just-imported strength activity; never raises.

    Only for an activity of the last ``DRAFT_WINDOW_DAYS`` days that no log
    completes. Idempotent: a re-import finds the existing draft.
    """
    try:
        from arete.services.settings import athlete_today

        age = ((today or athlete_today()) - day).days
        if not 0 <= age < DRAFT_WINDOW_DAYS:
            return None
        return StrengthRepository().open_draft(
            actual_session_id, draft_exercises(summaries), "import"
        )
    except Exception as exc:  # noqa: BLE001 - never fail the import over a draft
        logger.warning(
            "Could not open the draft of activity %s: %s", actual_session_id, exc
        )
        return None


def open_journal_draft(
    actual_session_id: int, repo: StrengthRepository | None = None
) -> StrengthDraft | None:
    """The athlete asks to add loads to an activity: its pending draft, or None.

    None when the activity is not the athlete's strength activity or a log
    already completes it. Opening twice returns the same draft.
    """
    repo = repo or StrengthRepository()
    draft_id = repo.open_draft(actual_session_id, [], "journal", reopen=True)
    if draft_id is None:
        return None
    drafts = repo.pending_drafts(draft_id)
    return drafts[0] if drafts else None


def _pending(repo: StrengthRepository, draft_id: int) -> StrengthDraft:
    drafts = repo.pending_drafts(draft_id)
    if drafts:
        return drafts[0]
    if repo.draft_exists(draft_id):
        raise DraftSettled(draft_id)
    raise DraftNotFound(draft_id)


def complete_draft(
    draft_id: int, text: str, repo: StrengthRepository | None = None
) -> SaveOutcome:
    """Save the athlete's text as the draft's log, linked to its activity.

    Same reading and rule as the Log's save: matched exercises are saved,
    unrecognised ones reported. Raises ``DraftNotFound``, ``DraftSettled``
    (completed elsewhere: nothing written, never a second log) or ValueError
    when nothing in the text looks like an exercise. Records and the planned
    session follow the commit and never turn a saved log into a failure.
    """
    repo = repo or StrengthRepository()
    draft = _pending(repo, draft_id)
    parsed = parse_for_athlete(text, workout_date=draft.date)
    dropped = dropped_exercises(parsed)
    built = _session_exercises(parsed, repo, dropped, require_complete=False)
    if isinstance(built, SaveOutcome):  # pragma: no cover - only when complete
        return built
    exercises, saved = built
    if not exercises:
        return SaveOutcome(
            session_id=None,
            dropped=dropped,
            unparsed_lines=parsed.unparsed_lines,
            message="Aucun exercice reconnu : séance non enregistrée.",
        )
    session = StrengthSession(
        date=draft.date,
        name=parsed.name or draft.activity_name,
        duration_min=parsed.duration_min
        or (round(draft.duration_sec / 60) if draft.duration_sec else None),
        overall_rpe=parsed.overall_rpe,
        notes=parsed.notes,
        exercises=exercises,
    )
    session_id = repo.complete_draft(draft_id, session)
    if session_id is None:
        raise DraftSettled(draft_id)
    complete_planned_strength(draft.date)
    message = f"Séance complétée : {len(exercises)} exercice(s)"
    if dropped:
        message += f", {len(dropped)} non reconnu(s) laissé(s) de côté"
    return SaveOutcome(
        session_id=session_id,
        saved=saved,
        dropped=dropped,
        message=message,
        records=session_records(repo, session_id, session),
        unparsed_lines=parsed.unparsed_lines,
    )


def dismiss_draft(draft_id: int, repo: StrengthRepository | None = None) -> None:
    """Leave a draft without loads. Raises ``DraftNotFound`` or ``DraftSettled``."""
    repo = repo or StrengthRepository()
    if not repo.dismiss_draft(draft_id):
        if repo.draft_exists(draft_id):
            raise DraftSettled(draft_id)
        raise DraftNotFound(draft_id)
