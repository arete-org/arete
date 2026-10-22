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

Declared pain counts when the load is high and the session loads its area:
pain at 4/10 or more within three days (``body_log.recent_pain``), with an
ACWR above its safe zone (``ACWR_SAFE_MAX``), on an area the sport loads
(``LOADED_AREAS``). It shares the check-in's penalty: a low check-in, such a
pain or both lower the band once, never twice. Pain alone never turns a
session into rest: its band stops at the recovery replacement (a readiness
already in the rest band still rests). The reason gives the intensity and the
ACWR, not the area. Without a readiness the check-in decides nothing, but
such a pain does, from the top band: a hard session is eased, an easy one
kept (a keep is never stored). Pain under a safe load, or on an area the
session spares, changes nothing here; the coach reads it.
"""

from __future__ import annotations

from collections.abc import Sequence
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
#: The top of the ACWR's optimal zone (``features.workload.get_acwr_zone``):
#: above it, declared pain lowers the band.
ACWR_SAFE_MAX = 1.3

ADAPTABLE_SPORTS = frozenset({"running", "cycling", "swimming"})

#: The body areas (``body_log.PAIN_AREAS``) each adaptable sport loads. An
#: « autre » pain has no known place: it counts for every sport. Strength is
#: absent because the bands never adapt it.
_LOWER_LIMBS = frozenset(
    {
        "foot",
        "ankle",
        "achilles",
        "calf",
        "shin",
        "knee",
        "quadriceps",
        "hamstring",
        "hip",
        "groin",
        "glute",
    }
)
_BACK = frozenset({"lower_back", "upper_back"})
_UPPER_LIMBS = frozenset({"shoulder", "elbow", "wrist_hand", "neck"})
LOADED_AREAS: dict[str, frozenset[str]] = {
    "running": _LOWER_LIMBS | _BACK | {"other"},
    "cycling": _LOWER_LIMBS | _BACK | {"other"},
    "swimming": _UPPER_LIMBS | _BACK | {"other"},
}
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
class DeclaredPain:
    area: str
    intensity: int


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
    #: Pain at 4/10 or more declared in the last three days
    #: (``body_log.recent_pain``), empty without one.
    pain: tuple[DeclaredPain, ...] = ()


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


def pain_under_load(
    pain: Sequence[DeclaredPain], acwr: float | None, sport: str | None = None
) -> str | None:
    """Declared pain under a load above its safe zone, said; None otherwise.

    The rule's one condition, read by the decision (for ``sport``: only the
    areas it loads) and by the briefing's facts (any area). The area stays
    out: the reason is stored with the decision.
    """
    if acwr is None or acwr <= ACWR_SAFE_MAX:
        return None
    loaded = LOADED_AREAS.get(sport, frozenset()) if sport is not None else None
    counted = [p for p in pain if loaded is None or p.area in loaded]
    if not counted:
        return None
    worst = max(p.intensity for p in counted)
    ratio = f"{acwr:.2f}".replace(".", ",")
    return (
        f"douleur déclarée à {worst}/10 avec une charge au-dessus de la zone sûre "
        f"(ACWR {ratio})"
    )


def pain_with_load(inp: AdaptationInput) -> str | None:
    return pain_under_load(inp.pain, inp.acwr, inp.sport)


def _said(inp: AdaptationInput) -> str:
    """The readiness and, when they weigh, the check-in and the pain (starts a
    sentence). Without a readiness, only pain under a high load decides."""
    parts = [
        readiness_phrase(inp.readiness, inp.readiness_source)
        if inp.readiness is not None
        else None,
        declared_fatigue(inp.sleep, inp.legs),
        pain_with_load(inp),
    ]
    said = ", ".join(part for part in parts if part)
    assert said, "a decision needs a readiness or a pain under a high load"
    return said[0].upper() + said[1:]


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
    readiness and no pain under a high load. Nothing is stored then.
    """
    if inp.status != "pending" or inp.sport not in ADAPTABLE_SPORTS:
        return None
    if inp.session_type == "race":
        return Adaptation(
            Decision.KEEP, "Jour de course : aucune adaptation automatique."
        )
    if inp.session_type not in HARD_TYPES | EASY_TYPES:
        return None
    hurt = pain_with_load(inp) is not None
    if inp.readiness is None and not hurt:
        return None

    said = _said(inp)
    planned = describe(inp.session_type, inp.target_duration_min, inp.target_hr_zone)
    measured = _band(inp.readiness) if inp.readiness is not None else 3
    band = measured
    tired_morning = declared_fatigue(inp.sleep, inp.legs) is not None
    if tired_morning or hurt:
        # One penalty for both; pain alone stops at the recovery replacement.
        band = max(0 if tired_morning else min(1, measured), measured - 1)

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
