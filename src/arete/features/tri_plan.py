"""Triathlon plans: swimming, cycling and running towards one race.

Four distances: sprint (S), olympic (M), half (70.3) and full (the Ironman
distance). The weeks run base, build, specific, taper and race week; every
fourth loading week is lighter (3:1). The weekly volume starts from what the
athlete recently trained in the three sports, grows 8 % a week towards a
peak set by the distance and the athlete's level, and never exceeds the
hours a week they declared. It splits between the sports by distance.

A week holds a key session and an endurance session per sport, plus an easy
ride and an easy run past the novice level. Keys follow the phase: swim
repeats from the critical swim speed (CSS), bike intervals as a share of
the functional threshold power (FTP, else heart-rate zones, else effort),
runs at the VDOT paces. From the build phase, a brick (a run straight off
the bike) joins the bike key or the long ride. Race week keeps one short
activation per sport. ``features.week_placement`` places each week under
the interference rules below. Pure: no I/O, no clock.
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
    monday_of,
    paced,
)
from arete.features.running import TrainingPaces, format_pace, race_time_sec
from arete.features.week_placement import (
    HARD,
    KEPT,
    MAX_SLOTS,
    RACE,
    AfterBlock,
    Catalog,
    Deload,
    Grouping,
    Rules,
    Slot,
    Spacing,
    Taper,
    cap_taper,
    fit_week,
    without_kept_kinds,
)

TriDistance = Literal["sprint", "olympic", "half", "full"]
Level = Literal["novice", "intermediate", "advanced"]
Sport = Literal["swim", "bike", "run"]

#: (swim, bike, run) kilometres of each distance.
LEGS_KM: dict[TriDistance, tuple[float, float, float]] = {
    "sprint": (0.75, 20.0, 5.0),
    "olympic": (1.5, 40.0, 10.0),
    "half": (1.9, 90.0, 21.1),
    "full": (3.8, 180.0, 42.2),
}
#: A goal's stored distance: the three legs added up, rounded as announced.
TRI_DISTANCE_KM: dict[TriDistance, float] = {
    "sprint": 25.75,
    "olympic": 51.5,
    "half": 113.0,
    "full": 226.0,
}
#: Hours a week a plan needs at least, by distance.
MIN_HOURS: dict[TriDistance, int] = {"sprint": 3, "olympic": 4, "half": 6, "full": 8}
MAX_HOURS = 25
#: How the plan names each distance, in French; never a trademark claim.
TRI_LABEL: dict[TriDistance, str] = {
    "sprint": "S",
    "olympic": "M",
    "half": "70.3",
    "full": "distance Ironman",
}
#: The same, after « pour » in a French sentence.
_FOR_LABEL: dict[TriDistance, str] = {
    "sprint": "un triathlon S",
    "olympic": "un triathlon M",
    "half": "un 70.3",
    "full": "une distance Ironman",
}

# --------------------------------------------------------------------------- #
# Constants by distance and level
# --------------------------------------------------------------------------- #
MIN_WEEKS: dict[TriDistance, int] = {"sprint": 6, "olympic": 8, "half": 12, "full": 16}
MAX_WEEKS: dict[TriDistance, int] = {
    "sprint": 12,
    "olympic": 16,
    "half": 20,
    "full": 24,
}
TAPER_DAYS: dict[TriDistance, int] = {
    "sprint": 7,
    "olympic": 10,
    "half": 14,
    "full": 21,
}
#: Days before the race the last hard session may fall, at the latest.
LAST_HARD_DAYS: dict[TriDistance, int] = {
    "sprint": 3,
    "olympic": 4,
    "half": 5,
    "full": 7,
}
SPECIFIC_WEEKS: dict[TriDistance, int] = {
    "sprint": 3,
    "olympic": 4,
    "half": 5,
    "full": 6,
}
#: Peak weekly hours by level, before the athlete's declared hours cap them.
PEAK_HOURS: dict[TriDistance, dict[Level, int]] = {
    "sprint": {"novice": 4, "intermediate": 6, "advanced": 8},
    "olympic": {"novice": 6, "intermediate": 8, "advanced": 10},
    "half": {"novice": 8, "intermediate": 10, "advanced": 12},
    "full": {"novice": 11, "intermediate": 14, "advanced": 17},
}
#: Weekly hours a plan starts from at least.
START_HOURS: dict[TriDistance, int] = {"sprint": 3, "olympic": 4, "half": 5, "full": 7}
#: Share of the weekly volume swum, ridden and run.
SPLIT: dict[TriDistance, tuple[float, float, float]] = {
    "sprint": (0.20, 0.40, 0.40),
    "olympic": (0.20, 0.45, 0.35),
    "half": (0.15, 0.50, 0.35),
    "full": (0.15, 0.55, 0.30),
}
#: Share of the peak the taper weeks keep, the earlier first; the race week's.
TAPER_SHARES = (0.75, 0.6)
RACE_WEEK_SHARE = 0.35
TAPER_VOLUME_SHARE = 0.6
MIN_TRAINING_DAYS = 4

#: Long session caps (minutes) by distance; the endurance swim is the swim's.
LONG_CAP: dict[Sport, dict[TriDistance, int]] = {
    "swim": {"sprint": 45, "olympic": 60, "half": 70, "full": 80},
    "bike": {"sprint": 90, "olympic": 150, "half": 210, "full": 330},
    "run": {"sprint": 60, "olympic": 80, "half": 110, "full": 150},
}
#: Share of the sport's weekly minutes its long session takes.
LONG_SHARE: dict[Sport, float] = {"swim": 0.5, "bike": 0.45, "run": 0.40}
EASY_MIN: dict[Sport, int] = {"swim": 30, "bike": 45, "run": 25}
EASY_MAX: dict[Sport, int] = {"swim": 60, "bike": 90, "run": 60}
#: Share of the sport's weekly minutes its key session aims at.
KEY_SHARE: dict[Sport, float] = {"swim": 0.5, "bike": 0.30, "run": 0.35}
KEY_MIN = 30
#: Swim pace (seconds per 100 m) sizing sessions when the CSS is unknown.
SIZING_PACE: dict[Level, int] = {"novice": 150, "intermediate": 125, "advanced": 105}
#: Seconds per 100 m slower than the CSS: easy swimming, drills, race pace.
EASY_SWIM_OFFSET = 15
SWIM_RACE_OFFSET: dict[TriDistance, tuple[int, int]] = {
    "sprint": (0, 2),
    "olympic": (0, 2),
    "half": (4, 4),
    "full": (6, 6),
}
#: Race power as a share of the FTP, by distance.
RACE_POWER: dict[TriDistance, tuple[float, float]] = {
    "sprint": (0.95, 1.00),
    "olympic": (0.88, 0.95),
    "half": (0.78, 0.85),
    "full": (0.68, 0.75),
}
#: Heart-rate zone of race power without an FTP: never 1 or 5, which Garmin
#: cannot bound (``garmin.workouts``).
RACE_ZONE: dict[TriDistance, int] = {"sprint": 4, "olympic": 4, "half": 3, "full": 2}
#: Coggan's endurance zone, the long and easy rides' watts.
ENDURANCE_POWER = (0.56, 0.75)
#: Minutes a run's pace is unknown for: 1 km at 6:00.
FALLBACK_KM_SEC = 360
RACE_ACTIVATION_DAYS: tuple[tuple[Sport, int], ...] = (
    ("swim", 3),
    ("bike", 2),
    ("run", 1),
)

# --------------------------------------------------------------------------- #
# Tags and kinds
# --------------------------------------------------------------------------- #
SWIM = "swim"
BIKE = "bike"
RUN = "run"
LONG = "long"
SWIM_KEY = "swim_key"
SWIM_EASY = "swim_easy"
BIKE_KEY = "bike_key"
LONG_RIDE = "long_ride"
BIKE_EASY = "bike_easy"
KEY_RUN = "key_run"
LONG_RUN = "long_run"
EASY_RUN = "easy_run"
#: A brick's ride: the bike key, or the long ride (``BRICK_LONG_RIDE``).
BRICK_BIKE = "brick_bike"
BRICK_LONG_RIDE = "brick_long_ride"
BRICK_RUN = "brick_run"
#: A taper week's endurance ride and run: shorter, never long.
TAPER_RIDE = "taper_ride"
TAPER_RUN = "taper_run"
ACTIVATION = "activation"
KINDS: tuple[str, ...] = (
    SWIM_KEY,
    SWIM_EASY,
    BIKE_KEY,
    LONG_RIDE,
    BIKE_EASY,
    KEY_RUN,
    LONG_RUN,
    EASY_RUN,
    BRICK_BIKE,
    BRICK_LONG_RIDE,
    BRICK_RUN,
    TAPER_RIDE,
    TAPER_RUN,
    ACTIVATION,
    RACE,
)
_SPORT_TAG = {"swimming": SWIM, "cycling": BIKE, "running": RUN}

#: Each kind a plan writes (``planned_sessions.plan_kind``) and its tags,
#: exactly those of the sessions generated as that kind (``kept_tags`` reads
#: an edited session back with them).
_KIND_TAGS: dict[str, frozenset[str]] = {
    SWIM_KEY: frozenset({SWIM, SWIM_KEY}),
    SWIM_EASY: frozenset({SWIM, SWIM_EASY}),
    BIKE_KEY: frozenset({BIKE, BIKE_KEY, HARD}),
    LONG_RIDE: frozenset({BIKE, LONG_RIDE, LONG}),
    BIKE_EASY: frozenset({BIKE, BIKE_EASY}),
    KEY_RUN: frozenset({RUN, KEY_RUN, HARD}),
    LONG_RUN: frozenset({RUN, LONG_RUN, LONG}),
    EASY_RUN: frozenset({RUN, EASY_RUN}),
    BRICK_BIKE: frozenset({BIKE, BRICK_BIKE, BIKE_KEY, HARD}),
    BRICK_LONG_RIDE: frozenset({BIKE, BRICK_BIKE, BRICK_LONG_RIDE, LONG_RIDE, LONG}),
    # Hard when run at race pace (a tempo): ``kept_tags`` adds it.
    BRICK_RUN: frozenset({RUN, BRICK_RUN}),
    TAPER_RIDE: frozenset({BIKE, TAPER_RIDE}),
    TAPER_RUN: frozenset({RUN, TAPER_RUN}),
    ACTIVATION: frozenset({ACTIVATION}),
    RACE: frozenset({RACE, HARD}),
}


def too_few_hours(distance: TriDistance, hours: float) -> str | None:
    """Why ``hours`` a week cannot prepare ``distance``, in French; None when
    they can."""
    least = MIN_HOURS[distance]
    if hours < least:
        return f"Prévois au moins {least} h par semaine pour {_FOR_LABEL[distance]}."
    return None


def tri_level(minutes_per_week: float, weekly_sports: int) -> Level:
    """Novice under 4 hours a week of swimming, cycling and running, or with
    fewer than two of them practised weekly; advanced from 8 hours with all
    three weekly; intermediate otherwise."""
    if minutes_per_week < 240 or weekly_sports < 2:
        return "novice"
    if minutes_per_week >= 480 and weekly_sports >= 3:
        return "advanced"
    return "intermediate"


#: Tuesday to Friday: a weekend long block needs two of them free for the
#: keys, its Monday holding nothing hard or long.
_MIDWEEK = frozenset({1, 2, 3, 4})


def tri_rules(
    level: Level,
    distance: TriDistance,
    *,
    rest_days: frozenset[int],
    acwr_above: float,
    tsb_below: float,
) -> Rules:
    """The interference rules: no hard ride the day before or the day of the
    key run, no long run the day before it, at most three hard days (two for
    a novice) and two in a row. The long ride and the long run may make a
    weekend block (Saturday then Sunday); the day after holds nothing hard
    or long. Without two training days from Tuesday to Friday, that Monday
    would leave the keys no room: the long days then stay apart. The deload
    thresholds are injected."""
    if len(_MIDWEEK - rest_days) >= 2:
        long_days: dict[str, Any] = {
            "after_block": (
                AfterBlock("after_long_block", LONG, 2, frozenset({HARD, LONG})),
            )
        }
        grouping: tuple[Grouping, ...] = ()
    else:
        long_days = {}
        grouping = (Grouping("long_days", LONG, 2, 1),)
    return Rules(
        spacing=(
            Spacing("bike_key_before_key_run", BIKE_KEY, KEY_RUN, 2, "never"),
            Spacing("long_run_before_key_run", LONG_RUN, KEY_RUN, 2, "never"),
        ),
        grouping=(
            Grouping("hard_days", HARD, 2 if level == "novice" else 3, 2),
            *grouping,
        ),
        deload=Deload("deload", acwr_above, tsb_below),
        taper=Taper(
            "taper",
            TAPER_DAYS[distance],
            TAPER_VOLUME_SHARE,
            LONG,
            LAST_HARD_DAYS[distance],
        ),
        **long_days,
    )


# --------------------------------------------------------------------------- #
# Catalog
# --------------------------------------------------------------------------- #
def _may_share(same: Sequence[Slot], slot: Slot) -> bool:
    """Two sessions on one day: a brick's two halves, or one swim with a
    session that is neither long nor the race. A brick slot already fills
    its day (``MAX_PER_DAY``)."""
    tags = [d.tags for s in [*same, slot] for d in s.drafts]
    if len(tags) != 2 or any(RACE in t for t in tags):
        return False
    bricks = [t for t in tags if BRICK_BIKE in t or BRICK_RUN in t]
    if bricks:
        return len(bricks) == 2 and {BRICK_BIKE in t for t in bricks} == {True, False}
    swims = [t for t in tags if SWIM in t]
    if len(swims) != 1:
        return False
    other = next(t for t in tags if SWIM not in t)
    return not other & {LONG_RIDE, LONG_RUN, TAPER_RIDE, TAPER_RUN}


_RANK = {
    RACE: 0,
    # Pinned to their days before the others choose theirs.
    ACTIVATION: 0,
    BRICK_BIKE: 1,
    BRICK_LONG_RIDE: 1,
    LONG_RIDE: 1,
    TAPER_RIDE: 1,
    LONG_RUN: 2,
    TAPER_RUN: 2,
    BIKE_KEY: 3,
    KEY_RUN: 4,
    SWIM_KEY: 5,
    SWIM_EASY: 5,
    BIKE_EASY: 6,
    EASY_RUN: 7,
    # A brick's run alone (its bike kept as edited) comes after it.
    BRICK_RUN: 9,
}
_PREFS: dict[str, tuple[int, ...]] = {
    LONG_RIDE: (5, 6, 4, 3, 2, 1, 0),
    BRICK_LONG_RIDE: (5, 6, 4, 3, 2, 1, 0),
    TAPER_RIDE: (5, 6, 4, 3, 2, 1, 0),
    LONG_RUN: (6, 4, 3, 2, 1, 0, 5),
    TAPER_RUN: (6, 4, 3, 2, 1, 0, 5),
    BIKE_KEY: (1, 2, 3, 4, 0, 5, 6),
    BRICK_BIKE: (1, 2, 3, 4, 0, 5, 6),
    KEY_RUN: (3, 2, 4, 1, 5, 0, 6),
    SWIM_KEY: (0, 2, 4, 1, 3, 5, 6),
    SWIM_EASY: (0, 2, 4, 1, 3, 5, 6),
    BIKE_EASY: (2, 4, 0, 3, 1, 5, 6),
    EASY_RUN: (4, 0, 2, 1, 3, 5, 6),
}
_LABELS = {
    SWIM_KEY: "Natation clé",
    SWIM_EASY: "Natation endurance",
    BIKE_KEY: "Vélo clé",
    LONG_RIDE: "Sortie longue vélo",
    BIKE_EASY: "Vélo facile",
    KEY_RUN: "Course clé",
    LONG_RUN: "Sortie longue course",
    EASY_RUN: "Footing",
    BRICK_BIKE: "Enchaînement vélo-course",
    BRICK_LONG_RIDE: "Enchaînement sortie longue-course",
    BRICK_RUN: "Course en enchaînement",
    TAPER_RIDE: "Sortie vélo d'endurance",
    TAPER_RUN: "Footing long",
    ACTIVATION: "Activation",
}
#: What a week may give up when the rules leave no room, least important
#: first. A full week keeps its keys and long sessions; a partial week may
#: lose anything but the race; a taper week loses its keys first.
_FULL_DROPS = (EASY_RUN, BIKE_EASY, SWIM_EASY)
_PARTIAL_DROPS = (
    EASY_RUN,
    BIKE_EASY,
    SWIM_EASY,
    BRICK_RUN,
    SWIM_KEY,
    ACTIVATION,
    KEY_RUN,
    BIKE_KEY,
    TAPER_RUN,
    LONG_RUN,
    BRICK_BIKE,
    TAPER_RIDE,
    LONG_RIDE,
    BRICK_LONG_RIDE,
)
_TAPER_DROPS = (
    BIKE_KEY,
    KEY_RUN,
    EASY_RUN,
    BIKE_EASY,
    SWIM_EASY,
    SWIM_KEY,
    TAPER_RUN,
    TAPER_RIDE,
    LONG_RUN,
    LONG_RIDE,
    ACTIVATION,
)
#: Sessions a week gives up, in order, when its minutes exceed the hours the
#: athlete declared; long sessions shrink to their minimum before the swim key.
_BUDGET_DROPS = (EASY_RUN, BIKE_EASY, SWIM_EASY)
_NO_ROOM = "pas de jour libre sans enfreindre les règles d'enchaînement"
_NO_TIME = "pas assez d'heures disponibles cette semaine"
_ACTIVATIONS = "la semaine garde les activations d'avant-course"
_BIKE_NOT_RECREATED = (
    "Vélo de l'enchaînement non recréé : tu as modifié la course qui le suit."
)

#: Triathlon session kinds, as ``week_placement`` places them.
TRI = Catalog(
    kinds=(
        RACE,
        ACTIVATION,
        BRICK_LONG_RIDE,
        BRICK_BIKE,
        BRICK_RUN,
        LONG_RIDE,
        LONG_RUN,
        TAPER_RIDE,
        TAPER_RUN,
        BIKE_KEY,
        KEY_RUN,
        SWIM_KEY,
        SWIM_EASY,
        BIKE_EASY,
    ),
    default_kind=EASY_RUN,
    prefs=_PREFS,
    rank=_RANK,
    labels=_LABELS,
    taper_drops=_TAPER_DROPS,
    may_share=_may_share,
)


def kind_of(tags: frozenset[str]) -> str:
    """The kind a generated session is stored with, from its tags."""
    return TRI.primary(tags)


def kept_tags(
    kind: str, sport: str, session_type: str, intensity: str | None
) -> frozenset[str] | None:
    """A kept session's tags: its kind's, its sport's, marked kept; hard when
    its current content is, whatever it was generated as (an easy ride turned
    into intervals). None for a kind this module does not write. A swim's
    repeats and an activation stay light unless made hard explicitly."""
    tags = _KIND_TAGS.get(kind)
    if tags is None:
        return None
    tags = tags | {KEPT} | ({_SPORT_TAG[sport]} if sport in _SPORT_TAG else set())
    hard_type = (
        session_type in ("tempo", "intervals", "race")
        and kind != ACTIVATION
        and sport != "swimming"
    )
    if intensity == "hard" or hard_type:
        tags = tags | {HARD}
    return tags


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class TriInputs:
    start: date  # first day the plan may fill
    race_date: date
    distance: TriDistance
    level: Level
    #: Hours a week the athlete declared: no week goes past them.
    hours_per_week: float
    #: Swimming, cycling and running minutes per week, last 4 weeks.
    weekly_minutes_now: float
    #: Days a week the athlete trains; more sessions pair on the same day.
    training_days: int
    rest_days: frozenset[int] = frozenset()  # weekdays, Monday 0
    paces: TrainingPaces | None = None
    ftp_w: int | None = None
    css_sec_100m: int | None = None
    #: A threshold or maximum heart rate is known: rides can target zones.
    hr_reference: bool = False
    pool_length_m: int = 25
    race_name: str = "Triathlon"
    acwr: float | None = None
    tsb: float | None = None
    #: Sessions the athlete edited, dated and tagged (``kept_tags``): the
    #: rules see them, their days stay theirs and each replaces its kind.
    kept: tuple[DraftSession, ...] = ()


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #
def _round5(minutes: float) -> int:
    return round(minutes / 5) * 5


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _hm(minutes: int) -> str:
    return f"{minutes // 60}h{minutes % 60:02d}"


def _swim_clock(sec_per_100m: int) -> str:
    return f"{sec_per_100m // 60}:{sec_per_100m % 60:02d}"


def _swim_pace(inp: TriInputs) -> int:
    return inp.css_sec_100m or SIZING_PACE[inp.level]


def _swim_note(inp: TriInputs, offsets: tuple[int, int], effort: str) -> str:
    """The pace a swim effort aims at (CSS + offsets), or its effort."""
    if inp.css_sec_100m is None:
        return effort
    low, high = (inp.css_sec_100m + o for o in offsets)
    label = (
        "CSS"
        if offsets == (0, 0)
        else (
            f"CSS+{offsets[0]} s"
            if offsets[0] == offsets[1]
            else f"CSS à CSS+{offsets[1]} s"
        )
    )
    span = (
        _swim_clock(low) if low == high else f"{_swim_clock(low)}–{_swim_clock(high)}"
    )
    return f"allure {label} ({span}/100 m)"


def _rounded_meters(meters: float, pool: int) -> int:
    """A distance a whole number of lengths, at least one length."""
    lengths = max(1, round(meters / pool))
    return int(lengths * pool)


def _swim_session(
    inp: TriInputs,
    title: str,
    blocks: Sequence[tuple[int, int, int, tuple[int, int], str]],
    tags: frozenset[str],
    session_type: str,
    hr_zone: str | None,
    intensity: str,
    warmup_m: int = 300,
    drills: int = 8,
    cooldown_m: int = 200,
) -> DraftSession:
    """Warm-up, drills, then ``blocks`` of (reps, meters, rest seconds, CSS
    offsets, effort without a CSS), then cool-down; every distance a whole
    number of the pool's lengths, no target (Garmin refuses swim targets)."""
    pool = inp.pool_length_m
    pace = _swim_pace(inp)
    easy = pace + EASY_SWIM_OFFSET
    steps: list[dict[str, Any]] = [
        {
            "kind": "warmup",
            "duration_kind": "meters",
            "value": _rounded_meters(warmup_m, pool),
            "stroke": "free",
            "notes": "facile",
        }
    ]
    seconds = steps[0]["value"] / 100 * easy
    meters = steps[0]["value"]
    parts = [f"{steps[0]['value']} m souple"]
    if drills:
        drill_m = _rounded_meters(50, pool)
        steps.append(
            {
                "kind": "repeat",
                "repeat": drills,
                "steps": [
                    {
                        "kind": "effort",
                        "duration_kind": "meters",
                        "value": drill_m,
                        "notes": "éducatifs",
                    },
                    {"kind": "rest", "duration_kind": "seconds", "value": 15},
                ],
            }
        )
        seconds += drills * (drill_m / 100 * easy + 15)
        meters += drills * drill_m
        parts.append(f"{drills}×{drill_m} m éducatifs")
    for reps, distance_m, rest, offsets, effort in blocks:
        each = _rounded_meters(distance_m, pool)
        note = _swim_note(inp, offsets, effort)
        effort_step = {
            "kind": "effort",
            "duration_kind": "meters",
            "value": each,
            "stroke": "free",
            "notes": note,
        }
        rest_step = {"kind": "rest", "duration_kind": "seconds", "value": rest}
        if reps > 1:
            steps.append(
                {"kind": "repeat", "repeat": reps, "steps": [effort_step, rest_step]}
            )
        else:
            steps.append(effort_step)
        seconds += reps * (each / 100 * (pace + offsets[1]) + rest)
        meters += reps * each
        parts.append(f'{reps}×{each} m {note}, récup {rest}"')
    cooldown = _rounded_meters(cooldown_m, pool)
    steps.append(
        {
            "kind": "cooldown",
            "duration_kind": "meters",
            "value": cooldown,
            "notes": "souple",
        }
    )
    seconds += cooldown / 100 * easy
    meters += cooldown
    parts.append(f"{cooldown} m souple")
    return DraftSession(
        date.min,
        session_type,
        max(KEY_MIN, _round5(seconds / 60)),
        hr_zone,
        intensity,
        f"{title} ({meters} m) : " + " + ".join(parts),
        distance_km=meters / 1000,
        sport="swimming",
        prescription={"version": 1, "pool_length_m": inp.pool_length_m, "steps": steps},
        tags=tags,
    )


def _swim_key(
    inp: TriInputs, phase: Phase, recovery: bool, budget: float
) -> DraftSession:
    """Base: N×100 at CSS+8 s; build: N×100 at CSS (at most 10); specific:
    race-pace repeats by distance (3×300, 4×400, 3×600, 2×1000 at most);
    each N fitting the week's swim minutes; taper: 6×100 at race pace. A
    short swim week keeps four drills instead of eight."""
    tags = _KIND_TAGS[SWIM_KEY]
    race = SWIM_RACE_OFFSET[inp.distance]
    target = max(KEY_MIN, _round5(budget * KEY_SHARE["swim"])) * 60
    drills = 8 if target >= 40 * 60 else 4
    if phase == "taper":
        return _swim_session(
            inp,
            "Natation rappel",
            [(6, 100, 30, race, "allure course")],
            tags,
            "intervals",
            None,
            "moderate",
            drills=4,
        )
    pace = _swim_pace(inp)
    easy = pace + EASY_SWIM_OFFSET
    pool = inp.pool_length_m
    drill_m = _rounded_meters(50, pool)
    room = target - (
        (_rounded_meters(300, pool) + _rounded_meters(200, pool)) / 100 * easy
        + drills * (drill_m / 100 * easy + 15)
    )
    if phase in ("base", "build") or recovery:
        base = phase == "base" or recovery
        offset = 8 if base else 0
        reps = _clamp(int(room // (pace + offset + 20)), 4, 20 if base else 10)
        return _swim_session(
            inp,
            "Natation technique" if base else "Natation seuil",
            [
                (
                    reps,
                    100,
                    20,
                    (offset, offset),
                    "allure régulière, effort 6/10"
                    if base
                    else "allure seuil, effort 7/10",
                )
            ],
            tags,
            "endurance" if base else "intervals",
            None,
            "moderate",
            drills=drills,
        )
    most, distance_m = {
        "sprint": (3, 300),
        "olympic": (4, 400),
        "half": (3, 600),
        "full": (2, 1000),
    }[inp.distance]
    each = distance_m / 100 * (pace + race[1]) + 30
    reps = _clamp(int(room // each), 2 if most > 2 else 1, most)
    return _swim_session(
        inp,
        "Natation spécifique",
        [(reps, distance_m, 30, race, "allure course, effort 7/10")],
        tags,
        "intervals",
        None,
        "moderate",
        drills=drills,
    )


def _swim_endurance(inp: TriInputs, minutes: int, recovery: bool) -> DraftSession:
    """One continuous swim: the meters the minutes hold at an easy pace, in
    whole hundreds (whole lengths of either pool), its pace in the notes."""
    pace = ""
    if inp.css_sec_100m is not None:
        pace = f" ({_swim_clock(inp.css_sec_100m + EASY_SWIM_OFFSET)}/100 m)"
    easy = _swim_pace(inp) + EASY_SWIM_OFFSET
    meters = max(100, round(minutes * 60 / easy) * 100)
    note = f"nage continue facile{pace}"
    step = {
        "kind": "effort",
        "duration_kind": "meters",
        "value": _rounded_meters(meters, inp.pool_length_m),
        "stroke": "free",
        "notes": note,
    }
    return DraftSession(
        date.min,
        "recovery" if recovery else "endurance",
        minutes,
        "Z2",
        "easy",
        f"Natation endurance {minutes}' ({meters} m) : {note}",
        distance_km=meters / 1000,
        sport="swimming",
        prescription={
            "version": 1,
            "pool_length_m": inp.pool_length_m,
            "steps": [step],
        },
        tags=_KIND_TAGS[SWIM_EASY],
    )


@dataclass(frozen=True)
class _Interval:
    """A bike interval set: ``reps`` (fitted between bounds) × ``minutes`` at
    ``power`` (share of the FTP), ``rest`` minutes between."""

    name: str
    minutes: int
    rest: int
    reps: tuple[int, int]
    power: tuple[float, float]
    zone: int
    rpe: str
    session_type: str


def _bike_interval(
    inp: TriInputs, phase: Phase, recovery: bool, week: int
) -> _Interval:
    d = inp.distance
    race = RACE_POWER[d]
    if phase == "taper":
        return _Interval(
            "Vélo rappel allure course",
            5,
            3,
            (3, 3),
            race,
            RACE_ZONE[d],
            "allure course",
            "intervals",
        )
    if phase == "base" or recovery:
        return _Interval(
            "Vélo tempo", 10, 5, (2, 3), (0.76, 0.87), 3, "effort 6/10", "tempo"
        )
    sweet = _Interval(
        "Vélo sweet spot", 12, 5, (2, 3), (0.88, 0.94), 3, "effort 7/10", "tempo"
    )
    if phase == "build":
        if d in ("sprint", "olympic") and week % 2:
            return _Interval(
                "Vélo PMA", 3, 3, (4, 5), (1.06, 1.20), 4, "effort 8-9/10", "intervals"
            )
        return sweet
    return {
        "sprint": _Interval(
            "Vélo spécifique S", 8, 4, (3, 4), race, 4, "effort 8/10", "intervals"
        ),
        "olympic": _Interval(
            "Vélo spécifique M", 15, 5, (2, 3), race, 4, "effort 7-8/10", "tempo"
        ),
        "half": _Interval(
            "Vélo spécifique 70.3", 30, 10, (2, 2), race, 3, "effort 6-7/10", "tempo"
        ),
        # The Ironman's race power lives in its long ride: the key stays sweet spot.
        "full": sweet,
    }[d]


def _target(
    inp: TriInputs, power: tuple[float, float], zone: int
) -> dict[str, Any] | None:
    """Watts from the FTP, else a heart-rate zone when one is known, else none."""
    if inp.ftp_w:
        return {
            "kind": "power_w",
            "low": round(inp.ftp_w * power[0]),
            "high": round(inp.ftp_w * power[1]),
        }
    if inp.hr_reference:
        return {"kind": "hr_zone", "low": zone, "high": zone}
    return None


def _intensity_text(
    inp: TriInputs, power: tuple[float, float], zone: int, rpe: str
) -> str:
    share = f"{round(power[0] * 100)}–{round(power[1] * 100)} % FTP"
    if inp.ftp_w:
        return (
            f"{share} ({round(inp.ftp_w * power[0])}–{round(inp.ftp_w * power[1])} W)"
        )
    if inp.hr_reference:
        return f"zone {zone} FC ({rpe})"
    return rpe


def _effort_step(
    inp: TriInputs, minutes: int, power: tuple[float, float], zone: int, rpe: str
) -> dict[str, Any]:
    step: dict[str, Any] = {
        "kind": "effort",
        "duration_kind": "seconds",
        "value": minutes * 60,
    }
    target = _target(inp, power, zone)
    if target is None:
        step["notes"] = rpe
    else:
        step["target"] = target
    return step


def _interval_steps(
    inp: TriInputs,
    reps: int,
    minutes: int,
    rest: int,
    power: tuple[float, float],
    zone: int,
    rpe: str,
) -> list[dict[str, Any]]:
    effort = _effort_step(inp, minutes, power, zone, rpe)
    if reps == 1:
        return [effort]
    return [
        {
            "kind": "repeat",
            "repeat": reps,
            "skip_last_recovery": True,
            "steps": [
                effort,
                {"kind": "recovery", "duration_kind": "seconds", "value": rest * 60},
            ],
        }
    ]


def _bike_key(
    inp: TriInputs, phase: Phase, recovery: bool, week: int, budget: float
) -> DraftSession:
    spec = _bike_interval(inp, phase, recovery, week)
    target = max(KEY_MIN, _round5(budget * KEY_SHARE["bike"]))
    warmup, cooldown = (15, 10) if target >= 60 else (10, 5)
    low, high = spec.reps
    reps = _clamp(
        (target - warmup - cooldown + spec.rest) // (spec.minutes + spec.rest),
        low,
        high,
    )
    work = reps * spec.minutes + (reps - 1) * spec.rest
    cooldown += -(warmup + work + cooldown) % 5  # a whole number of 5 minutes
    minutes = warmup + work + cooldown
    steps = [
        {"kind": "warmup", "duration_kind": "seconds", "value": warmup * 60},
        *_interval_steps(
            inp, reps, spec.minutes, spec.rest, spec.power, spec.zone, spec.rpe
        ),
        {"kind": "cooldown", "duration_kind": "seconds", "value": cooldown * 60},
    ]
    text = _intensity_text(inp, spec.power, spec.zone, spec.rpe)
    return DraftSession(
        date.min,
        spec.session_type,
        minutes,
        f"Z{spec.zone}",
        "moderate" if phase == "taper" or recovery or phase == "base" else "hard",
        f"{spec.name} : {reps}×{spec.minutes}' à {text}, récup {spec.rest}', "
        f"échauffement {warmup}' et retour au calme {cooldown}'",
        sport="cycling",
        prescription={"version": 1, "steps": steps},
        tags=_KIND_TAGS[BIKE_KEY],
    )


def _endurance_watts(inp: TriInputs) -> str:
    if not inp.ftp_w:
        return "Z2, aisance respiratoire"
    low, high = (round(inp.ftp_w * p) for p in ENDURANCE_POWER)
    return f"Z2, {low}–{high} W"


def _long_ride(
    inp: TriInputs, phase: Phase, recovery: bool, minutes: int
) -> DraftSession:
    """The week's long ride; an Ironman's specific weeks hold race-power
    blocks in it, a taper's is a shorter endurance ride (not long)."""
    if phase == "taper":
        return DraftSession(
            date.min,
            "endurance",
            minutes,
            "Z2",
            "easy",
            f"Sortie vélo d'endurance {_hm(minutes)} ({_endurance_watts(inp)})",
            sport="cycling",
            tags=_KIND_TAGS[TAPER_RIDE],
        )
    tags = _KIND_TAGS[LONG_RIDE]
    description = f"Sortie longue vélo {_hm(minutes)} ({_endurance_watts(inp)})"
    if (
        inp.distance == "full"
        and phase == "specific"
        and not recovery
        and minutes >= 150
    ):
        blocks = 3 if minutes >= 170 else 2
        power, zone = RACE_POWER["full"], RACE_ZONE["full"]
        middle = blocks * 30 + (blocks - 1) * 10
        warmup = (minutes - middle) // 2
        steps = [
            {"kind": "warmup", "duration_kind": "seconds", "value": warmup * 60},
            *_interval_steps(inp, blocks, 30, 10, power, zone, "allure course"),
            {
                "kind": "cooldown",
                "duration_kind": "seconds",
                "value": (minutes - middle - warmup) * 60,
            },
        ]
        text = _intensity_text(inp, power, zone, "allure course")
        # An endurance ride holding its race power (68-75 % FTP), not a hard one.
        return DraftSession(
            date.min,
            "endurance",
            minutes,
            "Z2",
            "moderate",
            f"{description}, dont {blocks}×30' à {text}, récup 10'",
            sport="cycling",
            prescription={"version": 1, "steps": steps},
            tags=tags,
        )
    return DraftSession(
        date.min,
        "endurance",
        minutes,
        "Z2",
        "easy",
        description,
        sport="cycling",
        tags=tags,
    )


def _bike_easy(inp: TriInputs, minutes: int, recovery: bool) -> DraftSession:
    return DraftSession(
        date.min,
        "recovery" if recovery else "endurance",
        minutes,
        "Z1" if recovery else "Z2",
        "easy",
        f"Vélo facile {_hm(minutes)} ({_endurance_watts(inp)})",
        sport="cycling",
        tags=_KIND_TAGS[BIKE_EASY],
    )


def _race_pace_label(inp: TriInputs, km: float, label: str = "allure course") -> str:
    if inp.paces is None:
        return label
    seconds = race_time_sec(inp.paces.vdot, km * 1000) / km
    return f"{label} ({format_pace(round(seconds))})"


def _run_seconds(inp: TriInputs, attr: str) -> float:
    if inp.paces is None:
        return FALLBACK_KM_SEC
    return float(getattr(inp.paces, attr))


def _key_run(
    inp: TriInputs, phase: Phase, recovery: bool, week: int, budget: float
) -> DraftSession:
    """Threshold in base, threshold or kilometre repeats in build, race pace
    by distance in specific, a reminder in the taper; written as the running
    grammar reads them (``paced``)."""
    tags = _KIND_TAGS[KEY_RUN]
    run_km = LEGS_KM[inp.distance][2]
    target = max(KEY_MIN, _round5(budget * KEY_SHARE["run"]))
    t = paced("au seuil", inp.paces, "threshold")

    # Warm-up and cool-down together: shorter when the week runs little.
    frame = 20 if target >= 40 else 15

    def threshold(reps: tuple[int, int], intensity: str) -> DraftSession:
        n = _clamp((target - frame + 2) // 12, *reps)
        return DraftSession(
            date.min,
            "tempo",
            _round5(frame + n * 10 + (n - 1) * 2),
            "Z4",
            intensity,
            f"Seuil : {n}×10' {t}, récup 2'",
            tags=tags,
        )

    if phase == "taper":
        return DraftSession(
            date.min,
            "intervals",
            40,
            "Z4",
            "moderate",
            f"Rappel : 4×3' {_race_pace_label(inp, run_km)}, récup 2'",
            tags=tags,
        )
    if phase == "base" or recovery:
        return threshold((2, 2), "moderate")
    if phase == "build" and week % 2:
        km_min = _run_seconds(inp, "interval") / 60
        n = _clamp(int((target - frame + 2) // (km_min + 2)), 4, 5)
        i = paced("à l'allure VMA", inp.paces, "interval")
        return DraftSession(
            date.min,
            "intervals",
            _round5(frame + n * km_min + (n - 1) * 2),
            "Z5",
            "hard",
            f"Fractionné : {n}×1000 m {i}, récup 2'",
            tags=tags,
        )
    if phase == "build" or inp.distance == "full":
        return threshold((2, 3), "hard")
    if inp.distance == "half":
        if inp.paces is None:
            pace = "allure semi-marathon"
        else:
            pace = (
                f"allure semi-marathon ({format_pace(inp.paces.threshold)[:-3]} à "
                f"{format_pace(inp.paces.marathon)})"
            )
        return DraftSession(
            date.min,
            "tempo",
            55,
            "Z4",
            "hard",
            f"Spécifique : 2×15' {pace}, récup 3'",
            tags=tags,
        )
    km_min = (race_time_sec(inp.paces.vdot, 10_000) / 600) if inp.paces else 6.0
    n = _clamp(int((target - frame + 1) // (km_min + 1)), 3, 4)
    return DraftSession(
        date.min,
        "intervals",
        _round5(frame + n * km_min + (n - 1)),
        "Z4",
        "hard",
        f"Spécifique : {n}×1 km {_race_pace_label(inp, 10.0, 'allure 10 km')}, récup 1'",
        tags=tags,
    )


def _long_run(
    inp: TriInputs, phase: Phase, recovery: bool, minutes: int
) -> DraftSession:
    if phase == "taper":
        return DraftSession(
            date.min,
            "endurance",
            minutes,
            "Z2",
            "easy",
            paced(f"Footing long {_hm(minutes)}", inp.paces, "easy"),
            tags=_KIND_TAGS[TAPER_RUN],
        )
    description = paced(f"Sortie longue {_hm(minutes)}", inp.paces, "easy")
    if (
        inp.distance == "full"
        and phase == "specific"
        and not recovery
        and minutes >= 70
    ):
        marathon = paced("allure marathon", inp.paces, "marathon")
        description += f", dont 2×20' {marathon}"
    return DraftSession(
        date.min,
        "long_run",
        minutes,
        "Z2",
        "easy",
        description,
        tags=_KIND_TAGS[LONG_RUN],
    )


def _easy_run(inp: TriInputs, minutes: int, recovery: bool) -> DraftSession:
    return DraftSession(
        date.min,
        "recovery" if recovery else "endurance",
        minutes,
        "Z1" if recovery else "Z2",
        "easy",
        paced("Footing", inp.paces, "easy"),
        tags=_KIND_TAGS[EASY_RUN],
    )


def _brick_run_minutes(inp: TriInputs, phase: Phase, recovery: bool) -> int:
    if recovery:
        return 10
    if phase == "build":
        return 10 if inp.level == "novice" else 15
    return {
        "sprint": 15,
        "olympic": 20,
        "half": 30,
        "full": 45 if inp.level == "advanced" else 30,
    }[inp.distance]


def _brick_run(inp: TriInputs, phase: Phase, recovery: bool) -> DraftSession:
    minutes = _brick_run_minutes(inp, phase, recovery)
    run_km = LEGS_KM[inp.distance][2]
    prescription = None
    if phase == "specific" and not recovery and inp.distance in ("sprint", "olympic"):
        content = f"{minutes}' dont 5' {_race_pace_label(inp, run_km)} au départ"
        session_type, intensity = "tempo", "moderate"
        tags = _KIND_TAGS[BRICK_RUN] | {HARD}  # race pace off the bike
        # The running grammar does not read this tempo: its steps are written.
        fast: dict[str, Any] = {
            "kind": "effort",
            "duration_kind": "seconds",
            "value": 300,
        }
        easy: dict[str, Any] = {
            "kind": "effort",
            "duration_kind": "seconds",
            "value": (minutes - 5) * 60,
            "notes": "facile",
        }
        if inp.paces is None:
            fast["notes"] = "allure course"
        else:
            pace = round(race_time_sec(inp.paces.vdot, run_km * 1000) / run_km)
            fast["target"] = {"kind": "pace_sec_km", "low": pace - 5, "high": pace + 5}
            slow, quick = inp.paces.easy
            easy["target"] = {"kind": "pace_sec_km", "low": quick, "high": slow}
        prescription = {"version": 1, "steps": [fast, easy]}
    else:
        content = paced(f"{minutes}' facile", inp.paces, "easy")
        session_type, intensity = "endurance", "easy"
        tags = _KIND_TAGS[BRICK_RUN]
    return DraftSession(
        date.min,
        session_type,
        minutes,
        "Z2",
        intensity,
        f"Course en enchaînement, juste après le vélo : {content}",
        prescription=prescription,
        tags=tags,
    )


def _as_brick_bike(bike: DraftSession, long: bool) -> DraftSession:
    return replace(
        bike,
        description=f"{bike.description}, puis enchaînement course à pied",
        tags=bike.tags | {BRICK_BIKE} | ({BRICK_LONG_RIDE} if long else set()),
    )


def _activation(inp: TriInputs, sport: Sport) -> DraftSession:
    if sport == "swim":
        return _swim_session(
            inp,
            "Activation natation",
            [(4, 50, 30, SWIM_RACE_OFFSET[inp.distance], "allure course")],
            frozenset({SWIM, ACTIVATION}),
            "intervals",
            "Z3",
            "moderate",
            warmup_m=400,
            drills=4,
            cooldown_m=200,
        )
    # Neither description is read by a grammar: their steps are written.
    if sport == "bike":
        d = inp.distance
        steps = [
            {"kind": "warmup", "duration_kind": "seconds", "value": 15 * 60},
            *_interval_steps(
                inp, 3, 1, 2, RACE_POWER[d], RACE_ZONE[d], "allure course"
            ),
            {"kind": "cooldown", "duration_kind": "seconds", "value": 8 * 60},
        ]
        return DraftSession(
            date.min,
            "intervals",
            30,
            "Z3",
            "moderate",
            "Activation vélo 30' facile avec 3×1' allure course ; vérifie ton vélo "
            "(pneus, freins, vitesses)",
            sport="cycling",
            prescription={"version": 1, "steps": steps},
            tags=frozenset({BIKE, ACTIVATION}),
        )
    steps = [
        {"kind": "warmup", "duration_kind": "seconds", "value": 10 * 60},
        {
            "kind": "repeat",
            "repeat": 4,
            "skip_last_recovery": True,
            "steps": [
                {
                    "kind": "effort",
                    "duration_kind": "seconds",
                    "value": 20,
                    "notes": "accélération",
                },
                {"kind": "recovery", "duration_kind": "seconds", "value": 40},
            ],
        },
        {"kind": "cooldown", "duration_kind": "seconds", "value": 100},
    ]
    return DraftSession(
        date.min,
        "intervals",
        15,
        "Z3",
        "moderate",
        "Activation : 15' facile + 4 accélérations",
        prescription={"version": 1, "steps": steps},
        tags=frozenset({RUN, ACTIVATION}),
    )


def _race(inp: TriInputs) -> DraftSession:
    swim, bike, run = LEGS_KM[inp.distance]
    km = f"{swim:g}".replace(".", ",")
    return DraftSession(
        date.min,
        "race",
        None,
        None,
        "hard",
        f"{inp.race_name} — Triathlon {TRI_LABEL[inp.distance]} : {km} km natation · "
        f"{bike:g} km vélo · {f'{run:g}'.replace('.', ',')} km course à pied",
        distance_km=TRI_DISTANCE_KM[inp.distance],
        sport="other",
        tags=_KIND_TAGS[RACE],
    )


# --------------------------------------------------------------------------- #
# Weeks
# --------------------------------------------------------------------------- #
def plan_length(inp: TriInputs) -> int:
    """Weeks a triathlon plan covers, the current (partial) week included."""
    n_weeks = (monday_of(inp.race_date) - monday_of(inp.start)).days // 7 + 1
    least = MIN_WEEKS[inp.distance]
    if n_weeks < least:
        raise PlanError(
            f"Triathlon {TRI_LABEL[inp.distance]} dans moins de {least} semaines : "
            "trop tard pour un plan complet, garde tes séances actuelles et allège "
            "la dernière semaine."
        )
    return min(n_weeks, MAX_WEEKS[inp.distance])


def _phases(mondays: list[date], inp: TriInputs) -> list[Phase]:
    """Each week's phase: the race week last, taper for every other week
    whose Thursday is in the taper's days, loading phases compressed before."""
    taper_from = inp.race_date - timedelta(days=TAPER_DAYS[inp.distance])
    taper = sum(1 for m in mondays[:-1] if m + timedelta(days=3) >= taper_from)
    loading = len(mondays) - taper - 1
    specific = min(SPECIFIC_WEEKS[inp.distance], loading // 3)
    build = (loading - specific) // 2
    base = loading - specific - build
    counts: tuple[tuple[Phase, int], ...] = (
        ("base", base),
        ("build", build),
        ("specific", specific),
        ("taper", taper),
        ("race", 1),
    )
    return [phase for phase, n in counts for _ in range(n)]


def peak_minutes(inp: TriInputs) -> float:
    """The plan's highest weekly minutes: the level's peak, within the
    declared hours."""
    return min(PEAK_HOURS[inp.distance][inp.level], inp.hours_per_week) * 60


def _volumes(
    phases: list[Phase], inp: TriInputs, deload_first: bool
) -> list[tuple[float, bool]]:
    """(minutes, recovery week?) per week."""
    peak_cap = peak_minutes(inp)
    floor = min(START_HOURS[inp.distance] * 60, peak_cap)
    current = max(float(floor), min(inp.weekly_minutes_now, peak_cap))
    peak = current
    tapers = phases.count("taper")
    seen = 0
    loading_index = 0
    out: list[tuple[float, bool]] = []
    for index, phase in enumerate(phases):
        if phase == "taper":
            seen += 1
            share = TAPER_SHARES[-1] if seen == tapers else TAPER_SHARES[0]
            out.append((peak * share, False))
        elif phase == "race":
            out.append((peak * RACE_WEEK_SHARE, False))
        elif index == 0 and deload_first:
            out.append((current * RECOVERY_SHARE, True))
        else:
            loading_index += 1
            if loading_index % 4 == 0:
                out.append((current * RECOVERY_SHARE, True))
                continue
            if loading_index > 1:
                current = min(current * WEEKLY_GROWTH, peak_cap)
            peak = max(peak, current)
            out.append((current, False))
    return out


def _long_minutes(sport: Sport, budget: float, distance: TriDistance) -> int:
    return _clamp(
        _round5(budget * LONG_SHARE[sport]), EASY_MIN[sport], LONG_CAP[sport][distance]
    )


def _fill(sport: Sport, left: float) -> int:
    return _clamp(_round5(left), EASY_MIN[sport], EASY_MAX[sport])


@dataclass
class _Item:
    """A session, or a brick's two, before placement."""

    kind: str
    drafts: tuple[DraftSession, ...]
    prefs: tuple[int, ...] | None = None
    #: A brick's bike session as it is without the run, and its kind.
    solo: tuple[str, DraftSession] | None = None

    @property
    def minutes(self) -> int:
        return sum(d.duration_min or 0 for d in self.drafts)


def _loading_items(
    inp: TriInputs,
    phase: Phase,
    minutes: float,
    recovery: bool,
    week: int,
    endurance_longs: bool = False,
) -> list[_Item]:
    """A base, build, specific or taper week's sessions, sized from its
    minutes split between the sports. ``endurance_longs``: the long ride and
    run take their taper form (not long), and a brick joins the bike key."""
    longs: Phase = "taper" if endurance_longs else phase
    swim_m, bike_m, run_m = (minutes * share for share in SPLIT[inp.distance])
    novice = inp.level == "novice"

    swim_key = _swim_key(inp, phase, recovery, swim_m)
    swim_easy = _swim_endurance(
        inp,
        _clamp(
            _round5(swim_m - (swim_key.duration_min or 0)),
            EASY_MIN["swim"],
            LONG_CAP["swim"][inp.distance],
        ),
        recovery,
    )
    bike_key = _bike_key(inp, phase, recovery, week, bike_m)
    long_ride = _long_ride(
        inp, longs, recovery, _long_minutes("bike", bike_m, inp.distance)
    )
    key_run = _key_run(inp, phase, recovery, week, run_m)
    long_run = _long_run(
        inp, longs, recovery, _long_minutes("run", run_m, inp.distance)
    )

    brick: str | None = None  # the bike session the brick joins
    if phase in ("build", "specific"):
        on_long = (
            phase == "specific"
            and inp.distance in ("half", "full")
            and not endurance_longs
        )
        brick = LONG_RIDE if on_long else BIKE_KEY
    brick_run = _brick_run(inp, phase, recovery) if brick else None

    items = [_Item(SWIM_KEY, (swim_key,)), _Item(SWIM_EASY, (swim_easy,))]
    ride = TAPER_RIDE if endurance_longs else LONG_RIDE
    for kind, bike in ((BIKE_KEY, bike_key), (ride, long_ride)):
        if brick == kind and brick_run is not None:
            items.append(
                _Item(
                    BRICK_LONG_RIDE if kind == LONG_RIDE else BRICK_BIKE,
                    (_as_brick_bike(bike, kind == LONG_RIDE), brick_run),
                    _PREFS[kind],
                    solo=(kind, bike),
                )
            )
        else:
            items.append(_Item(kind, (bike,)))
    run_kind = TAPER_RUN if endurance_longs else LONG_RUN
    items += [_Item(KEY_RUN, (key_run,)), _Item(run_kind, (long_run,))]
    if not novice:
        bike_left = (
            bike_m - (bike_key.duration_min or 0) - (long_ride.duration_min or 0)
        )
        run_left = (
            run_m
            - (key_run.duration_min or 0)
            - (long_run.duration_min or 0)
            - (brick_run.duration_min or 0 if brick_run else 0)
        )
        items.append(
            _Item(BIKE_EASY, (_bike_easy(inp, _fill("bike", bike_left), recovery),))
        )
        items.append(
            _Item(EASY_RUN, (_easy_run(inp, _fill("run", run_left), recovery),))
        )
    return items


def _activation_items(inp: TriInputs, monday: date) -> list[_Item]:
    """The activations falling in the week of ``monday``: swim three days
    before the race, bike two, run one; a rest day moves one a day earlier,
    else a day later while still before the race."""
    out = []
    last = monday + timedelta(days=6)
    for sport, before in RACE_ACTIVATION_DAYS:
        day = inp.race_date - timedelta(days=before)
        if not monday <= day <= last or day < inp.start:
            continue
        around = [day, day - timedelta(days=1), day + timedelta(days=1)]
        prefs = tuple(
            d.weekday()
            for d in around
            if monday <= d <= last and inp.start <= d < inp.race_date
        )
        out.append(_Item(ACTIVATION, (_activation(inp, sport),), prefs))
    return out


def _within_slots(items: list[_Item]) -> tuple[list[_Item], list[DraftSession]]:
    """A week holding the race's activations (a race early in the next week)
    gives up its least needed sessions to stay within ``MAX_SLOTS``."""
    gone: list[DraftSession] = []
    for kind in (EASY_RUN, BIKE_EASY, SWIM_EASY, BIKE_KEY, KEY_RUN, SWIM_KEY):
        for item in [i for i in items if i.kind == kind]:
            if len(items) <= MAX_SLOTS:
                return items, gone
            items.remove(item)
            gone += item.drafts
    assert len(items) <= MAX_SLOTS, f"{len(items)} sessions in one week"
    return items, gone


def _race_week_items(inp: TriInputs, minutes: float, monday: date) -> list[_Item]:
    """The race, the activations, and short easy sessions with what is left."""
    items = [_Item(RACE, (_race(inp),), (inp.race_date.weekday(),))]
    activations = _activation_items(inp, monday)
    items += activations
    left = minutes - sum(i.minutes for i in activations)
    sports: tuple[Sport, ...] = ("swim", "bike", "run")
    for sport, share in zip(sports, SPLIT[inp.distance], strict=True):
        each = _round5(left * share)
        if each < EASY_MIN[sport]:
            continue
        each = min(each, EASY_MAX[sport])
        if sport == "swim":
            items.append(_Item(SWIM_EASY, (_swim_endurance(inp, each, False),)))
        elif sport == "bike":
            items.append(_Item(BIKE_EASY, (_bike_easy(inp, each, False),)))
        else:
            items.append(_Item(EASY_RUN, (_easy_run(inp, each, False),)))
    return items


def _within_hours(
    items: list[_Item], cap: float
) -> tuple[list[_Item], list[DraftSession]]:
    """The week's sessions within the declared hours: easy sessions go first,
    then long sessions shrink to their minimum, then a brick loses its run,
    then the swim key goes."""
    gone: list[DraftSession] = []

    def total() -> int:
        return sum(i.minutes for i in items)

    for kind in _BUDGET_DROPS:
        if total() <= cap:
            return items, gone
        for item in [i for i in items if i.kind == kind]:
            items.remove(item)
            gone += item.drafts
            if total() <= cap:
                return items, gone
    longs: tuple[tuple[str, Sport], ...] = ((LONG_RUN, "run"), (LONG_RIDE, "bike"))
    for kind, sport in longs:
        for k, item in enumerate(items):
            if item.kind != kind or total() <= cap:
                continue
            draft = item.drafts[0]
            over = total() - cap
            shorter = max(
                EASY_MIN[sport], (draft.duration_min or 0) - _round5(over + 2)
            )
            if shorter < (draft.duration_min or 0) and draft.prescription is None:
                items[k] = replace(item, drafts=(replace(draft, duration_min=shorter),))
    for k, item in enumerate(items):
        if item.solo is not None and total() > cap:
            kind, bike = item.solo
            items[k] = _Item(kind, (bike,), item.prefs)
            gone.append(item.drafts[1])
    if total() > cap:
        for item in [i for i in items if i.kind == SWIM_KEY]:
            items.remove(item)
            gone += item.drafts
    return items, gone


def _available(monday: date, inp: TriInputs) -> list[int]:
    """Training weekdays inside the plan; the race day is placed apart."""
    out = []
    for d in range(7):
        day = monday + timedelta(days=d)
        if d in inp.rest_days or day < inp.start or day >= inp.race_date:
            continue
        out.append(d)
    return out


def _with_kept_bricks(
    items: list[_Item], kept: Sequence[DraftSession]
) -> tuple[list[_Item], list[DraftSession], set[int], list[str]]:
    """The week's brick around the athlete's edits, the other kept sessions
    (returned for their kinds), the weekdays a regenerated partner joins a
    kept half on, and what the preview says of a brick not recreated.

    A kept bike half gets the brick's run alone, after it on its day. A kept
    run half keeps its day alone: its bike is not recreated, since a new
    session would be written after it and read as done before it. Both
    halves kept, or no brick this week: nothing is generated for it.
    """
    bikes = [k for k in kept if BRICK_BIKE in k.tags]
    runs = [k for k in kept if BRICK_RUN in k.tags]
    others = [k for k in kept if not k.tags & {BRICK_BIKE, BRICK_RUN}]
    brick = next(
        (i for i in items if BRICK_BIKE in i.drafts[0].tags and len(i.drafts) == 2),
        None,
    )
    if brick is None or not (bikes or runs):
        return items, others, set(), []
    items = [i for i in items if i is not brick]
    if bikes and not runs:
        day = bikes[0].date.weekday()
        items.append(_Item(BRICK_RUN, (brick.drafts[1],), (day,)))
        return items, others, {day}, []
    if runs and not bikes:
        return items, others, set(), [_BIKE_NOT_RECREATED]
    return items, others, set(), []


def _within_days(
    slots: list[Slot],
    kept: Sequence[DraftSession],
    max_days: int,
    drops: tuple[str, ...],
) -> tuple[list[Slot], list[Slot]]:
    """Sessions other than swims never share a day (a brick is one slot, a
    kept brick half shares its day with its partner): a week holding more of
    them than days gives up the least important ones ``drops`` allows before
    the search, which would otherwise try every way to fail."""

    def solo(slot: Slot) -> bool:
        partner = len(slot.drafts) == 1 and slot.kind in (BRICK_BIKE, BRICK_RUN)
        return SWIM not in slot.tags and not partner

    taken = len({k.date for k in kept if SWIM not in k.tags})
    left, gone = list(slots), list[Slot]()
    for kind in drops:
        for slot in [s for s in left if s.kind == kind and solo(s)]:
            if sum(map(solo, left)) + taken <= max_days:
                return left, gone
            left.remove(slot)
            gone.append(slot)
    return left, gone


def _place_week(
    inp: TriInputs,
    rules: Rules,
    monday: date,
    phase: Phase,
    minutes: float,
    recovery: bool,
    index: int,
    kept: list[DraftSession],
    previous: WeekPlan | None,
    *,
    full_days: int,
    drops: tuple[str, ...],
    endurance_longs: bool,
) -> WeekPlan | None:
    """The week's sessions placed under the rules, or None when even giving
    up what ``drops`` allows leaves no assignment."""
    if phase == "race":
        items = _race_week_items(inp, minutes, monday)
    else:
        items = _loading_items(inp, phase, minutes, recovery, index, endurance_longs)
        items += _activation_items(inp, monday)
    items, crowded = _within_slots(items)
    items, short = _within_hours(items, inp.hours_per_week * 60)
    items, kept_others, partner_days, brick_notes = _with_kept_bricks(items, kept)
    slots = without_kept_kinds(
        [TRI.slot(*i.drafts, prefs=i.prefs) for i in items],
        # A kept race, even moved off race day, is the race: never a second.
        [*kept_others, *(k for k in inp.kept if RACE in k.tags and k not in kept)],
        TRI,
    )
    assert len(slots) <= MAX_SLOTS, f"{len(slots)} sessions in one week"
    open_days = _available(monday, inp)
    # A kept bike half's day stays open to its regenerated run only.
    kept_days = {k.date.weekday() for k in kept} - partner_days
    days = [d for d in open_days if d not in kept_days]
    max_days = min(full_days, len(days) + len(kept_days) + (phase == "race"))
    slots, crowded_days = _within_days(slots, kept, max_days, drops)
    fitted = fit_week(
        WeekPlan(start=monday, phase=phase, minutes=0, recovery=recovery),
        slots,
        days,
        max_days,
        rules,
        TRI,
        drops=drops,
        keep_tag=None,
        fixed=kept,
        ahead=[
            k
            for k in inp.kept
            if monday + timedelta(days=7) <= k.date <= monday + timedelta(days=13)
        ],
        previous=previous,
        race_date=inp.race_date,
    )
    if fitted is None:
        return None
    week, gone = fitted
    return replace(
        week,
        dropped=brick_notes
        + TRI.dropped(crowded, _ACTIVATIONS)
        + TRI.dropped(short, _NO_TIME)
        + TRI.dropped_slots([*crowded_days, *gone], _NO_ROOM),
    )


def generate_tri_plan(inp: TriInputs, rules: Rules) -> list[WeekPlan]:
    """The weeks to race day; raises ``PlanError``."""
    if inp.race_date < inp.start:
        raise PlanError("La course est déjà passée.")
    if 7 - len(inp.rest_days) < MIN_TRAINING_DAYS:
        raise PlanError(
            f"Au moins {MIN_TRAINING_DAYS} jours sans repos sont nécessaires par "
            "semaine pour un triathlon."
        )
    full_days = min(max(MIN_TRAINING_DAYS, inp.training_days), 7 - len(inp.rest_days))
    n_weeks = plan_length(inp)
    first = monday_of(inp.race_date) - timedelta(weeks=n_weeks - 1)
    mondays = [first + timedelta(weeks=k) for k in range(n_weeks)]
    phases = _phases(mondays, inp)
    upcoming = [m for m in mondays if m + timedelta(days=6) >= inp.start]
    deload_first = rules.deload.triggered(inp.acwr, inp.tsb) and (
        upcoming[0] <= inp.start + timedelta(days=7)
    )
    past = len(mondays) - len(upcoming)
    if past == 0:
        volumes = _volumes(phases, inp, deload_first)
    else:
        volumes = _volumes(phases, inp, deload_first=False)
        if deload_first and past < len(mondays) - 1 and not volumes[past][1]:
            volumes[past] = (volumes[past][0] * RECOVERY_SHARE, True)
    for kept_session in inp.kept:
        if kept_session.date == inp.race_date and RACE not in kept_session.tags:
            raise PlanError(
                f"La séance « {kept_session.description} » du "
                f"{kept_session.date:%d/%m} tombe le jour de la course : "
                "déplace-la ou supprime-la avant de générer le plan."
            )
    usual = len([d for d in range(7) if d not in inp.rest_days])

    weeks: list[WeekPlan] = []
    previous: WeekPlan | None = None
    for index, (monday, phase, (minutes, recovery)) in enumerate(
        zip(mondays, phases, volumes, strict=True)
    ):
        if index < past:
            continue
        kept = [k for k in inp.kept if monday <= k.date <= monday + timedelta(days=6)]
        open_days = _available(monday, inp)
        tapering = phase in ("taper", "race")
        loose = len(open_days) < usual or bool(kept)
        taper_from = inp.race_date - timedelta(days=rules.taper.days)
        reaches_taper = any(monday + timedelta(days=d) > taper_from for d in open_days)
        # The usual week first; a loading week reaching into the taper's days
        # then tries its long sessions as shorter endurance ones (no long
        # session in the taper); last, any session but the race may go.
        attempts: list[tuple[bool, tuple[str, ...] | None]] = [(False, None)]
        if not tapering and reaches_taper:
            attempts.append((True, None))
        if not tapering and not loose:
            attempts.append((False, _PARTIAL_DROPS))
        week = None
        for endurance, wider in attempts:
            week = _place_week(
                inp,
                rules,
                monday,
                phase,
                minutes,
                recovery,
                index,
                kept,
                previous,
                full_days=full_days,
                drops=wider
                or (
                    _TAPER_DROPS
                    if tapering
                    else _PARTIAL_DROPS
                    if loose
                    else _FULL_DROPS
                ),
                endurance_longs=endurance,
            )
            if week is not None:
                break
        if week is None:
            raise PlanError(
                f"Impossible de placer la semaine du {monday:%d/%m} en respectant "
                "les règles d'enchaînement : libère un jour d'entraînement ou "
                "retire un jour de repos."
            )
        weeks.append(week)
        previous = week
    cap_taper(weeks, rules.taper, inp.race_date, TRI)
    return weeks


def sport_minutes(week: WeekPlan) -> dict[str, int]:
    """A week's planned minutes by sport (the race apart)."""
    out = {"swimming": 0, "cycling": 0, "running": 0}
    for s in week.sessions:
        if s.sport in out:
            out[s.sport] += s.duration_min or 0
    return out
