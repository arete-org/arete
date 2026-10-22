"""Today's planned session against this morning's readiness: rules, no I/O.

The rules decide, the coach explains: the daily run applies what ``evaluate``
returns and the briefing is told why, so the model never invents the day's
action. Bands follow the Garmin integration plan (80 / 60 / 40); ACWR above
1.5 means rest whatever the readiness says.

``fatigue_threshold`` (Settings) is deliberately not an input: it was set
against Arete's own readiness score, and Garmin's Training Readiness, read
first, is on another scale. One threshold for two scales would mislead.

The morning check-in weighs one band, downwards only: legs or sleep declared
at ``CHECKIN_LOW_AT`` or less out of 5 move the readiness to the band below
(keep → ease → recovery → rest), once whatever the number of low answers.
Good answers never raise a band, and no answer changes nothing. The athlete
knows how the legs feel; the watch does not, so a bad morning counts, but a
good one never overrides a low measure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from arete.features.workload import format_acwr

KEEP_AT = 80
EASE_AT = 60
REPLACE_AT = 40
ACWR_REST_AT = 1.5
TSB_EASE_AT = -25.0
RECOVERY_MIN = 30
#: A check-in answer at or below this (out of 5) lowers the readiness band.
CHECKIN_LOW_AT = 2

ADAPTABLE_SPORTS = frozenset({"running", "cycling", "swimming"})
HARD_TYPES = frozenset({"tempo", "intervals"})
EASY_TYPES = frozenset({"recovery", "endurance", "long_run"})

_TYPE_FR = {
    "recovery": "récupération",
    "endurance": "endurance",
    "tempo": "tempo",
    "intervals": "fractionné",
    "long_run": "sortie longue",
    "race": "course",
}


class Decision(StrEnum):
    KEEP = "keep"
    EASE = "ease"
    REPLACE_EASY = "replace_easy"
    REST = "rest"
    #: Only the athlete's renegotiation or a missed session's replanning
    #: moves a session (``renegotiation``, ``missed_sessions``).
    MOVE = "move"
    #: A missed session let go (``missed_sessions``): skipped, not a rest.
    DROP = "drop"


@dataclass(frozen=True)
class AdaptationInput:
    session_type: str
    sport: str
    status: str
    target_duration_min: int | None
    target_hr_zone: str | None
    target_intensity: str | None
    description: str | None
    readiness: float | None
    readiness_source: str
    acwr: float | None
    tsb: float | None
    fitness_goal: str
    #: The morning check-in (1-5), None when the day has no answer.
    sleep: int | None = None
    legs: int | None = None


@dataclass(frozen=True)
class Adaptation:
    decision: Decision
    reason: str
    #: Fields to write on the planned session; empty for keep and rest.
    adapted: dict[str, Any] = field(default_factory=dict)


def readiness_phrase(score: float, source: str) -> str:
    """The readiness, said with where it comes from (starts a sentence)."""
    if source == "garmin_training":
        return f"Préparation Garmin {score:.0f}/100"
    if source == "garmin":
        return f"Préparation (VFC, sommeil) {score:.0f}/100"
    return f"Préparation estimée par la charge {score:.0f}/100"


def declared_fatigue(sleep: int | None, legs: int | None) -> str | None:
    """What the morning check-in declares against training, None for nothing.

    Only low answers count (``CHECKIN_LOW_AT``): this is the reason's wording.
    """
    night = sleep is not None and sleep <= CHECKIN_LOW_AT
    heavy = legs is not None and legs <= CHECKIN_LOW_AT
    if night and heavy:
        return "nuit difficile et jambes lourdes déclarées"
    if night:
        return "nuit difficile déclarée"
    if heavy:
        return "jambes lourdes déclarées"
    return None


def _band(score: float) -> int:
    """3 keep, 2 ease, 1 recovery, 0 rest: the readiness bands."""
    return (score >= KEEP_AT) + (score >= EASE_AT) + (score >= REPLACE_AT)


def _said(inp: AdaptationInput) -> str:
    """The readiness and, when it weighs, the check-in (starts a sentence)."""
    assert inp.readiness is not None
    said = readiness_phrase(inp.readiness, inp.readiness_source)
    declared = declared_fatigue(inp.sleep, inp.legs)
    return f"{said}, {declared}" if declared else said


def describe(session_type: str, duration_min: int | None, zone: str | None) -> str:
    parts = [_TYPE_FR.get(session_type, session_type)]
    if duration_min:
        parts.append(f"{duration_min} min")
    if zone:
        parts.append(zone)
    return " ".join(parts)


def evaluate(inp: AdaptationInput) -> Adaptation | None:
    """The day's decision for one planned session, or None when there is none.

    None means "not this function's business": a session already done or
    skipped, a sport or a type the bands do not apply to (strength), or no
    readiness at all. Nothing is stored then.
    """
    if inp.status != "pending" or inp.sport not in ADAPTABLE_SPORTS:
        return None
    if inp.session_type == "race":
        return Adaptation(
            Decision.KEEP, "Jour de course : aucune adaptation automatique."
        )
    if inp.session_type not in HARD_TYPES | EASY_TYPES:
        return None
    if inp.readiness is None:
        return None

    said = _said(inp)
    planned = describe(inp.session_type, inp.target_duration_min, inp.target_hr_zone)
    band = _band(inp.readiness)
    if declared_fatigue(inp.sleep, inp.legs):
        band = max(0, band - 1)

    if inp.acwr is not None and inp.acwr > ACWR_REST_AT:
        return Adaptation(
            Decision.REST,
            f"Charge aiguë très au-dessus de la chronique (ACWR {format_acwr(inp.acwr)}) : "
            f"repos à la place de la séance {planned}.",
        )
    if band == 0:
        return Adaptation(
            Decision.REST,
            f"{said} : repos à la place de la séance {planned}.",
        )
    if band == 1:
        return Adaptation(
            Decision.REPLACE_EASY,
            f"{said} : la séance {planned} devient "
            f"{RECOVERY_MIN} min de récupération en Z1.",
            {
                "session_type": "recovery",
                "target_duration_min": RECOVERY_MIN,
                "target_hr_zone": "Z1",
                "target_intensity": "easy",
                "description": f"Récupération {RECOVERY_MIN}' Z1 "
                f"(séance d'origine : {inp.description or planned})",
            },
        )
    tired = inp.tsb is not None and inp.tsb < TSB_EASE_AT
    if band < 3 or tired or inp.fitness_goal == "recovery":
        if inp.session_type in HARD_TYPES:
            why = (
                said
                if band < 3
                else f"Fraîcheur à {inp.tsb:.0f}"
                if tired
                else "Objectif de récupération"
            )
            minutes = f" {inp.target_duration_min}'" if inp.target_duration_min else ""
            return Adaptation(
                Decision.EASE,
                f"{why} : la séance {planned} est allégée en endurance Z2, même durée.",
                {
                    "session_type": "endurance",
                    "target_hr_zone": "Z2",
                    "target_intensity": "easy",
                    # The watch shows the description: never the hard workout's.
                    "description": f"Endurance{minutes} Z2 "
                    f"(séance d'origine : {inp.description or planned})",
                },
            )
        return Adaptation(Decision.KEEP, f"{said} : séance facile maintenue.")
    return Adaptation(Decision.KEEP, f"{said} : séance {planned} maintenue.")


#: Which session of a day keeps the recovery: the hardest type, then the longest.
_KEY_RANK = {"intervals": 2, "tempo": 1}


def one_recovery_per_day(
    day: list[tuple[AdaptationInput, Adaptation | None]],
    *,
    kept: str | None = None,
) -> list[Adaptation | None]:
    """The day's outcomes with a single recovery: on the key session, rest elsewhere.

    ``evaluate`` decides each session alone, so two sessions would get two
    recoveries. The key session (intervals > tempo > others, then the longest)
    keeps it; the other replaced sessions rest. ``kept`` names a session that
    already holds the day's recovery (an earlier run): every new replacement
    then rests.

    When the key is ambiguous (a tie on type and duration, or a race that day)
    the outcomes are unchanged: each tied session keeps its own recovery, all
    on the same day card. This is accepted, not an oversight (ARE-89).
    """
    outcomes = [outcome for _, outcome in day]
    replaced = [
        (inp, i)
        for i, (inp, outcome) in enumerate(day)
        if outcome is not None and outcome.decision == Decision.REPLACE_EASY
    ]
    if kept is None:
        if len(replaced) < 2 or any(inp.session_type == "race" for inp, _ in day):
            return outcomes

        def weight(inp: AdaptationInput) -> tuple[int, int]:
            return _KEY_RANK.get(inp.session_type, 0), inp.target_duration_min or 0

        replaced.sort(key=lambda item: weight(item[0]), reverse=True)
        if weight(replaced[0][0]) == weight(replaced[1][0]):
            return outcomes
        key = replaced.pop(0)[0]
        kept = describe(key.session_type, key.target_duration_min, key.target_hr_zone)
    for inp, i in replaced:
        assert inp.readiness is not None  # REPLACE_EASY needs a readiness
        planned = describe(
            inp.session_type, inp.target_duration_min, inp.target_hr_zone
        )
        outcomes[i] = Adaptation(
            Decision.REST,
            f"{_said(inp)} : repos à la "
            f"place de la séance {planned} ; la récupération du jour remplace "
            f"la séance {kept}.",
        )
    return outcomes
