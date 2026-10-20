"""Hyrox and hybrid plans: the interference rules, the weekly mix, the taper."""

from __future__ import annotations

from collections import Counter
from dataclasses import replace
from datetime import date, timedelta

import pytest

from arete.features.hybrid_plan import (
    ACTIVATION,
    BENCHMARK,
    COMPROMISED,
    EASY,
    HARD,
    HEAVY_LOWER,
    HYBRID_PLANNED_RPE,
    KEPT,
    KEY_RUN,
    RACE,
    STATION,
    STRENGTH,
    UPPER,
    HybridInputs,
    athlete_level,
    default_rules,
    generate_hybrid_plan,
    kept_tags,
    kind_of,
    kind_tags,
    plan_violations,
    violations,
)
from arete.features.hybrid_plan import _primary as _primary_kind
from arete.features.plan_generator import (
    PLANNED_RPE,
    DraftSession,
    PlanError,
    WeekPlan,
    monday_of,
    planned_tss,
)
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


# --------------------------------------------------------------------------- #
# Generation keeps every rule, the taper's volume included
# --------------------------------------------------------------------------- #
RESTS = [
    frozenset(),
    frozenset({0}),
    frozenset({2, 5}),
    frozenset({5, 6}),
    frozenset({1, 3, 5, 6}),
]


@pytest.mark.parametrize(
    "rest", RESTS, ids=lambda r: "rest" + "".join(map(str, sorted(r)))
)
@pytest.mark.parametrize("training_days", [3, 4, 5, 6])
@pytest.mark.parametrize("weeks_out", [6, 9, 13])
def test_the_taper_volume_holds_for_every_pattern(rest, training_days, weeks_out):
    for start_day in (0, 3):  # a Monday, then a mid-week start
        for race_weekday in range(7):
            start = START + timedelta(days=start_day)
            race_day = monday_of(start) + timedelta(
                weeks=weeks_out - 1, days=race_weekday
            )
            _, weeks = _plan(
                start=start,
                race_date=race_day,
                rest_days=rest,
                training_days=training_days,
                weekly_minutes_now=100,
            )
            assert plan_violations(weeks, RULES, race_day) == [], (start, race_day)


def test_a_capped_taper_says_which_sessions_it_gave_up():
    # Wednesday race, three training days, two rest days: the taper overflowed.
    race_day = START + timedelta(weeks=5, days=2)
    _, weeks = _plan(
        race_date=race_day,
        weekly_minutes_now=100,
        rest_days=frozenset({2, 5}),
        training_days=3,
    )
    assert plan_violations(weeks, RULES, race_day) == []
    dropped = [line for w in weeks for line in w.dropped]
    assert any("affûtage" in line for line in dropped)


def test_a_full_week_with_three_days_in_a_row_keeps_its_key_sessions():
    _, weeks = _plan(rest_days=frozenset({0, 1, 2, 3}), training_days=3)
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    for week in _loading(weeks):
        mix = _mix(week)
        assert mix[KEY_RUN] == mix[COMPROMISED] == 1
        assert sum(1 for s in week.sessions if STRENGTH in s.tags) >= 1
        if len(week.sessions) < 6:
            assert week.dropped and all("retirée" in line for line in week.dropped)


def test_a_monday_race_keeps_its_activation_in_the_week_before():
    race_day = START + timedelta(weeks=8)  # a Monday
    _, weeks = _plan(race_date=race_day)
    activation = [s for w in weeks for s in w.sessions if ACTIVATION in s.tags]
    assert len(activation) == 1
    assert 2 <= (race_day - activation[0].date).days <= 4
    assert HARD not in activation[0].tags


def test_heavy_legs_on_the_key_run_day_say_they_come_after_it():
    _, weeks = _plan()
    for week in weeks:
        key_days = {s.date for s in week.sessions if KEY_RUN in s.tags}
        for s in week.sessions:
            if HEAVY_LOWER in s.tags and s.date in key_days:
                assert s.description.endswith("(après la course clé)")


def test_a_block_starting_later_does_not_deload_on_todays_load():
    block_end = START + timedelta(weeks=9, days=6)  # starts two weeks from now
    _, weeks = _plan(kind="hybrid", race_date=block_end, weeks=8, acwr=2.0)
    assert weeks[0].start == START + timedelta(weeks=2)
    assert weeks[0].recovery is False
    _, now = _plan(
        kind="hybrid", race_date=block_end - timedelta(weeks=2), weeks=8, acwr=2.0
    )
    assert now[0].recovery is True


def test_the_compromised_run_s_steps_own_its_targets():
    _, weeks = _plan()
    run = next(s for s in weeks[0].sessions if COMPROMISED in s.tags)
    assert run.hr_zone is None and run.intensity is None
    assert run.duration_min  # the planned load the projection reads


def test_strength_and_circuits_weigh_more_only_in_a_hybrid_plan():
    assert planned_tss("strength", 60) == planned_tss("other", 60)  # unchanged
    assert PLANNED_RPE.get("cross_training") is None
    assert planned_tss("strength", 60, HYBRID_PLANNED_RPE) > planned_tss("strength", 60)
    assert planned_tss("cross_training", 60, HYBRID_PLANNED_RPE) > planned_tss(
        "cross_training", 60
    )


# --------------------------------------------------------------------------- #
# Sessions the athlete edited
# --------------------------------------------------------------------------- #
def _kept(kind: str, day: date, level="intermediate", **changes) -> DraftSession:
    """A session of ``kind`` as regeneration reads it back: its stored kind,
    whatever the athlete changed (``changes``)."""
    tags = kind_tags(kind, level)
    assert tags is not None
    plain = DraftSession(day, "other", 45, None, None, "modifiée", tags=tags)
    return replace(plain, **changes)


def _generated(weeks, kind: str):
    return next(s for w in weeks for s in w.sessions if kind_of(s.tags) == kind)


def test_every_generated_kind_reads_back_as_itself():
    _, hyrox = _plan()
    _, novice = _plan(level="novice")
    _, block = _plan(
        kind="hybrid", race_date=START + timedelta(weeks=7, days=6), weeks=8
    )
    for level, weeks in (
        ("intermediate", hyrox),
        ("novice", novice),
        ("intermediate", block),
    ):
        for s in (s for w in weeks for s in w.sessions):
            assert kind_tags(kind_of(s.tags), level) == s.tags | {KEPT}
    assert kind_tags("whatever", "novice") is None


def test_a_moved_key_run_is_not_planned_twice_and_the_rules_see_it():
    week_two = START + timedelta(weeks=1)
    moved = _kept(KEY_RUN, week_two + timedelta(days=3))  # Thursday
    _, weeks = _plan(kept=(moved,))
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    week = next(w for w in weeks if w.start == week_two)
    assert [s for s in week.sessions if KEY_RUN in s.tags] == [moved]
    heavy = [s for s in week.sessions if HEAVY_LOWER in s.tags]
    assert all(not 0 < (moved.date - s.date).days < 3 for s in heavy)
    assert not any(s.date == moved.date and KEPT not in s.tags for s in week.sessions)


def test_a_key_run_given_steps_stays_a_key_run():
    _, plain = _plan()
    week_two = START + timedelta(weeks=1)
    key = next(
        s for w in plain if w.start == week_two for s in w.sessions if KEY_RUN in s.tags
    )
    edited = _kept(KEY_RUN, key.date, prescription={"version": 1, "steps": []})
    _, weeks = _plan(kept=(edited,))
    week = next(w for w in weeks if w.start == week_two)
    assert sum(1 for s in week.sessions if KEY_RUN in s.tags) == 1
    assert sum(1 for s in week.sessions if COMPROMISED in s.tags) == 1


def test_a_moved_activation_is_neither_doubled_nor_hard():
    _, plain = _plan()
    activation = _generated(plain, ACTIVATION)
    moved = _kept(ACTIVATION, activation.date - timedelta(days=1))
    _, weeks = _plan(kept=(moved,))
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    activations = [s for w in weeks for s in w.sessions if ACTIVATION in s.tags]
    assert activations == [moved]


def test_a_moved_benchmark_is_not_planned_twice():
    block_end = START + timedelta(weeks=7, days=6)
    _, plain = _plan(kind="hybrid", race_date=block_end, weeks=8)
    benchmark = _generated(plain, BENCHMARK)
    moved = _kept(BENCHMARK, benchmark.date - timedelta(days=1))
    _, weeks = _plan(kind="hybrid", race_date=block_end, weeks=8, kept=(moved,))
    assert [s for s in weeks[-1].sessions if BENCHMARK in s.tags] == [moved]


@pytest.mark.parametrize(
    "kinds_and_days",
    [
        ((KEY_RUN, 1), (HEAVY_LOWER, 3), (STATION, 5)),
        ((HEAVY_LOWER, 0), (STATION, 2), (KEY_RUN, 4)),
        ((COMPROMISED, 1), (KEY_RUN, 3), (STATION, 5)),
    ],
)
def test_three_kept_hard_days_make_the_week_give_up_a_session(kinds_and_days):
    week_four = START + timedelta(weeks=3)
    kept = tuple(_kept(k, week_four + timedelta(days=d)) for k, d in kinds_and_days)
    _, weeks = _plan(
        kept=kept, rest_days=frozenset({0}) - {d for _, d in kinds_and_days}
    )
    week = next(w for w in weeks if w.start == week_four)
    hard_days = {s.date for s in week.sessions if HARD in s.tags}
    assert len(hard_days) <= 3
    assert week.dropped and all("retirée" in line for line in week.dropped)


def test_kept_hard_days_past_the_cap_get_no_new_one():
    week_four = START + timedelta(weeks=3)
    kept = tuple(
        _kept(kind, week_four + timedelta(days=d))
        for kind, d in ((KEY_RUN, 0), (HEAVY_LOWER, 1), (STATION, 3), (BENCHMARK, 4))
    )
    _, weeks = _plan(kept=kept, rest_days=frozenset())
    week = next(w for w in weeks if w.start == week_four)
    hard_days = {s.date for s in week.sessions if HARD in s.tags}
    assert hard_days == {k.date for k in kept}


def test_kept_heavy_legs_push_the_key_run_away():
    week_two = START + timedelta(weeks=1)
    legs = _kept(HEAVY_LOWER, week_two)  # Monday
    _, weeks = _plan(rest_days=frozenset(), kept=(legs,))
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    week = next(w for w in weeks if w.start == week_two)
    key = next(s for s in week.sessions if KEY_RUN in s.tags)
    assert (key.date - legs.date).days >= 3
    assert sum(1 for s in week.sessions if HEAVY_LOWER in s.tags) == 1


def test_a_kept_session_on_race_day_is_named_in_french():
    on_race_day = _kept(UPPER, RACE_DAY, description="Haut du corps déplacé")
    with pytest.raises(
        PlanError, match="« Haut du corps déplacé » du .* jour de la course"
    ):
        _plan(kept=(on_race_day,))
    old_race = _kept(RACE, RACE_DAY)
    _, weeks = _plan(kept=(old_race,))
    assert [s for s in weeks[-1].sessions if RACE in s.tags] == [old_race]


@pytest.mark.parametrize(("weeks_out", "deload"), [(16, False), (12, True)])
def test_a_hyrox_deloads_only_when_its_plan_starts_now(weeks_out, deload):
    race_day = START + timedelta(weeks=weeks_out - 1, days=5)
    _, weeks = _plan(race_date=race_day, acwr=2.0)
    assert weeks[0].recovery is deload


def test_a_block_not_started_yet_deloads_then_follows_three_one():
    block_end = START + timedelta(weeks=11, days=6)  # starts this Monday
    _, weeks = _plan(kind="hybrid", race_date=block_end, acwr=2.0)
    assert [w.recovery for w in weeks[:9]] == [
        True,
        False,
        False,
        False,
        True,
        False,
        False,
        False,
        True,
    ]


def test_the_week_before_sees_next_week_s_kept_key_run():
    # A Friday start: the first, partial week ends on the weekend before a
    # kept Tuesday key run; heavy legs may not take that weekend.
    key = _kept(KEY_RUN, date(2026, 10, 20), level="advanced")
    race_day = date(2026, 11, 21)
    _, weeks = _plan(
        start=date(2026, 10, 16),
        race_date=race_day,
        level="advanced",
        rest_days=frozenset({0, 2, 4}),
        training_days=6,
        weeks=8,
        acwr=2.0,
        kept=(key,),
    )
    assert plan_violations(weeks, RULES, race_day) == []
    assert not any(
        HEAVY_LOWER in s.tags and 0 < (key.date - s.date).days < 3
        for w in weeks
        for s in w.sessions
    )


def test_a_race_moved_off_race_day_is_not_doubled():
    moved = _kept(RACE, RACE_DAY - timedelta(days=1))
    _, weeks = _plan(kept=(moved,))
    races = [s for w in weeks for s in w.sessions if RACE in s.tags]
    assert races == [moved]


def test_a_kept_easy_run_made_hard_counts_as_hard():
    tags = kept_tags(EASY, "intermediate", "intervals", "hard")
    assert tags is not None and HARD in tags and _primary_kind(tags) == EASY
    activation = kept_tags(ACTIVATION, "intermediate", "intervals", "moderate")
    assert activation is not None and HARD not in activation
    week_two = START + timedelta(weeks=1)
    _, plain = _plan(rest_days=frozenset())
    easy = next(
        s for w in plain if w.start == week_two for s in w.sessions if EASY in s.tags
    )
    edited = replace(easy, session_type="intervals", intensity="hard", tags=tags)
    _, weeks = _plan(rest_days=frozenset(), kept=(edited,))
    assert plan_violations(weeks, RULES, RACE_DAY) == []
    hard_days = sorted({s.date for w in weeks for s in w.sessions if HARD in s.tags})
    run = longest = 1
    for before, day in zip(hard_days, hard_days[1:], strict=False):
        run = run + 1 if (day - before).days == 1 else 1
        longest = max(longest, run)
    assert longest <= 2
    # Still an easy run by kind: nothing doubles it, the key run stays.
    week = next(w for w in weeks if w.start == week_two)
    assert sum(1 for s in week.sessions if EASY in s.tags) == 1
    assert sum(1 for s in week.sessions if KEY_RUN in s.tags) == 1
