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

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any, Literal

from arete.features.plan_generator import (
    RECOVERY_SHARE,
    WEEKLY_GROWTH,
    DraftSession,
    Phase,
    PlanError,
    WeekPlan,
    _monday,
    _paced,
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
RACE = "race"
HARD = "hard"

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
        current = sorted({s.date for s in week.sessions if group.tag in s.tags})
        if len(current) > group.max_per_week:
            out.append(Violation(group.id, current[group.max_per_week]))
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
    if race_date is None:
        return out
    taper = rules.taper
    peak = max(
        (w.minutes for w in weeks if w.phase not in ("taper", "race")), default=0
    )
    window = sum(
        s.duration_min or 0
        for w in weeks
        for s in w.sessions
        if 0 < (race_date - s.date).days <= taper.days
    )
    if window * 7 / taper.days > taper.volume_share * peak:
        out.append(Violation(f"{taper.id}_volume", race_date))
    return out


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
    Station("sled_push", "25 m de sled push", "sled", "30 m de fentes marchées"),
    Station("sled_pull", "25 m de sled pull", "sled", "20 squats sautés"),
    Station("burpee_broad_jump", "20 burpees broad jumps", None, ""),
    Station("rower", "500 m de rameur", "rower", "20 burpees"),
    Station("farmers_carry", "100 m de farmers carry", None, ""),
    Station("sandbag_lunges", "20 fentes lestées", None, ""),
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
    training_days: int  # days a week; beyond, sessions pair on hard days
    rest_days: frozenset[int] = frozenset()  # weekdays, Monday 0
    paces: TrainingPaces | None = None
    race_name: str = "Hyrox"
    division: Division = "open"
    format: Format = "solo"
    equipment: frozenset[str] = frozenset()
    weeks: int = MAX_WEEKS  # chosen length: 8 or 12
    acwr: float | None = None
    tsb: float | None = None


@dataclass(frozen=True)
class _Slot:
    draft: DraftSession
    prefs: tuple[int, ...]  # weekdays in order of preference
    rank: int  # order within a day, and of placement


_RANK = {RACE: 0, KEY_RUN: 1, COMPROMISED: 2, EASY: 3, STATION: 4, HEAVY_LOWER: 5}
_PREFS: dict[str, tuple[int, ...]] = {
    KEY_RUN: (1, 2, 3, 0, 4, 5, 6),
    COMPROMISED: (5, 6, 4, 3, 2, 1, 0),
    HEAVY_LOWER: (1, 0, 3, 4, 2, 5, 6),
    STATION: (3, 4, 5, 2, 6, 1, 0),
    UPPER: (3, 4, 0, 2, 6, 1, 5),
    EASY: (0, 2, 4, 6, 3, 1, 5),
    BENCHMARK: (5, 6, 4, 3, 2, 1, 0),
}
#: Dropped first when a partial week cannot hold everything; a taper week,
#: which may not hold hard sessions near the race, loses those first.
_DROP_ORDER = (EASY, UPPER, STATION, HEAVY_LOWER, COMPROMISED, KEY_RUN, BENCHMARK)
_TAPER_DROP_ORDER = (STATION, KEY_RUN, COMPROMISED, UPPER, EASY)


def _round5(minutes: float) -> int:
    return max(MIN_SESSION_MIN, round(minutes / 5) * 5)


def _primary(tags: frozenset[str]) -> str:
    for tag in (RACE, BENCHMARK, KEY_RUN, COMPROMISED, HEAVY_LOWER, STATION, UPPER):
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
    return DraftSession(
        date.min,
        "intervals",
        _round5(minutes),
        "Z4",
        "hard",
        f"Course compromise : {reps}×(1 km {_pace_label(paces)} + {station}), "
        "échauffement et retour au calme 10'",
        prescription=compromised_prescription(reps, station, paces),
        tags=frozenset(tags),
    )


def _key_run(phase: Phase, recovery: bool, paces: TrainingPaces | None) -> DraftSession:
    tags = frozenset({RUN, KEY_RUN, HARD})
    t = _paced("au seuil", paces, "threshold")
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
        i = _paced("à l'allure VMA", paces, "interval")
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
        _paced("Footing", paces, "easy"),
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
    )


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
) -> list[_Slot]:
    paces = inp.paces
    novice = inp.level == "novice"
    station = _stations(inp, index, 1)[0]
    if phase == "race":
        race_wd = inp.race_date.weekday()
        activation = DraftSession(
            date.min,
            "intervals",
            30,
            "Z3",
            "moderate",
            f"Activation : 15' facile + 2×(1 km {_pace_label(paces)} + {station})",
            tags=frozenset({RUN}),
        )
        near = tuple(d for d in (race_wd - 3, race_wd - 2, race_wd - 4) if d >= 0)
        return [
            _slot(_race(inp), (race_wd,)),
            _Slot(activation, near, _RANK[KEY_RUN]),
            _slot(_easy(30, False, paces)),
        ]
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


def _as_week(
    template: WeekPlan, monday: date, placed: list[tuple[int, _Slot]]
) -> WeekPlan:
    ordered = sorted(placed, key=lambda p: (p[0], p[1].rank))
    sessions = [replace(s.draft, date=monday + timedelta(days=d)) for d, s in ordered]
    return replace(
        template,
        sessions=sessions,
        minutes=sum(s.duration_min or 0 for s in sessions),
    )


def place_week(
    template: WeekPlan,
    slots: Sequence[_Slot],
    days: Sequence[int],
    max_days: int,
    rules: Rules,
    *,
    previous: WeekPlan | None = None,
    race_date: date | None = None,
) -> WeekPlan | None:
    """The first assignment of ``slots`` to weekdays without any violation.

    Slots are placed in rank order, each trying its unused preferred days
    first, then a day it can share (at most two sessions, one of them hard,
    at most ``max_days`` days). None when no assignment exists.
    """
    monday = template.start
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
            week = _as_week(template, monday, candidate)
            if violations(week, rules, previous=previous, race_date=race_date):
                continue
            found = search(i + 1, candidate)
            if found is not None:
                return found
        return None

    found = search(0, [])
    return None if found is None else _as_week(template, monday, found)


def plan_length(inp: HybridInputs) -> int:
    """Weeks the plan covers, the current (partial) week included."""
    n_weeks = (_monday(inp.race_date) - _monday(inp.start)).days // 7 + 1
    if inp.kind == "hybrid":
        return min(n_weeks, inp.weeks)
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
    if inp.kind == "hybrid":
        # The block is anchored on its end: past weeks are not replanned.
        block_weeks = inp.weeks
        first = _monday(inp.race_date) - timedelta(weeks=block_weeks - 1)
        mondays = [first + timedelta(weeks=k) for k in range(block_weeks)]
    else:
        n_weeks = plan_length(inp)
        first = _monday(inp.race_date) - timedelta(weeks=n_weeks - 1)
        mondays = [first + timedelta(weeks=k) for k in range(n_weeks)]
    phases = _phases(mondays, inp, rules)
    current = _monday(inp.start)
    deload_first = rules.deload.triggered(inp.acwr, inp.tsb)
    if inp.kind == "hybrid":
        # Weeks already behind keep their place in the block's 3:1 rhythm.
        past = sum(1 for m in mondays if m < current)
        volumes = _volumes(phases, inp, deload_first=False)
        if deload_first and past < len(mondays) - 1 and not volumes[past][2]:
            run_minutes, _, _ = volumes[past]
            volumes[past] = (run_minutes * RECOVERY_SHARE, RECOVERY_SHARE, True)
    else:
        volumes = _volumes(phases, inp, deload_first)
    race_date = inp.race_date if inp.kind == "hyrox" else None

    weeks: list[WeekPlan] = []
    previous: WeekPlan | None = None
    for index, (monday, phase, (run_minutes, factor, recovery)) in enumerate(
        zip(mondays, phases, volumes, strict=True)
    ):
        if monday + timedelta(days=6) < inp.start:
            continue
        final = inp.kind == "hybrid" and index == len(mondays) - 1
        template = WeekPlan(start=monday, phase=phase, minutes=0, recovery=recovery)
        slots = _week_slots(inp, phase, run_minutes, factor, recovery, index, final)
        days = _available(monday, inp)
        tapering = phase in ("taper", "race")
        partial = tapering or len(days) < 7 - len(inp.rest_days)
        max_days = min(full_days, len(days) + (phase == "race"))
        week = place_week(
            template,
            slots,
            days,
            max_days,
            rules,
            previous=previous,
            race_date=race_date,
        )
        while week is None and partial:
            smaller = _drop_one(slots, _TAPER_DROP_ORDER if tapering else _DROP_ORDER)
            if smaller is None:
                break
            slots = smaller
            week = place_week(
                template,
                slots,
                days,
                max_days,
                rules,
                previous=previous,
                race_date=race_date,
            )
        if week is None:
            raise PlanError(
                f"Impossible de placer la semaine du {monday:%d/%m} sans enchaîner "
                "jambes lourdes, stations et séance clé : libère un jour "
                "d'entraînement ou retire un jour de repos."
            )
        weeks.append(week)
        previous = week
    return weeks


def _drop_one(slots: list[_Slot], order: tuple[str, ...]) -> list[_Slot] | None:
    """The slots without the first one ``order`` names; None when only the
    race (or nothing) is left."""
    for tag in order:
        for k in range(len(slots) - 1, -1, -1):
            if _primary(slots[k].draft.tags) == tag:
                return slots[:k] + slots[k + 1 :]
    return None
