"""Hyrox and hybrid blocks: running, strength and stations placed by rules.

A Hyrox plan works towards one race and ends with a 10-day taper; a hybrid
block has no race: it lasts 8 or 12 weeks and its last week is a deload with
a benchmark circuit. Each week holds runs (one of them compromised: 1 km at
race pace, then a station), two strength sessions (lower, upper) and a
station circuit, as many as the athlete's level allows.

Interference rules are data (``Spacing``, ``Grouping``, ``Deload``,
``Taper``), read by ``violations``. Sessions carry tags; a week is placed
by a deterministic search over weekdays that returns the first assignment
without any violation. Every rule is monotone (adding a session never
removes a violation), so partial assignments are pruned as soon as they
break one. Pure: no I/O, no clock.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from itertools import combinations
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
RACE = "race"
HARD = "hard"
#: A session the athlete edited, kept as it is when the plan is regenerated.
KEPT = "kept"

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
MAX_PER_DAY = 2
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


# --------------------------------------------------------------------------- #
# Rules as data
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Spacing:
    """A ``first_tag`` session at least ``min_days`` before a ``then_tag`` one.

    Days count from date to date: ``min_days=3`` forbids the two days before.
    On the same day, ``same_day="after"`` allows ``first_tag`` once the
    ``then_tag`` session is done (later in the day); ``"never"`` forbids it.
    """

    id: str
    first_tag: str
    then_tag: str
    min_days: int
    same_day: Literal["never", "after"]


@dataclass(frozen=True)
class Grouping:
    """Days holding a ``tag`` session: at most ``max_per_week`` of them and at
    most ``max_consecutive`` in a row, so the day after such a block is easy.
    Fewer such days than sessions means pairing them on the same day."""

    id: str
    tag: str
    max_per_week: int
    max_consecutive: int


@dataclass(frozen=True)
class Deload:
    """Start with a lighter week when the load is already too high; the
    thresholds are the daily readiness rules' (``services.adaptation``)."""

    id: str
    acwr_above: float
    tsb_below: float

    def triggered(self, acwr: float | None, tsb: float | None) -> bool:
        return (acwr is not None and acwr > self.acwr_above) or (
            tsb is not None and tsb < self.tsb_below
        )


@dataclass(frozen=True)
class Taper:
    """The ``days`` before the race: at most ``volume_share`` of the peak week
    (per seven days), no ``forbidden_tag`` session, and the last hard session
    at least ``last_hard_days`` before race day."""

    id: str
    days: int
    volume_share: float
    forbidden_tag: str
    last_hard_days: int


@dataclass(frozen=True)
class Rules:
    spacing: tuple[Spacing, ...]
    grouping: tuple[Grouping, ...]
    deload: Deload
    taper: Taper


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


@dataclass(frozen=True)
class Violation:
    rule: str
    day: date


def violations(
    week: WeekPlan,
    rules: Rules,
    *,
    previous: WeekPlan | None = None,
    race_date: date | None = None,
) -> list[Violation]:
    """What in ``week`` breaks a rule; ``previous`` carries spacing and
    consecutive days across the weekend, and ``race_date`` enables the taper.
    Sessions of one day are in the order they are done."""
    old = list(previous.sessions) if previous else []
    items = [(s, i, False) for i, s in enumerate(old)] + [
        (s, len(old) + i, True) for i, s in enumerate(week.sessions)
    ]
    out: list[Violation] = []
    for rule in rules.spacing:
        for first, i, first_new in items:
            if rule.first_tag not in first.tags:
                continue
            for then, j, then_new in items:
                if j == i or rule.then_tag not in then.tags:
                    continue
                if not (first_new or then_new):
                    continue
                gap = (then.date - first.date).days
                if gap == 0:
                    if rule.same_day == "never" or i < j:
                        out.append(Violation(rule.id, then.date))
                elif 0 < gap < rule.min_days:
                    out.append(Violation(rule.id, then.date))
    for group in rules.grouping:
        last = week.start + timedelta(days=6)
        current = sorted(
            {
                s.date
                for s in week.sessions
                if group.tag in s.tags and week.start <= s.date <= last
            }
        )
        # One violation per day past the cap: a further hard day is one more.
        for day in current[group.max_per_week :]:
            out.append(Violation(group.id, day))
        days = sorted({s.date for s, _, _ in items if group.tag in s.tags})
        run = 0
        for k, day in enumerate(days):
            run = run + 1 if k and (day - days[k - 1]).days == 1 else 1
            if run > group.max_consecutive and day >= week.start:
                out.append(Violation(group.id, day))
    if race_date is not None:
        taper = rules.taper
        for s in week.sessions:
            before = (race_date - s.date).days
            if 0 < before <= taper.days and taper.forbidden_tag in s.tags:
                out.append(Violation(taper.id, s.date))
            if 0 < before < taper.last_hard_days and HARD in s.tags:
                out.append(Violation(taper.id, s.date))
    return out


def plan_violations(
    weeks: Sequence[WeekPlan], rules: Rules, race_date: date | None
) -> list[Violation]:
    """Every week's violations, then the taper's volume (race plans only)."""
    out: list[Violation] = []
    previous = None
    for week in weeks:
        out += violations(week, rules, previous=previous, race_date=race_date)
        previous = week
    if race_date is not None and _taper_over(weeks, rules.taper, race_date):
        out.append(Violation(f"{rules.taper.id}_volume", race_date))
    return out


def _in_taper(day: date, taper: Taper, race_date: date) -> bool:
    return 0 < (race_date - day).days <= taper.days


def _taper_over(weeks: Sequence[WeekPlan], taper: Taper, race_date: date) -> bool:
    """The taper's days, per seven, above ``volume_share`` of the peak week."""
    peak = max(
        (w.minutes for w in weeks if w.phase not in ("taper", "race")), default=0
    )
    window = sum(
        s.duration_min or 0
        for w in weeks
        for s in w.sessions
        if _in_taper(s.date, taper, race_date)
    )
    return window * 7 / taper.days > taper.volume_share * peak


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


@dataclass(frozen=True)
class _Slot:
    draft: DraftSession
    prefs: tuple[int, ...]  # weekdays in order of preference
    rank: int  # order within a day, and of placement


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


def _primary(tags: frozenset[str]) -> str:
    for tag in (
        RACE,
        BENCHMARK,
        ACTIVATION,
        KEY_RUN,
        COMPROMISED,
        HEAVY_LOWER,
        STATION,
        UPPER,
    ):
        if tag in tags:
            return tag
    return EASY


def _slot(draft: DraftSession, prefs: tuple[int, ...] | None = None) -> _Slot:
    kind = _primary(draft.tags)
    return _Slot(draft, prefs or _PREFS[kind], _RANK.get(kind, 6))


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
) -> list[_Slot]:
    """The week's sessions before placement. ``activation_before``: the race
    falls on a Monday or a Tuesday, its activation in this week."""
    paces = inp.paces
    novice = inp.level == "novice"
    station = _stations(inp, index, 1)[0]
    race_wd = inp.race_date.weekday()
    activation = _Slot(
        _activation(inp, station), _activation_days(race_wd), _RANK[ACTIVATION]
    )
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


def _as_week(template: WeekPlan, placed: list[tuple[int, _Slot]]) -> WeekPlan:
    ordered = sorted(placed, key=lambda p: (p[0], p[1].rank))
    sessions = [
        replace(s.draft, date=template.start + timedelta(days=d)) for d, s in ordered
    ]
    return replace(
        template,
        sessions=sessions,
        minutes=sum(s.duration_min or 0 for s in sessions),
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


def place_week(
    template: WeekPlan,
    slots: Sequence[_Slot],
    days: Sequence[int],
    max_days: int,
    rules: Rules,
    *,
    fixed: Sequence[DraftSession] = (),
    ahead: Sequence[DraftSession] = (),
    previous: WeekPlan | None = None,
    race_date: date | None = None,
) -> WeekPlan | None:
    """The first assignment of ``slots`` to weekdays that adds no violation.

    ``fixed`` sessions (the athlete's edits) keep their day and count for the
    rules; what they already break themselves is not held against the plan.
    ``ahead`` are next week's kept sessions: the rules see them (no heavy
    legs on Sunday before a kept Monday key run), the week does not hold them.
    Slots are placed in rank order, each trying its unused preferred days
    first, then a day it can share (at most two sessions, one of them hard,
    at most ``max_days`` days). None when no assignment exists.

    Bound: at most 8 slots, each trying at most 7 days, so at most 7**8
    leaves per search, and ``_fit`` runs at most 2**8 searches (one per subset
    of droppable slots). The rules are monotone, so a branch stops at its
    first violation: real weeks visit a few hundred nodes.
    """
    pinned = [(s.date.weekday(), _slot(s, (s.date.weekday(),))) for s in fixed]
    later = [
        ((s.date - template.start).days, _slot(s, (s.date.weekday(),))) for s in ahead
    ]

    def broken(placed: list[tuple[int, _Slot]]) -> Counter[Violation]:
        week = _as_week(template, [*placed, *later])
        return Counter(violations(week, rules, previous=previous, race_date=race_date))

    baseline = broken(pinned)
    order = sorted(slots, key=lambda s: s.rank)

    def search(
        i: int, placed: list[tuple[int, _Slot]]
    ) -> list[tuple[int, _Slot]] | None:
        if i == len(order):
            return placed
        slot = order[i]
        used = {d for d, _ in placed}
        allowed = [d for d in slot.prefs if d in days or RACE in slot.draft.tags]
        candidates = [d for d in allowed if d not in used] + [
            d for d in allowed if d in used
        ]
        for d in candidates:
            same = [s for day, s in placed if day == d]
            if len(same) >= MAX_PER_DAY or len(used | {d}) > max_days:
                continue
            if same and not any(HARD in s.draft.tags for s in [*same, slot]):
                continue
            if same and any(RACE in s.draft.tags for s in [*same, slot]):
                continue
            candidate = [*placed, (d, slot)]
            if broken(candidate) - baseline:
                continue
            result = search(i + 1, candidate)
            if result is not None:
                return result
        return None

    result = search(0, pinned)
    return None if result is None else _after_key_run(_as_week(template, result))


def _fit(
    template: WeekPlan,
    slots: list[_Slot],
    days: Sequence[int],
    max_days: int,
    rules: Rules,
    *,
    drops: tuple[str, ...],
    keep_strength: bool,
    fixed: Sequence[DraftSession],
    ahead: Sequence[DraftSession],
    previous: WeekPlan | None,
    race_date: date | None,
) -> tuple[WeekPlan, list[_Slot]] | None:
    """The week with every slot when the rules allow it, else without the
    fewest, least important ones ``drops`` lists; None when even that fails."""
    droppable = sorted(
        (i for i, s in enumerate(slots) if _primary(s.draft.tags) in drops),
        key=lambda i: drops.index(_primary(slots[i].draft.tags)),
    )
    has_strength = any(STRENGTH in s.draft.tags for s in slots)
    for count in range(len(droppable) + 1):
        for gone in combinations(droppable, count):
            left = [s for i, s in enumerate(slots) if i not in gone]
            strength_left = any(STRENGTH in s.draft.tags for s in left)
            if keep_strength and has_strength and not strength_left:
                continue
            week = place_week(
                template,
                left,
                days,
                max_days,
                rules,
                fixed=fixed,
                ahead=ahead,
                previous=previous,
                race_date=race_date,
            )
            if week is not None:
                return week, [slots[i] for i in gone]
    return None


def _without_kept_kinds(
    slots: list[_Slot], kept: Sequence[DraftSession]
) -> list[_Slot]:
    """The slots less one of each kind a kept session already fills."""
    left = list(slots)
    for session in kept:
        kind = _primary(session.tags)
        if kind not in session.tags:
            continue
        for k, slot in enumerate(left):
            if _primary(slot.draft.tags) == kind:
                del left[k]
                break
    return left


def _dropped(sessions: Sequence[DraftSession], reason: str) -> list[str]:
    """What the preview says of sessions a week gave up, in French."""
    return [
        f"Séance « {_LABELS.get(_primary(s.tags), s.description)} » retirée : {reason}."
        for s in sessions
    ]


def _cap_taper(weeks: list[WeekPlan], taper: Taper, race_date: date) -> None:
    """Drop sessions from the taper's days, hard ones first, until their
    volume fits ``taper.volume_share``; never the race or a kept session."""
    reason = (
        f"l'affûtage reste sous {round(taper.volume_share * 100)} % "
        "de la semaine la plus chargée"
    )

    def rank(at: tuple[int, int]) -> tuple[int, int, int]:
        s = weeks[at[0]].sessions[at[1]]
        kind = _primary(s.tags)
        order = _TAPER_DROPS.index(kind) if kind in _TAPER_DROPS else len(_TAPER_DROPS)
        return order, -(s.duration_min or 0), -s.date.toordinal()

    while _taper_over(weeks, taper, race_date):
        candidates = [
            (w, k)
            for w, week in enumerate(weeks)
            for k, s in enumerate(week.sessions)
            if _in_taper(s.date, taper, race_date)
            and RACE not in s.tags
            and KEPT not in s.tags
        ]
        if not candidates:
            return  # the athlete's own sessions: theirs to keep
        w, k = min(candidates, key=rank)
        week = weeks[w]
        gone = week.sessions[k]
        sessions = week.sessions[:k] + week.sessions[k + 1 :]
        weeks[w] = replace(
            week,
            sessions=sessions,
            minutes=sum(s.duration_min or 0 for s in sessions),
            dropped=[*week.dropped, *_dropped([gone], reason)],
        )


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
        slots = _without_kept_kinds(
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
        fitted = _fit(
            WeekPlan(start=monday, phase=phase, minutes=0, recovery=recovery),
            slots,
            days,
            max_days,
            rules,
            drops=drops,
            keep_strength=not (tapering or loose),
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
        week = replace(week, dropped=_dropped([s.draft for s in gone], _NO_ROOM))
        weeks.append(week)
        previous = week
    if race_date is not None:
        _cap_taper(weeks, rules.taper, race_date)
    return weeks
