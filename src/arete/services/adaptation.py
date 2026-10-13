"""Today's planned session against this morning's readiness: rules, no I/O.

The rules decide, the coach explains: the daily run applies what ``evaluate``
returns and the briefing is told why, so the model never invents the day's
action. Bands follow the Garmin integration plan (80 / 60 / 40); ACWR above
1.5 means rest whatever the readiness says.

``fatigue_threshold`` (Settings) is deliberately not an input: it was set
against Arete's own readiness score, and Garmin's Training Readiness, read
first, is on another scale. One threshold for two scales would mislead.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

KEEP_AT = 80
EASE_AT = 60
REPLACE_AT = 40
ACWR_REST_AT = 1.5
TSB_EASE_AT = -25.0
RECOVERY_MIN = 30

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
        return f"Récupération (VFC, sommeil) {score:.0f}/100"
    return f"Forme estimée par la charge {score:.0f}/100"


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

    score = inp.readiness
    said = readiness_phrase(score, inp.readiness_source)
    planned = describe(inp.session_type, inp.target_duration_min, inp.target_hr_zone)

    if inp.acwr is not None and inp.acwr > ACWR_REST_AT:
        return Adaptation(
            Decision.REST,
            f"Charge aiguë très au-dessus de la chronique (ACWR {inp.acwr:.2f}) : "
            f"repos à la place de la séance {planned}.",
        )
    if score < REPLACE_AT:
        return Adaptation(
            Decision.REST,
            f"{said} : repos à la place de la séance {planned}.",
        )
    if score < EASE_AT:
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
    if score < KEEP_AT or tired or inp.fitness_goal == "recovery":
        if inp.session_type in HARD_TYPES:
            why = (
                said
                if score < KEEP_AT
                else f"Fraîcheur à {inp.tsb:.0f}"
                if tired
                else "Objectif de récupération"
            )
            return Adaptation(
                Decision.EASE,
                f"{why} : la séance {planned} est allégée en endurance Z2, même durée.",
                {
                    "session_type": "endurance",
                    "target_hr_zone": "Z2",
                    "target_intensity": "easy",
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
            f"{readiness_phrase(inp.readiness, inp.readiness_source)} : repos à la "
            f"place de la séance {planned} ; la récupération du jour remplace "
            f"la séance {kept}.",
        )
    return outcomes
