"""The French weekly structure a Hyrox or hybrid preview shows per phase."""

from __future__ import annotations

from datetime import date, timedelta

from arete.features.hybrid_plan import (
    HybridInputs,
    default_rules,
    generate_hybrid_plan,
    kind_tags,
)
from arete.features.plan_generator import DraftSession, WeekPlan
from arete.services.plan_summary import describe_week, weekly_summary

MONDAY = date(2026, 11, 2)
RULES = default_rules(acwr_above=1.5, tsb_below=-30)


def _session(offset: int, kind: str, *, kept: bool = False) -> DraftSession:
    tags = kind_tags(kind, "intermediate")
    assert tags is not None
    return DraftSession(
        MONDAY + timedelta(days=offset),
        "strength",
        45,
        None,
        None,
        kind,
        tags=tags if kept else tags - {"kept"},
    )


def _week(start: date, phase, sessions, recovery: bool = False) -> WeekPlan:
    shift = (start - MONDAY).days
    return WeekPlan(
        start=start,
        phase=phase,
        minutes=0,
        recovery=recovery,
        sessions=[
            DraftSession(
                s.date + timedelta(days=shift),
                s.session_type,
                s.duration_min,
                None,
                None,
                s.description,
                tags=s.tags,
            )
            for s in sessions
        ],
    )


FULL = [
    _session(1, "key_run"),
    _session(1, "heavy_lower"),
    _session(2, "upper"),
    _session(3, "easy"),
    _session(5, "compromised"),
    _session(6, "station"),
]


def test_a_week_reads_day_by_day_with_pairings_and_rest_days():
    week = _week(MONDAY, "build", FULL)
    assert describe_week(week) == (
        "mar. course clé + bas du corps (après) · mer. haut du corps · "
        "jeu. footing · sam. course compromise · dim. circuit stations · "
        "lun. et ven. repos"
    )


def test_each_phase_shows_its_fullest_loading_week_without_kept_sessions():
    first = _week(MONDAY, "base", FULL[3:])  # a partial first week
    kept = _week(
        MONDAY + timedelta(weeks=1),
        "base",
        [*FULL[:5], _session(6, "station", kept=True)],
    )
    typical = _week(MONDAY + timedelta(weeks=2), "base", FULL)
    deload = _week(MONDAY + timedelta(weeks=3), "build", FULL[:2], recovery=True)
    build = _week(MONDAY + timedelta(weeks=4), "build", FULL[1:])
    lines = weekly_summary([first, kept, typical, deload, build])
    assert lines == [
        "Semaine type (base) : " + describe_week(typical),
        "Semaine type (développement) : " + describe_week(build),
    ]


def test_a_hyrox_plan_ends_on_its_race_week_and_a_block_on_its_benchmark():
    hyrox = generate_hybrid_plan(
        HybridInputs(
            start=date(2026, 10, 21),
            race_date=date(2027, 1, 23),  # a Saturday
            kind="hyrox",
            level="intermediate",
            weekly_minutes_now=150,
            training_days=5,
            rest_days=frozenset({0}),
            weeks=8,
        ),
        RULES,
    )
    lines = weekly_summary(hyrox)
    assert [line.split(" :")[0] for line in lines] == [
        "Semaine type (base)",
        "Semaine type (développement)",
        "Semaine type (spécifique)",
        "Semaine type (affûtage)",
        "Semaine de course",
    ]
    assert lines[0] == (
        "Semaine type (base) : mar. course clé + bas du corps (après) · "
        "mer. footing · jeu. circuit stations · ven. haut du corps · "
        "sam. course compromise · lun. et dim. repos"
    )
    # The race week stops on race day: no Sunday after it.
    assert lines[-1] == (
        "Semaine de course : mer. activation · ven. footing · sam. course · "
        "lun., mar. et jeu. repos"
    )
    assert weekly_summary(hyrox) == lines  # deterministic

    block = generate_hybrid_plan(
        HybridInputs(
            start=date(2026, 10, 21),
            race_date=date(2026, 12, 20),
            kind="hybrid",
            level="novice",
            weekly_minutes_now=150,
            training_days=5,
            rest_days=frozenset({0}),
            weeks=8,
        ),
        RULES,
    )
    lines = weekly_summary(block)
    # A novice's compromised run is the key run: the circuit never shares it.
    assert lines[0].startswith("Semaine type (base) : mar. course compromise ·")
    assert lines[-1] == (
        "Dernière semaine (allégée) : mer. footing · jeu. haut du corps · "
        "sam. test de fin de bloc · lun., mar., ven. et dim. repos"
    )


def test_a_triathlon_summary_names_its_sports_and_its_bricks():
    from arete.features import tri_plan
    from arete.services.plan_summary import tri_name

    inp = tri_plan.TriInputs(
        start=date(2026, 10, 19),
        race_date=date(2027, 2, 7),  # a Sunday, 16 weeks out
        distance="olympic",
        level="intermediate",
        hours_per_week=8,
        weekly_minutes_now=360,
        training_days=6,
        rest_days=frozenset({0}),
    )
    rules = tri_plan.tri_rules("intermediate", "olympic", acwr_above=1.5, tsb_below=-30)
    lines = weekly_summary(tri_plan.generate_tri_plan(inp, rules), tri_name)
    assert [line.split(" :")[0] for line in lines] == [
        "Semaine type (base)",
        "Semaine type (développement)",
        "Semaine type (spécifique)",
        "Semaine type (affûtage)",
        "Semaine de course",
    ]
    assert "natation clé" in lines[0] and "lun. repos" in lines[0]
    assert "course enchaînée" not in lines[0]
    # From the build phase, the bike key is followed by its brick run.
    assert "vélo clé + course enchaînée" in lines[1]
    assert "jeu. activation · ven. activation · sam. activation" in lines[-1]
    assert "dim. triathlon" in lines[-1]
