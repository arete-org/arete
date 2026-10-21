"""A periodised road plan towards one race, as deterministic rules.

Weeks from the start to race week are split into base, build, specific and
taper; every fourth week of loading is lighter (3:1). The weekly running
volume starts from what the athlete actually ran over the last four weeks,
grows 8 % a week up to a ceiling set by the race distance, and drops in the
taper. Each week holds a long run, 0 to 2 quality sessions depending on the
phase, and easy runs on the remaining training days; paces come from the
athlete's VDOT when it is known. Pure: no I/O, no clock.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from arete.features.running import TrainingPaces, format_pace, race_time_sec

Phase = Literal["base", "build", "specific", "taper", "race"]
Category = Literal["5k", "10k", "half", "marathon"]

WEEKLY_GROWTH = 1.08
RECOVERY_SHARE = 0.70
MIN_WEEKLY_MIN = 90
MIN_EASY_MIN = 30
MAX_EASY_MIN = 70
MAX_WEEKS = 24
SPECIFIC_WEEKS = 4

#: Weekly running minutes the plan never exceeds, and the long-run cap.
PEAK_MINUTES: dict[Category, int] = {
    "5k": 300,
    "10k": 360,
    "half": 420,
    "marathon": 540,
}
LONG_RUN_CAP: dict[Category, int] = {"5k": 75, "10k": 90, "half": 120, "marathon": 165}
TAPER_WEEKS: dict[Category, int] = {"5k": 1, "10k": 1, "half": 2, "marathon": 2}
LONG_RUN_SHARE = 0.30

#: Preferred weekdays (Monday 0): long run, quality sessions, easy runs.
LONG_RUN_DAYS = (6, 5)
QUALITY_DAYS = (1, 3, 2, 4)
EASY_DAYS = (0, 2, 4, 5, 3, 1, 6)


def category(distance_km: float) -> Category:
    if distance_km <= 7:
        return "5k"
    if distance_km <= 15:
        return "10k"
    if distance_km <= 30:
        return "half"
    return "marathon"


@dataclass(frozen=True)
class PlanInputs:
    start: date  # first day the plan may fill
    race_date: date
    distance_km: float
    weekly_minutes_now: float  # running minutes per week, last 4 weeks
    sessions_per_week: int  # running sessions, long run included
    rest_days: frozenset[int] = frozenset()  # weekdays, Monday 0
    paces: TrainingPaces | None = None
    race_name: str = "Course"


@dataclass(frozen=True)
class DraftSession:
    date: date
    session_type: str  # a garmin.models.SessionType value
    duration_min: int | None
    hr_zone: str | None
    intensity: str | None
    description: str
    distance_km: float | None = None
    sport: str = "running"
    #: Structured steps (``services.prescriptions.Prescription`` as a dict).
    prescription: dict[str, Any] | None = field(default=None, hash=False)
    #: What the interference rules read (``features.hybrid_plan``).
    tags: frozenset[str] = frozenset()
    #: A station circuit's stations in order (``hybrid_plan.STATIONS`` ids),
    #: which ``services.hybrid_strength`` prescribes; not stored.
    stations: tuple[str, ...] = ()


@dataclass
class WeekPlan:
    start: date
    phase: Phase
    minutes: int
    recovery: bool
    sessions: list[DraftSession] = field(default_factory=list)
    #: Sessions the week could not hold, and why, in French (hybrid plans).
    dropped: list[str] = field(default_factory=list)


class PlanError(ValueError):
    """The plan cannot be built; the message says why, in French."""


def monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _phases(n_weeks: int, cat: Category) -> list[Phase]:
    """Phase of each week, the race week last; the taper is served first."""
    taper = min(TAPER_WEEKS[cat], n_weeks)  # race week included
    loading = n_weeks - taper
    specific = min(SPECIFIC_WEEKS, loading)
    remaining = loading - specific
    build = remaining // 2
    base = remaining - build
    counts: tuple[tuple[Phase, int], ...] = (
        ("base", base),
        ("build", build),
        ("specific", specific),
        ("taper", taper - 1),
        ("race", 1),
    )
    return [phase for phase, n in counts for _ in range(n)]


def _volumes(
    phases: list[Phase], start_minutes: float, cat: Category
) -> list[tuple[int, bool]]:
    """(minutes, recovery week?) per week."""
    peak_cap = PEAK_MINUTES[cat]
    current = max(float(MIN_WEEKLY_MIN), min(start_minutes, peak_cap))
    out: list[tuple[int, bool]] = []
    loading_index = 0
    peak = current
    for phase in phases:
        if phase in ("base", "build", "specific"):
            loading_index += 1
            if loading_index % 4 == 0:
                out.append((round(current * RECOVERY_SHARE), True))
                continue
            if loading_index > 1:
                current = min(current * WEEKLY_GROWTH, peak_cap)
            peak = max(peak, current)
            out.append((round(current), False))
        elif phase == "taper":
            out.append((round(peak * 0.70), False))
        else:  # race week
            out.append((round(peak * (0.45 if TAPER_WEEKS[cat] > 1 else 0.55)), False))
    return out


def _pick(days: tuple[int, ...], free: list[int], count: int) -> list[int]:
    chosen = [d for d in days if d in free][:count]
    for d in chosen:
        free.remove(d)
    return chosen


def paced(label: str, paces: TrainingPaces | None, attr: str) -> str:
    if paces is None:
        return label
    value = getattr(paces, attr)
    if isinstance(value, tuple):  # (slow, fast): read fastest first
        return f"{label} ({format_pace(value[1])[:-3]} à {format_pace(value[0])})"
    return f"{label} ({format_pace(value)})"


def _race_pace(paces: TrainingPaces | None, distance_km: float) -> str:
    if paces is None:
        return "allure course"
    seconds = race_time_sec(paces.vdot, distance_km * 1000) / distance_km
    return f"allure course ({format_pace(round(seconds))})"


def _quality(
    phase: Phase,
    kind: int,
    cat: Category,
    paces: TrainingPaces | None,
    distance_km: float,
) -> DraftSession | None:
    """The phase's quality session number ``kind`` (0 or 1), dated later."""
    t = paced("au seuil", paces, "threshold")
    i = paced("à l'allure VMA", paces, "interval")
    if phase == "base":
        return DraftSession(
            date.min, "tempo", 45, "Z4", "moderate", f"Seuil : 2×8' {t}, récup 2'"
        )
    if phase == "build":
        if kind == 0:
            return DraftSession(
                date.min, "tempo", 55, "Z4", "hard", f"Seuil : 3×10' {t}, récup 2'"
            )
        return DraftSession(
            date.min, "intervals", 50, "Z5", "hard", f"Fractionné : 6×3' {i}, récup 2'"
        )
    if phase == "specific":
        if cat in ("5k", "10k"):
            if kind == 0:
                reps = "5×1000 m" if cat == "10k" else "8×400 m"
                return DraftSession(
                    date.min,
                    "intervals",
                    55,
                    "Z5",
                    "hard",
                    f"Fractionné : {reps} {i}, récup 2'",
                )
            return DraftSession(
                date.min, "tempo", 50, "Z4", "hard", f"Seuil continu : 25' {t}"
            )
        if kind == 0:
            block = "3×15'" if cat == "half" else "2×25'"
            return DraftSession(
                date.min,
                "tempo",
                70,
                "Z3" if cat == "marathon" else "Z4",
                "hard",
                f"Spécifique : {block} {_race_pace(paces, distance_km)}, récup 3'",
            )
        return DraftSession(
            date.min, "tempo", 50, "Z4", "hard", f"Seuil : 3×8' {t}, récup 2'"
        )
    if phase == "taper" and kind == 0:
        return DraftSession(
            date.min,
            "intervals",
            40,
            "Z4",
            "moderate",
            f"Rappel : 4×4' {_race_pace(paces, distance_km)}",
        )
    return None


def _quality_count(phase: Phase, recovery: bool, sessions: int) -> int:
    count = {"base": 1, "build": 2, "specific": 2, "taper": 1, "race": 0}[phase]
    if recovery or sessions <= 3:
        count = min(count, 1)
    return count


def generate_plan(inp: PlanInputs) -> list[WeekPlan]:
    """The weeks from ``inp.start`` to race week; raises ``PlanError``."""
    if inp.race_date < inp.start:
        raise PlanError("La course est déjà passée.")
    first_monday = monday_of(inp.start)
    n_weeks = (monday_of(inp.race_date) - first_monday).days // 7 + 1
    if n_weeks > MAX_WEEKS:
        raise PlanError(
            f"Course dans plus de {MAX_WEEKS} semaines : le plan se génère "
            f"au plus {MAX_WEEKS} semaines avant."
        )
    free_days = [d for d in range(7) if d not in inp.rest_days]
    if len(free_days) < 2:
        raise PlanError("Au moins deux jours sans repos sont nécessaires par semaine.")
    sessions = max(2, min(inp.sessions_per_week, len(free_days), 6))
    cat = category(inp.distance_km)
    phases = _phases(n_weeks, cat)
    volumes = _volumes(phases, inp.weekly_minutes_now, cat)
    paces = inp.paces

    weeks: list[WeekPlan] = []
    for index, (phase, (minutes, recovery)) in enumerate(
        zip(phases, volumes, strict=True)
    ):
        monday = first_monday + timedelta(weeks=index)
        week = WeekPlan(start=monday, phase=phase, minutes=minutes, recovery=recovery)
        free = list(free_days)

        if phase == "race":
            race_wd = inp.race_date.weekday()
            if race_wd in free:
                free.remove(race_wd)
            planned: list[tuple[int, DraftSession]] = [
                (
                    race_wd,
                    DraftSession(
                        date.min,
                        "race",
                        None,
                        None,
                        "hard",
                        f"{inp.race_name} : {inp.distance_km:g} km, {_race_pace(paces, inp.distance_km)}",
                        distance_km=inp.distance_km,
                    ),
                )
            ]
            sharpen = race_wd - 3
            if sharpen >= 0 and sharpen in free:
                free.remove(sharpen)
                planned.append(
                    (
                        sharpen,
                        DraftSession(
                            date.min,
                            "intervals",
                            35,
                            "Z4",
                            "moderate",
                            f"Activation : 20' facile + 4×2' {_race_pace(paces, inp.distance_km)}",
                        ),
                    )
                )
            easy_days = [d for d in free if d < race_wd and d != race_wd - 1][
                : max(0, sessions - 2)
            ]
            for d in easy_days:
                planned.append(
                    (
                        d,
                        DraftSession(
                            date.min,
                            "endurance",
                            30,
                            "Z2",
                            "easy",
                            paced("Footing", paces, "easy"),
                        ),
                    )
                )
        else:
            long_day = (_pick(LONG_RUN_DAYS, free, 1) or [free.pop()])[0]
            # Keep the day before the long run easy.
            blocked = [(long_day - 1) % 7]
            quality_free = [d for d in free if d not in blocked]
            n_quality = min(
                _quality_count(phase, recovery, sessions),
                sessions - 2,
                len(quality_free),
            )
            quality_days = _pick(QUALITY_DAYS, quality_free, n_quality)
            for d in quality_days:
                free.remove(d)
            easy_count = sessions - 1 - len(quality_days)
            easy_days = _pick(EASY_DAYS, free, easy_count)

            long_min = min(
                LONG_RUN_CAP[cat], max(45, round(minutes * LONG_RUN_SHARE / 5) * 5)
            )
            long_desc = paced(
                f"Sortie longue {long_min // 60}h{long_min % 60:02d}", paces, "easy"
            )
            if cat == "marathon" and phase == "specific" and not recovery:
                long_desc += f", dont 40' {_race_pace(paces, inp.distance_km)}"
            planned = [
                (
                    long_day,
                    DraftSession(
                        date.min, "long_run", long_min, "Z2", "easy", long_desc
                    ),
                )
            ]
            used = long_min
            for k, d in enumerate(quality_days):
                # A lighter week keeps its quality session, in its base form.
                q = _quality(
                    "base" if recovery else phase, k, cat, paces, inp.distance_km
                )
                if q is not None:
                    planned.append((d, q))
                    used += q.duration_min or 0
            if easy_days:
                each = round((minutes - used) / len(easy_days) / 5) * 5
                each = max(MIN_EASY_MIN, min(MAX_EASY_MIN, each))
                for d in easy_days:
                    planned.append(
                        (
                            d,
                            DraftSession(
                                date.min,
                                "recovery" if recovery else "endurance",
                                each,
                                "Z1" if recovery else "Z2",
                                "easy",
                                paced("Footing", paces, "easy"),
                            ),
                        )
                    )

        for weekday, draft in sorted(planned, key=lambda p: p[0]):
            day = monday + timedelta(days=weekday)
            if day < inp.start or day > inp.race_date:
                continue
            week.sessions.append(
                DraftSession(
                    date=day,
                    session_type=draft.session_type,
                    duration_min=draft.duration_min,
                    hr_zone=draft.hr_zone,
                    intensity=draft.intensity,
                    description=draft.description,
                    distance_km=draft.distance_km,
                )
            )
        weeks.append(week)
    return weeks


#: RPE a planned session is expected to feel like, by type, for its TSS.
PLANNED_RPE: dict[str, float] = {
    "recovery": 3,
    "endurance": 4,
    "long_run": 4.5,
    "tempo": 7,
    "intervals": 8,
    "race": 9,
}
DEFAULT_PLANNED_RPE = 5


def planned_tss(
    session_type: str, minutes: float, rpe_by_type: Mapping[str, float] = PLANNED_RPE
) -> float:
    """TSS a planned session should bring, with the RPE formula the history uses.
    A Hyrox or hybrid goal's sessions pass that plan's table (``hybrid_plan``)."""
    rpe = rpe_by_type.get(session_type, DEFAULT_PLANNED_RPE)
    return minutes * (rpe / 10) ** 2 / 0.36
