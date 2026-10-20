"""Hyrox and hybrid plans: the interference rules, the weekly mix, the taper."""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta

import pytest

from arete.features.hybrid_plan import (
    BENCHMARK,
    COMPROMISED,
    EASY,
    HARD,
    HEAVY_LOWER,
    KEY_RUN,
    RACE,
    STATION,
    UPPER,
    HybridInputs,
    athlete_level,
    default_rules,
    generate_hybrid_plan,
    plan_violations,
    violations,
)
from arete.features.plan_generator import DraftSession, PlanError, WeekPlan
from arete.features.running import training_paces
from arete.services.adaptation import ACWR_REST_AT, TSB_EASE_AT

RULES = default_rules(acwr_above=ACWR_REST_AT, tsb_below=TSB_EASE_AT)
START = date(2026, 10, 12)  # a Monday
RACE_DAY = START + timedelta(weeks=11, days=5)  # a Saturday, 12 weeks out


def _plan(**kw):
    values = {
        "start": START,
        "race_date": RACE_DAY,
        "kind": "hyrox",
        "level": "intermediate",
        "weekly_minutes_now": 150,
        "training_days": 5,
        "rest_days": frozenset({0}),
        "paces": training_paces(50.0),
        "race_name": "Hyrox Paris",
    }
    values.update(kw)
    inputs = HybridInputs(**values)
    return inputs, generate_hybrid_plan(inputs, RULES)


def _mix(week: WeekPlan) -> Counter:
    """Sessions by their main tag, and by sport."""
    out: Counter = Counter()
    for s in week.sessions:
        for tag in (KEY_RUN, COMPROMISED, EASY, HEAVY_LOWER, UPPER, STATION, RACE):
            if tag in s.tags:
                out[tag] += 1
        out[s.sport] += 1
    return out


def _loading(weeks):
    return [w for w in weeks if w.phase in ("base", "build", "specific")]


def test_a_12_week_hyrox_plan_breaks_no_rule():
    _, weeks = _plan()
    assert len(weeks) == 12
    assert [w.phase for w in weeks][-2:] == ["taper", "race"]
    assert plan_violations(weeks, RULES, RACE_DAY) == []


def test_intermediate_weeks_hold_three_runs_two_strength_and_a_circuit():
    _, weeks = _plan()
    for week in _loading(weeks):
        mix = _mix(week)
        assert mix[KEY_RUN] == mix[COMPROMISED] == mix[EASY] == 1
        assert mix[HEAVY_LOWER] == mix[UPPER] == mix[STATION] == 1
        assert mix["running"] == 3 and mix["strength"] == 3
        compromised = next(s for s in week.sessions if COMPROMISED in s.tags)
        assert compromised.session_type == "intervals"
        assert compromised.prescription is not None


def test_novice_weeks_hold_two_runs_one_of_them_compromised():
    _, weeks = _plan(level="novice")
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    for week in _loading(weeks):
        mix = _mix(week)
        assert mix["running"] == 2 and mix[COMPROMISED] == mix[EASY] == 1
        # The compromised run is the novice's key session.
        assert mix[KEY_RUN] == 1
        assert mix[HEAVY_LOWER] == mix[UPPER] == mix[STATION] == 1


def test_loading_follows_three_weeks_up_one_down():
    _, weeks = _plan()
    loading = _loading(weeks)
    assert [w.recovery for w in loading] == [
        (i + 1) % 4 == 0 for i in range(len(loading))
    ]
    for before, lighter in zip(loading, loading[1:], strict=False):
        if lighter.recovery:
            assert lighter.minutes < before.minutes


def _taper_checks(weeks, race_day):
    peak = max(w.minutes for w in _loading(weeks))
    last_days = [
        s for w in weeks for s in w.sessions if 0 < (race_day - s.date).days <= 10
    ]
    assert last_days, "the taper still trains"
    assert sum(s.duration_min or 0 for s in last_days) * 7 / 10 <= 0.6 * peak
    assert not any(HEAVY_LOWER in s.tags for s in last_days)
    hard = [
        s.date
        for w in weeks
        for s in w.sessions
        if HARD in s.tags and RACE not in s.tags
    ]
    assert (race_day - max(hard)).days >= 5
    race = weeks[-1].sessions[-1]
    assert race.date == race_day and race.session_type == "race"
    assert race.distance_km == 8.0


def test_the_taper_lightens_the_last_ten_days_without_heavy_legs():
    _, weeks = _plan()
    _taper_checks(weeks, RACE_DAY)


def test_an_8_week_plan_compresses_its_phases_and_keeps_the_taper():
    race_day = START + timedelta(weeks=7, days=5)
    _, weeks = _plan(race_date=race_day)
    _, twelve = _plan()
    assert len(weeks) == 8
    eight_phases, twelve_phases = (
        Counter(w.phase for w in ws) for ws in (weeks, twelve)
    )
    for phase in ("base", "build", "specific"):
        assert 0 < eight_phases[phase] <= twelve_phases[phase]
    assert sum(eight_phases[p] for p in ("base", "build", "specific")) < sum(
        twelve_phases[p] for p in ("base", "build", "specific")
    )
    assert plan_violations(weeks, RULES, race_day) == []
    _taper_checks(weeks, race_day)


def test_a_chosen_8_week_length_starts_the_plan_8_weeks_out():
    _, weeks = _plan(weeks=8)
    assert len(weeks) == 8 and weeks[0].start == RACE_DAY - timedelta(weeks=7, days=5)


def test_a_race_further_than_12_weeks_starts_12_weeks_out():
    far = RACE_DAY + timedelta(weeks=6)
    _, weeks = _plan(race_date=far)
    assert len(weeks) == 12
    assert weeks[0].start == far - timedelta(weeks=11, days=5)
    assert weeks[0].sessions[0].date > START


def test_a_race_within_6_weeks_is_refused_in_french():
    with pytest.raises(PlanError, match="moins de 6 semaines"):
        _plan(race_date=START + timedelta(weeks=4, days=5))


@pytest.mark.parametrize(
    ("acwr", "tsb", "deload"),
    [
        (ACWR_REST_AT + 0.1, None, True),
        (None, TSB_EASE_AT - 5, True),
        (1.1, -10.0, False),
    ],
)
def test_a_load_already_too_high_starts_with_a_deload(acwr, tsb, deload):
    _, weeks = _plan(acwr=acwr, tsb=tsb)
    assert weeks[0].recovery is deload
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    if deload:
        _, fresh = _plan()
        assert weeks[0].minutes < fresh[0].minutes


def test_a_hybrid_block_has_no_race_and_ends_with_a_deload_benchmark():
    block_end = START + timedelta(weeks=7, days=6)  # a Sunday, 8 weeks
    _, weeks = _plan(kind="hybrid", race_date=block_end, weeks=8)
    assert len(weeks) == 8
    assert not any(
        RACE in s.tags or s.session_type == "race" for w in weeks for s in w.sessions
    )
    assert plan_violations(weeks, RULES, None) == []
    last = weeks[-1]
    assert last.recovery and last.minutes < max(w.minutes for w in weeks[:-1])
    assert [s for s in last.sessions if BENCHMARK in s.tags]
    assert not any(HEAVY_LOWER in s.tags for s in last.sessions)
    assert all(s.date <= block_end for s in last.sessions)


def test_a_hybrid_block_regenerated_midway_keeps_its_place():
    block_end = START + timedelta(weeks=11, days=6)
    _, whole = _plan(kind="hybrid", race_date=block_end)
    _, later = _plan(
        kind="hybrid", race_date=block_end, start=START + timedelta(weeks=5)
    )
    assert [(w.start, w.phase, w.recovery) for w in later] == [
        (w.start, w.phase, w.recovery) for w in whole[5:]
    ]


def test_few_training_days_pair_sessions_on_hard_days_instead_of_dropping():
    _, weeks = _plan(training_days=3)
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    for week in _loading(weeks):
        days = Counter(s.date for s in week.sessions)
        assert len(days) <= 3 and len(week.sessions) == 6
        for day, count in days.items():
            if count > 1:
                assert any(HARD in s.tags for s in week.sessions if s.date == day)


@pytest.mark.parametrize("race_weekday", range(7))
@pytest.mark.parametrize("level", ["novice", "intermediate", "advanced"])
@pytest.mark.parametrize("rest", [frozenset(), frozenset({0, 4}), frozenset({2, 5})])
def test_every_race_day_and_rest_pattern_plans_without_violation(
    race_weekday, level, rest
):
    race_day = START + timedelta(weeks=11, days=race_weekday)
    _, weeks = _plan(race_date=race_day, level=level, rest_days=rest, training_days=4)
    assert plan_violations(weeks, RULES, race_day) == []
    assert not any(
        s.date.weekday() in rest
        for w in weeks
        for s in w.sessions
        if RACE not in s.tags
    )


def test_rest_days_stay_free_and_the_plan_is_deterministic():
    inputs, weeks = _plan(rest_days=frozenset({0, 3}))
    assert not any(s.date.weekday() in {0, 3} for w in weeks for s in w.sessions)
    assert generate_hybrid_plan(inputs, RULES) == weeks


def test_the_division_scales_volume_and_equipment_names_the_stations():
    _, open_weeks = _plan()
    _, pro_weeks = _plan(division="pro", equipment=frozenset({"wall_ball"}))
    assert sum(w.minutes for w in pro_weeks) > sum(w.minutes for w in open_weeks)
    circuits = " ".join(
        s.description for w in pro_weeks for s in w.sessions if STATION in s.tags
    )
    assert "20 wall balls" in circuits and "SkiErg" not in circuits


def test_the_compromised_run_exports_as_running_steps():
    from arete.garmin.workouts import convert
    from arete.services.prescriptions import Prescription

    _, weeks = _plan()
    run = next(s for s in weeks[0].sessions if COMPROMISED in s.tags)
    assert run.sport == "running" and run.prescription is not None
    prescription = Prescription.model_validate(run.prescription)
    repeat = prescription.steps[1]
    assert repeat.kind == "repeat" and repeat.steps[0].value == 1000
    assert repeat.steps[1].duration_kind == "lap" and repeat.steps[1].notes
    payload = convert(1, "Course compromise", "running", prescription)
    assert payload["workoutSegments"]


def test_athlete_level_reads_running_and_strength():
    assert athlete_level(1, 120, 3) == "novice"
    assert athlete_level(3, 150, 0) == "intermediate"
    assert athlete_level(4, 220, 2) == "advanced"


# --------------------------------------------------------------------------- #
# The rules themselves
# --------------------------------------------------------------------------- #
MONDAY = date(2026, 10, 19)


def _session(day: int, *tags: str) -> DraftSession:
    return DraftSession(
        MONDAY + timedelta(days=day), "other", 30, None, None, "", tags=frozenset(tags)
    )


def _week(*sessions: DraftSession, start: date = MONDAY) -> WeekPlan:
    return WeekPlan(
        start=start, phase="build", minutes=0, recovery=False, sessions=list(sessions)
    )


def _rules_broken(*sessions: DraftSession, **kw) -> list[str]:
    return [v.rule for v in violations(_week(*sessions), RULES, **kw)]


def test_heavy_legs_stay_two_days_away_before_the_key_run():
    key = _session(3, KEY_RUN, HARD)
    assert _rules_broken(_session(1, HEAVY_LOWER), key) == [
        "heavy_lower_before_key_run"
    ]
    assert _rules_broken(_session(2, HEAVY_LOWER), key) == [
        "heavy_lower_before_key_run"
    ]
    assert _rules_broken(_session(0, HEAVY_LOWER), key) == []
    assert _rules_broken(_session(4, HEAVY_LOWER), key) == []
    # Same day: only after the key run.
    assert _rules_broken(key, _session(3, HEAVY_LOWER)) == []
    assert _rules_broken(_session(3, HEAVY_LOWER), key) == [
        "heavy_lower_before_key_run"
    ]


def test_no_station_circuit_the_day_before_the_key_run():
    key = _session(3, KEY_RUN)
    assert _rules_broken(_session(2, STATION), key) == ["station_before_key_run"]
    assert _rules_broken(_session(1, STATION), key) == []


def test_hard_days_are_grouped_two_at_most_then_easy():
    assert _rules_broken(*(_session(d, HARD) for d in (1, 2, 3))) == ["hard_days"]
    assert _rules_broken(*(_session(d, HARD) for d in (0, 2, 4, 6))) == ["hard_days"]
    assert _rules_broken(*(_session(d, HARD) for d in (1, 2, 4))) == []


def test_spacing_and_grouping_cross_the_weekend():
    previous = _week(
        DraftSession(
            MONDAY - timedelta(days=1),
            "other",
            30,
            None,
            None,
            "",
            tags=frozenset({HEAVY_LOWER, HARD}),
        ),
        start=MONDAY - timedelta(days=7),
    )
    week = _week(_session(0, HARD), _session(1, KEY_RUN, HARD))
    broken = {v.rule for v in violations(week, RULES, previous=previous)}
    assert broken == {"heavy_lower_before_key_run", "hard_days"}


def test_the_taper_forbids_heavy_legs_and_late_hard_sessions():
    race_day = MONDAY + timedelta(days=12)
    assert _rules_broken(_session(1, HEAVY_LOWER), race_date=race_day) == []
    assert _rules_broken(_session(2, HEAVY_LOWER), race_date=race_day) == ["taper"]
    assert _rules_broken(_session(7, HARD), race_date=race_day) == []
    assert _rules_broken(_session(8, HARD), race_date=race_day) == ["taper"]
