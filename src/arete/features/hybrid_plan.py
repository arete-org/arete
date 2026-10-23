"""Hyrox and hybrid blocks: running, strength and stations placed by rules.

A Hyrox plan works towards one race and ends with a 10-day taper; a hybrid
block has no race: it lasts 8 or 12 weeks and its last week is a deload with
a benchmark circuit. Each week holds runs (one of them compromised: 1 km at
race pace, then a station), two strength sessions (lower, upper) and a
station circuit, as many as the athlete's level allows.

Sessions carry tags; ``features.week_placement`` places each week under
the interference rules this module declares (``default_rules``) and its
catalog of session kinds (``HYROX``). Pure: no I/O, no clock.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any, Literal

from arete.features.plan_generator import (
    PLANNED_RPE,
    RECOVERY_SHARE,
    WEEKLY_GROWTH,
    DraftSession,
    Phase,
    PlanError,
    WeekPlan,
    monday_of,
    paced,
)
from arete.features.running import TrainingPaces, format_pace
from arete.features.week_placement import (
    HARD,
    KEPT,
    MAX_PER_DAY,
    RACE,
    Catalog,
    Deload,
    Grouping,
    Rules,
    Slot,
    Spacing,
    Taper,
    Violation,
    cap_taper,
    fit_week,
    plan_violations,
    violations,
    without_kept_kinds,
)

# Re-exported: the shared tags, rules and their check, which callers import here.
__all__ = [
    "HARD",
    "KEPT",
    "MAX_PER_DAY",
    "RACE",
    "Deload",
    "Grouping",
    "Rules",
    "Spacing",
    "Taper",
    "Violation",
    "plan_violations",
    "violations",
]

GoalKind = Literal["hyrox", "hybrid"]
Level = Literal["novice", "intermediate", "advanced"]
Division = Literal["open", "pro"]
Format = Literal["solo", "doubles"]

# Tags the rules read.
RUN = "run"
EASY = "easy"
KEY_RUN = "key_run"
COMPROMISED = "compromised"
STRENGTH = "strength"
HEAVY_LOWER = "heavy_lower"
UPPER = "upper"
STATION = "station"
BENCHMARK = "benchmark"
ACTIVATION = "activation"

#: Hyrox: 8 × 1 km of running whatever the division.
HYROX_DISTANCE_KM = 8.0
MIN_WEEKS = 6
MAX_WEEKS = 12
SPECIFIC_WEEKS = 3
#: Share of the peak a taper week, the race week and a block's final deload keep.
TAPER_SHARE = 0.5
RACE_WEEK_SHARE = 0.3
FINAL_DELOAD_SHARE = 0.6
MIN_TRAINING_DAYS = 3
MIN_SESSION_MIN = 20
MIN_EASY_MIN = 25
MAX_EASY_MIN = 75
WARMUP_SEC = 600
#: Minutes a compromised-run station takes, to estimate the session.
STATION_MIN = 3
FALLBACK_KM_MIN = 6.0

#: Weekly running minutes: (floor, peak) by level, before the division.
RUN_MINUTES: dict[Level, tuple[int, int]] = {
    "novice": (60, 150),
    "intermediate": (90, 220),
    "advanced": (120, 280),
}
#: The division scales volumes only; station loads belong to prescriptions.
DIVISION_VOLUME: dict[Division, float] = {"open": 1.0, "pro": 1.15}
LOWER_MIN = 50
UPPER_MIN = 45
CIRCUIT_MIN = 45
BENCHMARK_MIN = 40
ACTIVATION_MIN = 30

#: Planned RPE for a Hyrox or hybrid goal's sessions: strength and station
#: circuits weigh in its projection; every other plan keeps ``PLANNED_RPE``.
HYBRID_PLANNED_RPE: dict[str, float] = {
    **PLANNED_RPE,
    "strength": 6,
    "cross_training": 7,  # a station circuit
}


def default_rules(*, acwr_above: float, tsb_below: float) -> Rules:
    """The interference rules; the deload thresholds are injected."""
    return Rules(
        spacing=(
            Spacing("heavy_lower_before_key_run", HEAVY_LOWER, KEY_RUN, 3, "after"),
            Spacing("station_before_key_run", STATION, KEY_RUN, 2, "after"),
        ),
        grouping=(Grouping("hard_days", HARD, 3, 2),),
        deload=Deload("deload", acwr_above, tsb_below),
        taper=Taper("taper", 10, 0.6, HEAVY_LOWER, 5),
    )


# --------------------------------------------------------------------------- #
# Stations and the athlete's level
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Station:
    id: str
    #: One compromised-run segment with the equipment.
    effort: str
    #: The equipment flag it needs, None when a gym floor is enough.
    equipment: str | None
    #: The same segment without that equipment.
    fallback: str


#: The eight Hyrox stations in race order, with their fallbacks.
STATIONS: tuple[Station, ...] = (
    Station("ski_erg", "500 m de SkiErg", "ski_erg", "20 burpees"),
    Station(
        "sled_push", "25 m de poussée de traîneau", "sled", "30 m de fentes marchées"
    ),
    Station("sled_pull", "25 m de tirage de traîneau", "sled", "20 squats sautés"),
    Station("burpee_broad_jump", "20 burpees broad jumps", None, ""),
    Station("rower", "500 m de rameur", "rower", "20 burpees"),
    Station("farmers_carry", "100 m de farmers carry", None, ""),
    Station("sandbag_lunges", "20 fentes avec sac de sable", None, ""),
    Station("wall_ball", "20 wall balls", "wall_ball", "20 squats sautés"),
)


def station_effort(station: Station, equipment: frozenset[str]) -> str:
    if station.equipment is None or station.equipment in equipment:
        return station.effort
    return station.fallback


def athlete_level(
    runs_per_week: float, run_minutes_per_week: float, strength_per_week: float
) -> Level:
    """Novice under two runs or 90 minutes a week; advanced from four runs,
    200 minutes and two strength sessions; intermediate otherwise."""
    if runs_per_week < 2 or run_minutes_per_week < 90:
        return "novice"
    if runs_per_week >= 4 and run_minutes_per_week >= 200 and strength_per_week >= 2:
        return "advanced"
    return "intermediate"


def loading_sessions(level: Level) -> int:
    """Sessions in a loading week: a novice runs twice, the others three times,
    with two strength sessions and a station circuit."""
    return 5 if level == "novice" else 6


# --------------------------------------------------------------------------- #
# Generation
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class HybridInputs:
    start: date  # first day the plan may fill
    race_date: date  # race day, or the last day of a hybrid block
    kind: GoalKind
    level: Level
    weekly_minutes_now: float  # running minutes per week, last 4 weeks
    #: Days a week the athlete trains; more sessions pair on hard days.
    training_days: int
    rest_days: frozenset[int] = frozenset()  # weekdays, Monday 0
    paces: TrainingPaces | None = None
    race_name: str = "Hyrox"
    division: Division = "open"
    format: Format = "solo"
    equipment: frozenset[str] = frozenset()
    weeks: int = MAX_WEEKS  # chosen length: 8 or 12
    acwr: float | None = None
    tsb: float | None = None
    #: Sessions the athlete edited, dated and tagged (``kind_tags``): the
    #: rules see them, their days stay theirs and each replaces its kind.
    kept: tuple[DraftSession, ...] = ()


#: Each kind a plan writes (``planned_sessions.plan_kind``) and its tags.
_KIND_TAGS: dict[str, frozenset[str]] = {
    RACE: frozenset({RACE, HARD}),
    KEY_RUN: frozenset({RUN, KEY_RUN, HARD}),
    COMPROMISED: frozenset({RUN, COMPROMISED, HARD}),
    EASY: frozenset({RUN, EASY}),
    ACTIVATION: frozenset({RUN, ACTIVATION}),
    HEAVY_LOWER: frozenset({STRENGTH, HEAVY_LOWER, HARD}),
    UPPER: frozenset({STRENGTH, UPPER}),
    STATION: frozenset({STATION, HARD}),
    BENCHMARK: frozenset({STATION, BENCHMARK, HARD}),
}


def kind_of(tags: frozenset[str]) -> str:
    """The kind a generated session is stored with, from its tags."""
    for kind in (RACE, BENCHMARK, ACTIVATION, COMPROMISED, KEY_RUN):
        if kind in tags:
            return kind
    return _primary(tags)


def kind_tags(kind: str, level: Level) -> frozenset[str] | None:
    """The tags a session of a stored ``kind`` had when generated, marked
    kept; None for a kind this module does not write. A novice's compromised
    run is also the key run."""
    tags = _KIND_TAGS.get(kind)
    if tags is None:
        return None
    if kind == COMPROMISED and level == "novice":
        tags = tags | {KEY_RUN}
    return tags | {KEPT}


def kept_tags(
    kind: str, level: Level, session_type: str, intensity: str | None
) -> frozenset[str] | None:
    """A kept session's tags: its kind's (``kind_tags``), and hard when its
    current content is, whatever it was generated as (an easy run turned into
    intervals). The kind still names what it replaces; an activation stays
    light unless it was made hard explicitly."""
    tags = kind_tags(kind, level)
    if tags is None:
        return None
    hard_type = session_type in ("tempo", "intervals", "race") and kind != ACTIVATION
    if intensity == "hard" or hard_type:
        tags = tags | {HARD}
    return tags


_RANK = {
    RACE: 0,
    KEY_RUN: 1,
    COMPROMISED: 2,
    ACTIVATION: 2,
    EASY: 3,
    STATION: 4,
    HEAVY_LOWER: 5,
}
_PREFS: dict[str, tuple[int, ...]] = {
    KEY_RUN: (1, 2, 3, 0, 4, 5, 6),
    COMPROMISED: (5, 6, 4, 3, 2, 1, 0),
    HEAVY_LOWER: (1, 0, 3, 4, 2, 5, 6),
    STATION: (3, 4, 5, 2, 6, 1, 0),
    UPPER: (3, 4, 0, 2, 6, 1, 5),
    EASY: (0, 2, 4, 6, 3, 1, 5),
    BENCHMARK: (5, 6, 4, 3, 2, 1, 0),
}
#: What a week may give up when the rules leave no room, least important
#: first. A full week keeps its key run, its compromised run and one strength
#: session; a partial week (the plan's first, a block's end) may lose any
#: session; a taper week loses hard sessions first.
_FULL_DROPS = (EASY, UPPER, STATION, HEAVY_LOWER)
_PARTIAL_DROPS = (
    EASY,
    UPPER,
    STATION,
    HEAVY_LOWER,
    ACTIVATION,
    COMPROMISED,
    KEY_RUN,
    BENCHMARK,
)
_TAPER_DROPS = (STATION, KEY_RUN, COMPROMISED, UPPER, ACTIVATION, EASY)
_LABELS = {
    EASY: "Footing",
    UPPER: "Force haut du corps",
    STATION: "Circuit stations",
    HEAVY_LOWER: "Force bas du corps",
    ACTIVATION: "Activation",
    COMPROMISED: "Course compromise",
    KEY_RUN: "Séance clé",
    BENCHMARK: "Test de fin de bloc",
}
_NO_ROOM = "pas de jour libre sans enfreindre les règles d'enchaînement"


def _round5(minutes: float) -> int:
    return max(MIN_SESSION_MIN, round(minutes / 5) * 5)


def _may_share(same: Sequence[Slot], slot: Slot) -> bool:
    """Two sessions share a day when one of them is hard, never the race."""
    together = [*same, slot]
    return any(HARD in s.tags for s in together) and not any(
        RACE in s.tags for s in together
    )


def _after_key_run(week: WeekPlan) -> WeekPlan:
    """Say it when heavy legs or stations share the key run's day: after it."""
    key_days = {s.date for s in week.sessions if KEY_RUN in s.tags}
    sessions = [
        replace(s, description=f"{s.description} (après la course clé)")
        if s.date in key_days
        and KEPT not in s.tags
        and (HEAVY_LOWER in s.tags or STATION in s.tags)
        else s
        for s in week.sessions
    ]
    return replace(week, sessions=sessions)


#: Hyrox and hybrid session kinds, as ``week_placement`` places them.
HYROX = Catalog(
    kinds=(
        RACE,
        BENCHMARK,
        ACTIVATION,
        KEY_RUN,
        COMPROMISED,
        HEAVY_LOWER,
        STATION,
        UPPER,
    ),
    default_kind=EASY,
    prefs=_PREFS,
    rank=_RANK,
    labels=_LABELS,
    taper_drops=_TAPER_DROPS,
    may_share=_may_share,
    finish=_after_key_run,
)
_primary = HYROX.primary


def _slot(draft: DraftSession, prefs: tuple[int, ...] | None = None) -> Slot:
    return HYROX.slot(draft, prefs=prefs)


def _pace_label(paces: TrainingPaces | None) -> str:
    if paces is None:
        return "allure Hyrox"
    return (
        f"allure Hyrox ({format_pace(paces.threshold)[:-3]} à "
        f"{format_pace(paces.marathon)})"
    )


def compromised_prescription(
    reps: int, station: str, paces: TrainingPaces | None
) -> dict[str, Any]:
    """Warm-up, ``reps`` × (1 km at race pace, the station until the lap
    button), cool-down: running steps the Garmin export already takes."""
    run: dict[str, Any] = {"kind": "effort", "duration_kind": "meters", "value": 1000}
    if paces is not None:
        run["target"] = {
            "kind": "pace_sec_km",
            "low": paces.threshold,
            "high": paces.marathon,
        }
    return {
        "version": 1,
        "steps": [
            {"kind": "warmup", "duration_kind": "seconds", "value": WARMUP_SEC},
            {
                "kind": "repeat",
                "repeat": reps,
                "steps": [
                    run,
                    {"kind": "effort", "duration_kind": "lap", "notes": station},
                ],
            },
            {"kind": "cooldown", "duration_kind": "seconds", "value": WARMUP_SEC},
        ],
    }


def _compromised(
    reps: int, station: str, paces: TrainingPaces | None, key: bool
) -> DraftSession:
    km_min = (paces.threshold + paces.marathon) / 120 if paces else FALLBACK_KM_MIN
    minutes = 2 * WARMUP_SEC / 60 + reps * (km_min + STATION_MIN)
    tags = {RUN, COMPROMISED, HARD} | ({KEY_RUN} if key else set())
    # Its steps own pace and effort, as a manual session's do; the duration
    # stays: the projection and the dashboard weigh planned load from it.
    return DraftSession(
        date.min,
        "intervals",
        _round5(minutes),
        None,
        None,
        f"Course compromise : {reps}×(1 km {_pace_label(paces)} + {station}), "
        "échauffement et retour au calme 10'",
        prescription=compromised_prescription(reps, station, paces),
        tags=frozenset(tags),
    )


def _key_run(phase: Phase, recovery: bool, paces: TrainingPaces | None) -> DraftSession:
    tags = frozenset({RUN, KEY_RUN, HARD})
    t = paced("au seuil", paces, "threshold")
    if phase == "taper":
        return DraftSession(
            date.min,
            "intervals",
            40,
            "Z4",
            "moderate",
            f"Rappel : 4×4' {_pace_label(paces)}, récup 2'",
            tags=tags,
        )
    if recovery or phase == "base":
        return DraftSession(
            date.min,
            "tempo",
            45,
            "Z4",
            "moderate",
            f"Seuil : 2×10' {t}, récup 2'",
            tags=tags,
        )
    if phase == "build":
        i = paced("à l'allure VMA", paces, "interval")
        return DraftSession(
            date.min,
            "intervals",
            50,
            "Z5",
            "hard",
            f"Fractionné : 6×1000 m {i}, récup 2'",
            tags=tags,
        )
    return DraftSession(
        date.min,
        "tempo",
        55,
        "Z4",
        "hard",
        f"Spécifique Hyrox : 8×1000 m {_pace_label(paces)}, récup 1'",
        tags=tags,
    )


def _easy(
    minutes: float, recovery: bool, paces: TrainingPaces | None, factor: float = 1.0
) -> DraftSession:
    ceiling = max(MIN_EASY_MIN, round(MAX_EASY_MIN * factor / 5) * 5)
    each = max(MIN_EASY_MIN, min(ceiling, round(minutes / 5) * 5))
    return DraftSession(
        date.min,
        "recovery" if recovery else "endurance",
        each,
        "Z1" if recovery else "Z2",
        "easy",
        paced("Footing", paces, "easy"),
        tags=frozenset({RUN, EASY}),
    )


def _lower(factor: float) -> DraftSession:
    return DraftSession(
        date.min,
        "strength",
        _round5(LOWER_MIN * factor),
        None,
        "hard",
        "Force bas du corps : squat, soulevé de terre roumain, fentes",
        sport="strength",
        tags=frozenset({STRENGTH, HEAVY_LOWER, HARD}),
    )


def _upper(factor: float) -> DraftSession:
    return DraftSession(
        date.min,
        "strength",
        _round5(UPPER_MIN * factor),
        None,
        "moderate",
        "Force haut du corps et gainage : développé, tirage, gainage",
        sport="strength",
        tags=frozenset({STRENGTH, UPPER}),
    )


def _stations(inp: HybridInputs, first: int, count: int) -> list[str]:
    return [
        station_effort(STATIONS[(first + k) % len(STATIONS)], inp.equipment)
        for k in range(count)
    ]


def _station_ids(first: int, count: int) -> tuple[str, ...]:
    """The ids of the stations ``_stations`` describes."""
    return tuple(STATIONS[(first + k) % len(STATIONS)].id for k in range(count))


def _circuit(inp: HybridInputs, factor: float, week: int) -> DraftSession:
    minutes = CIRCUIT_MIN * factor * DIVISION_VOLUME[inp.division]
    return DraftSession(
        date.min,
        "cross_training",
        _round5(minutes),
        None,
        "hard",
        "Circuit stations : " + ", ".join(_stations(inp, 2 * week, 4)),
        sport="strength",
        tags=frozenset({STATION, HARD}),
        stations=_station_ids(2 * week, 4),
    )


def _benchmark(inp: HybridInputs) -> DraftSession:
    return DraftSession(
        date.min,
        "cross_training",
        BENCHMARK_MIN,
        None,
        "hard",
        "Test de fin de bloc, chronométré : 4 × 1 km, chacun suivi d'une station ("
        + ", ".join(_stations(inp, 0, 4))
        + ")",
        sport="strength",
        tags=frozenset({STATION, BENCHMARK, HARD}),
        stations=_station_ids(0, 4),
    )


def _activation(inp: HybridInputs, station: str) -> DraftSession:
    return DraftSession(
        date.min,
        "intervals",
        ACTIVATION_MIN,
        "Z3",
        "moderate",
        f"Activation : 15' facile + 2×(1 km {_pace_label(inp.paces)} + {station})",
        tags=frozenset({RUN, ACTIVATION}),
    )


def _activation_days(race_weekday: int) -> tuple[int, ...]:
    """Three, two then four days before the race, as weekdays."""
    return tuple((race_weekday - n) % 7 for n in (3, 2, 4))


def _race(inp: HybridInputs) -> DraftSession:
    return DraftSession(
        date.min,
        "race",
        None,
        None,
        "hard",
        f"{inp.race_name} : Hyrox {inp.division.capitalize()} "
        + ("en solo" if inp.format == "solo" else "en double"),
        distance_km=HYROX_DISTANCE_KM,
        sport="other",
        tags=frozenset({RACE, HARD}),
    )


def _phases(mondays: list[date], inp: HybridInputs, rules: Rules) -> list[Phase]:
    """Each week's phase. Hyrox: the race week last, taper for every other
    week reaching into the taper's days, loading phases compressed before."""
    if inp.kind == "hyrox":
        taper_from = inp.race_date - timedelta(days=rules.taper.days)
        taper = sum(1 for m in mondays[:-1] if m + timedelta(days=6) >= taper_from)
        loading = len(mondays) - taper - 1
        tail: list[Phase] = ["taper" for _ in range(taper)]
        tail.append("race")
    else:
        loading = len(mondays) - 1  # the final deload keeps the last loading phase
        tail = []
    specific = min(SPECIFIC_WEEKS, loading // 3)
    build = (loading - specific) // 2
    base = loading - specific - build
    counts: tuple[tuple[Phase, int], ...] = (
        ("base", base),
        ("build", build),
        ("specific", specific),
    )
    phases: list[Phase] = [phase for phase, n in counts for _ in range(n)]
    if inp.kind == "hybrid":
        phases.append(phases[-1] if phases else "base")
    return phases + tail


def _volumes(
    phases: list[Phase], inp: HybridInputs, deload_first: bool
) -> list[tuple[float, float, bool]]:
    """(running minutes, strength/circuit factor, recovery week?) per week."""
    floor, cap = RUN_MINUTES[inp.level]
    scale = DIVISION_VOLUME[inp.division]
    peak_cap = cap * scale
    current = max(float(floor), min(inp.weekly_minutes_now, peak_cap))
    peak = current
    loading_index = 0
    out: list[tuple[float, float, bool]] = []
    for index, phase in enumerate(phases):
        last = index == len(phases) - 1
        if phase == "taper":
            out.append((peak * TAPER_SHARE, TAPER_SHARE, False))
        elif phase == "race":
            out.append((peak * RACE_WEEK_SHARE, RACE_WEEK_SHARE, False))
        elif inp.kind == "hybrid" and last:
            out.append((current * FINAL_DELOAD_SHARE, FINAL_DELOAD_SHARE, True))
        elif index == 0 and deload_first:
            out.append((current * RECOVERY_SHARE, RECOVERY_SHARE, True))
        else:
            loading_index += 1
            if loading_index % 4 == 0:
                out.append((current * RECOVERY_SHARE, RECOVERY_SHARE, True))
                continue
            if loading_index > 1:
                current = min(current * WEEKLY_GROWTH, peak_cap)
            peak = max(peak, current)
            out.append((current, 1.0, False))
    return out


def _week_slots(
    inp: HybridInputs,
    phase: Phase,
    run_minutes: float,
    factor: float,
    recovery: bool,
    index: int,
    final: bool,
    activation_before: bool,
) -> list[Slot]:
    """The week's sessions before placement. ``activation_before``: the race
    falls on a Monday or a Tuesday, its activation in this week."""
    paces = inp.paces
    novice = inp.level == "novice"
    station = _stations(inp, index, 1)[0]
    race_wd = inp.race_date.weekday()
    activation = _slot(_activation(inp, station), _activation_days(race_wd))
    if phase == "race":
        slots = [_slot(_race(inp), (race_wd,)), _slot(_easy(30, False, paces))]
        if race_wd >= 2:
            slots.insert(1, activation)
        return slots
    if final:  # a hybrid block's deload, closed by its benchmark
        easy = [_slot(_easy(run_minutes / (1 if novice else 2), True, paces, factor))]
        if not novice:
            easy.append(easy[0])
        return [_slot(_benchmark(inp)), *easy, _slot(_upper(factor))]

    reps = {"base": 3, "build": 4, "specific": 5, "taper": 2}[phase]
    if recovery:
        reps = 3
    elif phase != "taper" and inp.division == "pro":
        reps += 1
    compromised = _compromised(reps, station, paces, key=novice)
    slots = [_slot(compromised)]
    used = compromised.duration_min or 0
    if not novice:
        key = _key_run(phase, recovery, paces)
        slots.insert(0, _slot(key))
        used += key.duration_min or 0
    if phase != "taper":  # no heavy legs in the taper
        slots.append(_slot(_lower(factor)))
    slots.append(_slot(_circuit(inp, factor, index)))
    slots.append(_slot(_upper(factor)))
    slots.append(_slot(_easy(run_minutes - used, recovery, paces, factor)))
    if activation_before:
        slots.append(activation)
    return slots


def _available(monday: date, inp: HybridInputs) -> list[int]:
    """Training weekdays inside the plan; the race day is placed apart."""
    out = []
    for d in range(7):
        day = monday + timedelta(days=d)
        if d in inp.rest_days or day < inp.start or day > inp.race_date:
            continue
        if inp.kind == "hyrox" and day == inp.race_date:
            continue
        out.append(d)
    return out


def plan_length(inp: HybridInputs) -> int:
    """Weeks a Hyrox plan covers, the current (partial) week included."""
    n_weeks = (monday_of(inp.race_date) - monday_of(inp.start)).days // 7 + 1
    if n_weeks < MIN_WEEKS:
        raise PlanError(
            f"Hyrox dans moins de {MIN_WEEKS} semaines : trop tard pour un plan "
            "complet, garde tes séances actuelles et allège la dernière semaine."
        )
    return min(n_weeks, inp.weeks, MAX_WEEKS)


def generate_hybrid_plan(inp: HybridInputs, rules: Rules) -> list[WeekPlan]:
    """The weeks to race day or to the block's end; raises ``PlanError``."""
    if inp.race_date < inp.start:
        raise PlanError(
            "La course est déjà passée."
            if inp.kind == "hyrox"
            else "Le bloc est déjà terminé."
        )
    if 7 - len(inp.rest_days) < MIN_TRAINING_DAYS:
        raise PlanError(
            f"Au moins {MIN_TRAINING_DAYS} jours sans repos sont nécessaires par semaine."
        )
    full_days = min(max(MIN_TRAINING_DAYS, inp.training_days), 7 - len(inp.rest_days))
    # A block is anchored on its end, a Hyrox on its race: past weeks are
    # not replanned, and a regenerated block keeps its rhythm.
    n_weeks = inp.weeks if inp.kind == "hybrid" else plan_length(inp)
    first = monday_of(inp.race_date) - timedelta(weeks=n_weeks - 1)
    mondays = [first + timedelta(weeks=k) for k in range(n_weeks)]
    phases = _phases(mondays, inp, rules)
    upcoming = [m for m in mondays if m + timedelta(days=6) >= inp.start]
    # Today's load says nothing of a block starting weeks from now.
    deload_first = rules.deload.triggered(inp.acwr, inp.tsb) and (
        upcoming[0] <= inp.start + timedelta(days=7)
    )
    past = len(mondays) - len(upcoming)
    if past == 0:  # the plan starts now: its 3:1 count follows the deload
        volumes = _volumes(phases, inp, deload_first)
    else:  # a running block keeps its rhythm; the week starting now lightens
        volumes = _volumes(phases, inp, deload_first=False)
        if deload_first and past < len(mondays) - 1 and not volumes[past][2]:
            run_minutes, _, _ = volumes[past]
            volumes[past] = (run_minutes * RECOVERY_SHARE, RECOVERY_SHARE, True)
    race_date = inp.race_date if inp.kind == "hyrox" else None
    race_wd = inp.race_date.weekday()
    for kept_session in inp.kept:
        if race_date == kept_session.date and RACE not in kept_session.tags:
            raise PlanError(
                f"La séance « {kept_session.description} » du "
                f"{kept_session.date:%d/%m} tombe le jour de la course : "
                "déplace-la ou supprime-la avant de générer le plan."
            )
    usual = len([d for d in range(7) if d not in inp.rest_days])

    weeks: list[WeekPlan] = []
    previous: WeekPlan | None = None
    for index, (monday, phase, (run_minutes, factor, recovery)) in enumerate(
        zip(mondays, phases, volumes, strict=True)
    ):
        if index < past:
            continue
        final = inp.kind == "hybrid" and index == len(mondays) - 1
        activation_before = (
            inp.kind == "hyrox" and index == len(mondays) - 2 and race_wd < 2
        )
        kept = [k for k in inp.kept if monday <= k.date <= monday + timedelta(days=6)]
        slots = without_kept_kinds(
            _week_slots(
                inp,
                phase,
                run_minutes,
                factor,
                recovery,
                index,
                final,
                activation_before,
            ),
            # A kept race, even moved off race day, is the race: never a second.
            [*kept, *(k for k in inp.kept if RACE in k.tags and k not in kept)],
            HYROX,
        )
        open_days = _available(monday, inp)
        kept_days = {k.date.weekday() for k in kept}
        days = [d for d in open_days if d not in kept_days]
        tapering = phase in ("taper", "race")
        partial = len(open_days) < usual
        # Kept sessions may leave no room for the usual minimum either.
        loose = partial or bool(kept)
        drops = _TAPER_DROPS if tapering else _PARTIAL_DROPS if loose else _FULL_DROPS
        max_days = min(full_days, len(days) + len(kept_days) + (phase == "race"))
        fitted = fit_week(
            WeekPlan(start=monday, phase=phase, minutes=0, recovery=recovery),
            slots,
            days,
            max_days,
            rules,
            HYROX,
            drops=drops,
            keep_tag=None if tapering or loose else STRENGTH,
            fixed=kept,
            ahead=[
                k
                for k in inp.kept
                if monday + timedelta(days=7) <= k.date <= monday + timedelta(days=13)
            ],
            previous=previous,
            race_date=race_date,
        )
        if fitted is None:
            raise PlanError(
                f"Impossible de placer la semaine du {monday:%d/%m} sans enchaîner "
                "jambes lourdes, stations et séance clé : libère un jour "
                "d'entraînement ou retire un jour de repos."
            )
        week, gone = fitted
        week = replace(week, dropped=HYROX.dropped_slots(gone, _NO_ROOM))
        weeks.append(week)
        previous = week
    if race_date is not None:
        cap_taper(weeks, rules.taper, race_date, HYROX)
    return weeks
