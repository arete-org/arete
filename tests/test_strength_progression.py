"""Progression rules: records, e1RM trend and the next-session suggestion."""

from __future__ import annotations

from datetime import date

import pytest

from arete.strength.progression import (
    ExerciseSession,
    WorkSet,
    all_time_records,
    new_records,
    rep_range,
    suggest_next,
)


def session(day: int, *sets: WorkSet, target: str | None = None) -> ExerciseSession:
    return ExerciseSession(
        session_id=day, date=date(2026, 9, day), sets=list(sets), target_reps=target
    )


def sets(n: int, reps: int, kg: float | None, **kw) -> list[WorkSet]:
    return [WorkSet(reps=reps, weight_kg=kg, **kw) for _ in range(n)]


# --------------------------------------------------------------------------- #
# e1RM and records
# --------------------------------------------------------------------------- #
def test_high_rep_sets_set_no_e1rm():
    assert WorkSet(reps=5, weight_kg=100).e1rm == pytest.approx(116.67, rel=1e-3)
    assert WorkSet(reps=1, weight_kg=100).e1rm == 100
    assert WorkSet(reps=20, weight_kg=40).e1rm is None
    assert WorkSet(reps=10, weight_kg=None).e1rm is None


def test_a_first_session_has_nothing_to_beat():
    assert new_records([], session(1, *sets(3, 5, 100))) == []


def test_a_heavier_set_is_a_weight_and_e1rm_record():
    found = new_records([session(1, *sets(3, 5, 100))], session(2, *sets(1, 5, 105)))
    kinds = {r.kind: r for r in found}
    assert kinds["weight"].value == 105 and kinds["weight"].previous == 100
    assert kinds["e1rm"].value > kinds["e1rm"].previous


def test_more_reps_at_a_load_already_lifted_is_a_reps_record():
    found = new_records([session(1, *sets(3, 5, 100))], session(2, *sets(1, 7, 100)))
    reps = [r for r in found if r.kind == "reps"]
    assert reps and reps[0].value == 7 and reps[0].previous == 5
    assert reps[0].weight_kg == 100


def test_equalling_is_not_beating():
    assert (
        new_records([session(1, *sets(3, 5, 100))], session(2, *sets(3, 5, 100))) == []
    )


def test_bodyweight_reps_count_as_a_record():
    found = new_records([session(1, *sets(3, 8, None))], session(2, *sets(1, 10, None)))
    assert [(r.kind, r.value) for r in found] == [("reps", 10)]


def test_all_time_records_keep_the_first_date_reached():
    best = all_time_records(
        [session(1, *sets(1, 5, 100)), session(2, *sets(1, 5, 100))]
    )
    assert best.heaviest is not None and best.heaviest.date == date(2026, 9, 1)


# --------------------------------------------------------------------------- #
# Next session
# --------------------------------------------------------------------------- #
def test_rep_ranges():
    assert rep_range("8-10") == (8, 10)
    assert rep_range("5") == (5, 5)
    assert rep_range("12e") == (12, 12)
    assert rep_range("10/8/6") is None
    assert rep_range(None) is None


def test_top_of_range_on_every_set_adds_load_and_restarts_the_range():
    s = suggest_next(session(1, *sets(3, 10, 60), target="8-10"))
    assert s is not None
    assert (s.weight_kg, s.sets, s.reps, s.rule) == (62.5, 3, 8, "double_progression")
    assert "+2,5 kg" in s.reason


def test_inside_the_range_keeps_the_load_and_adds_a_rep():
    last = session(1, WorkSet(10, 60), WorkSet(9, 60), WorkSet(8, 60), target="8-10")
    s = suggest_next(last)
    assert s is not None and (s.weight_kg, s.reps) == (60, 9)


def test_reps_in_reserve_three_or_more_adds_load():
    s = suggest_next(session(1, *sets(3, 8, 80, rir=3), target="8-10"))
    assert s is not None and s.rule == "increase" and s.weight_kg == 82.5


def test_rpe_stands_in_for_rir():
    s = suggest_next(session(1, *sets(3, 8, 80, rpe=6), target="8-10"))
    assert s is not None and s.rule == "increase"


def test_short_of_the_range_at_failure_lowers_the_load():
    last = session(1, WorkSet(6, 100, rir=0), WorkSet(5, 100, rir=0), target="8-10")
    s = suggest_next(last)
    assert s is not None and s.rule == "decrease" and s.weight_kg == 95


def test_top_of_range_at_failure_consolidates():
    s = suggest_next(session(1, *sets(3, 10, 60, is_failure=True), target="8-10"))
    assert s is not None and s.rule == "hold" and s.weight_kg == 60


def test_lower_body_and_light_loads_take_their_own_increments():
    heavy = suggest_next(session(1, *sets(5, 5, 140)), lower_body=True)
    light = suggest_next(session(1, *sets(3, 12, 14), target="10-12"))
    assert heavy is not None and heavy.weight_kg == 145
    assert light is not None and light.weight_kg == 15


def test_bodyweight_progresses_by_reps():
    s = suggest_next(session(1, *sets(3, 8, None)))
    assert s is not None and s.weight_kg is None and s.reps == 9


def test_the_suggestion_follows_the_top_sets_only():
    last = session(1, WorkSet(5, 60), WorkSet(5, 80), *sets(3, 5, 100))
    s = suggest_next(last)
    assert s is not None and s.sets == 3 and s.weight_kg == 102.5


# --------------------------------------------------------------------------- #
# Deload on low readiness
# --------------------------------------------------------------------------- #
def test_low_readiness_lowers_load_and_volume_and_says_why():
    s = suggest_next(session(1, *sets(3, 10, 100), target="8-10"), readiness=42)
    assert s is not None and s.rule == "deload"
    assert (s.weight_kg, s.sets, s.reps) == (90, 2, 8)
    assert "Préparation basse" in s.reason and "42/100" in s.reason
    assert "−10 %" in s.reason


def test_very_low_readiness_deloads_deeper():
    s = suggest_next(session(1, *sets(4, 5, 100)), readiness=20)
    assert s is not None and (s.weight_kg, s.sets) == (85, 2)


def test_good_readiness_does_not_deload():
    s = suggest_next(session(1, *sets(3, 10, 100), target="8-10"), readiness=70)
    assert s is not None and s.rule != "deload" and s.weight_kg == 102.5


def test_a_deload_is_always_lighter_even_on_small_loads():
    s = suggest_next(session(1, *sets(1, 10, 10)), readiness=40)
    assert s is not None and s.weight_kg is not None and s.weight_kg < 10
