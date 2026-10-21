"""A Hyrox or hybrid plan's weekly structure, one French line per phase.

The goals panel's preview reads it before the weeks: « Semaine type (base) :
mar. course clé + bas du corps (après) · mer. footing · … · lun. repos ».
Pure and deterministic: it reads the generated weeks' tags, nothing else.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta

from arete.features.hybrid_plan import (
    BENCHMARK,
    HEAVY_LOWER,
    KEPT,
    KEY_RUN,
    RACE,
    STATION,
    kind_of,
)
from arete.features.plan_generator import WeekPlan

WEEKDAYS = ("lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim.")
#: Each session kind a Hyrox or hybrid plan writes, as the preview names it.
KIND_LABEL = {
    "race": "course",
    "key_run": "course clé",
    "compromised": "course compromise",
    "easy": "footing",
    "heavy_lower": "bas du corps",
    "upper": "haut du corps",
    "station": "circuit stations",
    "activation": "activation",
    "benchmark": "test de fin de bloc",
}
PHASE_LABEL = {
    "base": "base",
    "build": "développement",
    "specific": "spécifique",
    "taper": "affûtage",
}


def _french_list(items: Sequence[str]) -> str:
    """'lun.', 'lun. et dim.', 'lun., jeu. et dim.'"""
    if len(items) < 2:
        return "".join(items)
    return f"{', '.join(items[:-1])} et {items[-1]}"


def describe_week(week: WeekPlan) -> str:
    """Each training day's sessions in order, then the rest days. Heavy legs
    or stations on the key run's day are done after it: « (après) ». A race
    week stops on race day."""
    race_day = next((s.date for s in week.sessions if RACE in s.tags), None)
    last = race_day or week.start + timedelta(days=6)
    days, rest = [], []
    for offset in range((last - week.start).days + 1):
        day = week.start + timedelta(days=offset)
        sessions = [s for s in week.sessions if s.date == day]
        if not sessions:
            rest.append(WEEKDAYS[day.weekday()])
            continue
        key_day = any(KEY_RUN in s.tags for s in sessions)
        names = [
            KIND_LABEL.get(kind_of(s.tags), s.session_type)
            + (
                " (après)"
                if key_day
                and KEY_RUN not in s.tags
                and (HEAVY_LOWER in s.tags or STATION in s.tags)
                else ""
            )
            for s in sessions
        ]
        days.append(f"{WEEKDAYS[day.weekday()]} {' + '.join(names)}")
    if rest:
        days.append(f"{_french_list(rest)} repos")
    return " · ".join(days)


def _typical(weeks: Sequence[WeekPlan]) -> WeekPlan:
    """The week that shows a phase best: a loading week without the
    athlete's kept sessions, the fullest (a plan's first week may be
    partial), the earliest of equals."""
    for pool in (
        [w for w in weeks if not w.recovery and not _has(w, KEPT)],
        [w for w in weeks if not w.recovery],
        list(weeks),
    ):
        if pool:
            return max(pool, key=lambda w: (len(w.sessions), -w.start.toordinal()))
    raise AssertionError("a phase has at least one week")


def _has(week: WeekPlan, tag: str) -> bool:
    return any(tag in s.tags for s in week.sessions)


def weekly_summary(weeks: Sequence[WeekPlan]) -> list[str]:
    """One line per phase, in plan order: its typical week, then the race
    week (Hyrox) or the block's final deload with its benchmark (hybrid)."""
    lines: list[str] = []
    phases: dict[str, list[WeekPlan]] = {}
    for week in weeks:
        if week.phase == "race" or _has(week, BENCHMARK):
            continue
        phases.setdefault(week.phase, []).append(week)
    for phase, members in phases.items():
        label = PHASE_LABEL.get(phase, phase)
        lines.append(f"Semaine type ({label}) : {describe_week(_typical(members))}")
    for week in weeks:
        if week.phase == "race":
            lines.append(f"Semaine de course : {describe_week(week)}")
        elif _has(week, BENCHMARK):
            lines.append(f"Dernière semaine (allégée) : {describe_week(week)}")
    return lines
