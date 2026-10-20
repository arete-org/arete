"""Progression per exercise: e1RM trend, personal records, next-session load.

Pure functions over the working sets of an exercise, oldest session first.
Warm-up sets never reach this module: the repository filters them, so they
count neither in a trend, nor in a record, nor in a suggestion.

The next-session rule is deterministic and deliberately plain:

1. Look at the last session's top weight and the sets done at it.
2. The rep range is the logged target ("8-10"); without one, the reps done.
3. Effort is the lowest reps-in-reserve at that weight (``RIR``, or
   ``10 - RPE`` when only RPE was logged).
4. Decide, first match wins:
   - RIR >= 3: too easy, add one increment;
   - every set reached the top of the range, not at failure: add one
     increment and restart at the bottom of the range (double progression);
   - top of the range reached at failure / RIR 0: same load, consolidate;
   - a set fell short of the range at failure / RIR 0: load -5 %;
   - otherwise: same load, one more rep per set, up to the top of the range.
5. Low readiness overrides all of this with a deload: no increase, load
   -10 % and a third of the sets dropped (readiness < 50), or -15 % and half
   the sets dropped (readiness < 35). The reason says so, in French.

Increments: 1 kg under 20 kg (dumbbells), 5 kg on squats and hinges from
60 kg, otherwise 2.5 kg. Loads round to the same steps. Bodyweight work
(no load) progresses by reps.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date

from arete.features.strength import estimate_1rm_epley

#: Epley overestimates past a dozen reps; such sets do not set an e1RM.
MAX_E1RM_REPS = 12
#: Below this score (0-100) the day's readiness calls for a lighter session.
DELOAD_READINESS = 50.0
#: Below this score the deload is deeper.
DEEP_DELOAD_READINESS = 35.0
#: Two e1RMs closer than this are the same lift, not a record.
E1RM_EPSILON = 0.05


@dataclass(frozen=True)
class WorkSet:
    """One working set (never a warm-up)."""

    reps: int
    weight_kg: float | None = None
    rpe: float | None = None
    rir: int | None = None
    is_failure: bool = False

    @property
    def load(self) -> float:
        return self.weight_kg or 0.0

    @property
    def e1rm(self) -> float | None:
        if self.load <= 0 or not 1 <= self.reps <= MAX_E1RM_REPS:
            return None
        return estimate_1rm_epley(self.load, self.reps)

    @property
    def reserve(self) -> float | None:
        """Reps in reserve, from RIR or else from RPE."""
        if self.rir is not None:
            return float(self.rir)
        if self.rpe is not None:
            return max(0.0, 10.0 - self.rpe)
        return None


@dataclass(frozen=True)
class ExerciseSession:
    """The working sets one session did of one exercise."""

    session_id: int
    date: date
    sets: list[WorkSet]
    target_reps: str | None = None
    session_exercise_id: int | None = None

    @property
    def best_e1rm(self) -> float | None:
        values = [s.e1rm for s in self.sets if s.e1rm is not None]
        return max(values) if values else None

    @property
    def top_set(self) -> WorkSet | None:
        """Heaviest set, most reps breaking ties."""
        done = [s for s in self.sets if s.reps > 0]
        return max(done, key=lambda s: (s.load, s.reps)) if done else None


@dataclass(frozen=True)
class Record:
    """A personal record: what was lifted and what it beat."""

    kind: str  # "weight" | "e1rm" | "reps"
    value: float  # kg for weight/e1rm, reps for reps
    previous: float | None
    weight_kg: float | None
    reps: int | None
    date: date | None = None

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "value": round(self.value, 1),
            "previous": round(self.previous, 1) if self.previous is not None else None,
            "weight_kg": self.weight_kg,
            "reps": self.reps,
            "date": self.date.isoformat() if self.date else None,
        }


@dataclass(frozen=True)
class Suggestion:
    """What to lift next time, and why."""

    weight_kg: float | None
    sets: int
    reps: int
    rep_range: str | None
    rule: str  # increase | double_progression | hold | decrease | reps | deload
    reason: str
    based_on: date
    readiness: float | None = None

    def as_dict(self) -> dict:
        return {
            "weight_kg": self.weight_kg,
            "sets": self.sets,
            "reps": self.reps,
            "rep_range": self.rep_range,
            "rule": self.rule,
            "reason": self.reason,
            "based_on": self.based_on.isoformat(),
            "deload": self.rule == "deload",
            "readiness": self.readiness,
        }


@dataclass
class AllTimeRecords:
    """The best of every kind over an exercise's whole history."""

    heaviest: Record | None = None
    best_e1rm: Record | None = None
    reps_by_weight: dict[float, Record] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Trend and records
# --------------------------------------------------------------------------- #
def all_time_records(sessions: list[ExerciseSession]) -> AllTimeRecords:
    """Heaviest set, best e1RM and most reps at each load, with their dates.

    The first session to reach a value keeps it: equalling is not beating.
    """
    best = AllTimeRecords()
    for session in sorted(sessions, key=lambda s: (s.date, s.session_id)):
        for s in session.sets:
            if s.reps <= 0:
                continue
            if s.load > 0 and (best.heaviest is None or s.load > best.heaviest.value):
                best.heaviest = Record(
                    "weight", s.load, None, s.load, s.reps, session.date
                )
            e1rm = s.e1rm
            if e1rm is not None and (
                best.best_e1rm is None or e1rm > best.best_e1rm.value + E1RM_EPSILON
            ):
                best.best_e1rm = Record(
                    "e1rm", e1rm, None, s.load, s.reps, session.date
                )
            held = best.reps_by_weight.get(s.load)
            if held is None or s.reps > held.value:
                best.reps_by_weight[s.load] = Record(
                    "reps", s.reps, None, s.weight_kg, s.reps, session.date
                )
    return best


def new_records(
    previous: list[ExerciseSession], current: ExerciseSession
) -> list[Record]:
    """What ``current`` beat. A first session has nothing to beat: no record.

    Reps count as a record only at a load already lifted before; a new,
    heavier load is the weight record instead.
    """
    before = all_time_records(previous)
    if before.heaviest is None and not before.reps_by_weight:
        return []
    now = all_time_records([current])
    found: list[Record] = []

    if now.heaviest and (
        before.heaviest is None or now.heaviest.value > before.heaviest.value
    ):
        found.append(
            Record(
                "weight",
                now.heaviest.value,
                before.heaviest.value if before.heaviest else None,
                now.heaviest.weight_kg,
                now.heaviest.reps,
                current.date,
            )
        )
    if (
        now.best_e1rm
        and before.best_e1rm
        and now.best_e1rm.value > before.best_e1rm.value + E1RM_EPSILON
    ):
        found.append(
            Record(
                "e1rm",
                now.best_e1rm.value,
                before.best_e1rm.value,
                now.best_e1rm.weight_kg,
                now.best_e1rm.reps,
                current.date,
            )
        )
    beaten = [
        (load, record, before.reps_by_weight[load])
        for load, record in now.reps_by_weight.items()
        if load in before.reps_by_weight
        and record.value > before.reps_by_weight[load].value
    ]
    if beaten:  # the heaviest load where more reps were done
        load, record, held = max(beaten, key=lambda item: item[0])
        found.append(
            Record(
                "reps",
                record.value,
                held.value,
                record.weight_kg,
                record.reps,
                current.date,
            )
        )
    return found


# --------------------------------------------------------------------------- #
# Next session
# --------------------------------------------------------------------------- #
def rep_range(target: str | None) -> tuple[int, int] | None:
    """'8-10' -> (8, 10), '5' -> (5, 5); a rep list like '10/8/6' -> None."""
    if not target:
        return None
    match = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*e?\s*", target)
    if not match:
        return None
    low = int(match.group(1))
    high = int(match.group(2) or low)
    return (low, high) if 0 < low <= high else None


def increment(load: float, lower_body: bool) -> float:
    if load < 20:
        return 1.0
    if lower_body and load >= 60:
        return 5.0
    return 2.5


def round_load(load: float) -> float:
    step = 1.0 if load < 20 else 2.5
    return round(round(load / step) * step, 2)


def _lighter(load: float, factor: float) -> float:
    """``load × factor`` on the plate steps, always strictly lighter."""
    lighter = round_load(load * factor)
    if lighter >= load:
        lighter = round_load(load - (1.0 if load < 20 else 2.5))
    return max(lighter, 0.0)


def _fmt(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def suggest_next(
    last: ExerciseSession,
    *,
    lower_body: bool = False,
    readiness: float | None = None,
) -> Suggestion | None:
    """The load, sets and reps for the next session of this exercise."""
    done = [s for s in last.sets if s.reps > 0]
    if not done:
        return None
    top = max(s.load for s in done)
    at_top = [s for s in done if s.load == top]
    sets = len(at_top)
    reps = [s.reps for s in at_top]
    low, high = rep_range(last.target_reps) or (min(reps), min(reps))
    shown_range = f"{low}-{high}" if low != high else None
    reserves = [r for r in (s.reserve for s in at_top) if r is not None]
    reserve = min(reserves) if reserves else None
    failure = any(s.is_failure for s in at_top) or reserve == 0
    load = top if top > 0 else None

    def make(
        weight: float | None, n_sets: int, n_reps: int, rule: str, reason: str
    ) -> Suggestion:
        return Suggestion(
            weight_kg=weight,
            sets=n_sets,
            reps=n_reps,
            rep_range=shown_range,
            rule=rule,
            reason=reason,
            based_on=last.date,
            readiness=readiness,
        )

    if readiness is not None and readiness < DELOAD_READINESS:
        deep = readiness < DEEP_DELOAD_READINESS
        factor, dropped = (
            (0.85, math.ceil(sets / 2)) if deep else (0.9, math.ceil(sets / 3))
        )
        n_sets = max(1, sets - dropped)
        removed = sets - n_sets
        weight = _lighter(top, factor) if load else None
        parts = []
        if weight is not None:
            parts.append(f"charge −{round((1 - factor) * 100)} %")
        if removed:
            parts.append(f"{removed} série{'s' if removed > 1 else ''} en moins")
        what = " et ".join(parts) or "même séance, sans chercher à progresser"
        return make(
            weight,
            n_sets,
            low,
            "deload",
            f"Préparation basse aujourd'hui ({readiness:.0f}/100) : {what}.",
        )

    all_top = all(r >= high for r in reps)
    below = any(r < low for r in reps)

    if load is None:  # bodyweight: progress by reps
        if failure and below:
            return make(
                None,
                sets,
                min(reps),
                "hold",
                "Échec sous la fourchette : mêmes répétitions, vise des séries complètes.",
            )
        target = min(reps) + 1
        return make(
            None,
            sets,
            target,
            "reps",
            f"Au poids du corps : vise {target} répétitions par série.",
        )

    step = increment(top, lower_body)
    if reserve is not None and reserve >= 3:
        return make(
            round_load(top + step),
            sets,
            low,
            "increase",
            f"Il te restait {reserve:.0f} répétitions en réserve : +{_fmt(step)} kg.",
        )
    if all_top and not failure:
        return make(
            round_load(top + step),
            sets,
            low,
            "double_progression",
            f"Toutes les séries à {high} répétitions : +{_fmt(step)} kg et retour à {low}.",
        )
    if all_top:
        return make(
            top,
            sets,
            high,
            "hold",
            "Haut de fourchette atteint à l'échec : même charge pour consolider.",
        )
    if below and failure:
        return make(
            _lighter(top, 0.95),
            sets,
            low,
            "decrease",
            f"Séries sous {low} répétitions à l'échec : charge −5 %.",
        )
    target = min(high, min(reps) + 1)
    return make(
        top,
        sets,
        target,
        "double_progression",
        f"Même charge, vise {target} répétitions par série avant d'augmenter.",
    )
