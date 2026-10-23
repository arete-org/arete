"""Triathlon plans: the weeks, the sessions, the rules and the targets."""

from __future__ import annotations

import time
from dataclasses import replace
from datetime import date, timedelta
from itertools import product

import pytest

from arete.features.plan_generator import DraftSession, PlanError, WeekPlan
from arete.features.running import training_paces
from arete.features.tri_plan import (
    ACTIVATION,
    BIKE_EASY,
    BIKE_KEY,
    BRICK_BIKE,
    BRICK_LONG_RIDE,
    BRICK_RUN,
    EASY_RUN,
    KEY_RUN,
    KINDS,
    LAST_HARD_DAYS,
    LONG_CAP,
    LONG_RIDE,
    LONG_RUN,
    MAX_WEEKS,
    MIN_WEEKS,
    SPLIT,
    SWIM_EASY,
    SWIM_KEY,
    TAPER_DAYS,
    TAPER_RIDE,
    TAPER_RUN,
    TriInputs,
    generate_tri_plan,
    kept_tags,
    kind_of,
    sport_minutes,
    tri_level,
    tri_rules,
)
from arete.features.week_placement import HARD, KEPT, RACE, plan_violations
from arete.services.prescriptions import Prescription

START = date(2026, 10, 12)  # a Monday
PACES = training_paces(48.0)


def _inputs(**kw) -> TriInputs:
    distance = kw.get("distance", "olympic")
    values = {
        "start": START,
        # A Sunday race, the longest plan the distance allows.
        "race_date": START + timedelta(weeks=MAX_WEEKS[distance] - 1, days=6),
        "distance": distance,
        "level": "intermediate",
        "hours_per_week": 9,
        "weekly_minutes_now": 300,
        "training_days": 6,
        "rest_days": frozenset({0}),
        "paces": PACES,
        "ftp_w": 240,
        "css_sec_100m": 105,
        "race_name": "Triathlon de Paris",
    }
    values.update(kw)
    return TriInputs(**values)


def _rules(inp: TriInputs):
    return tri_rules(inp.level, inp.distance, acwr_above=1.5, tsb_below=-20)


def _plan(**kw) -> tuple[TriInputs, list[WeekPlan]]:
    inp = _inputs(**kw)
    return inp, generate_tri_plan(inp, _rules(inp))


def _sessions(weeks):
    return [s for w in weeks for s in w.sessions]


def _loading(weeks):
    return [w for w in weeks if w.phase in ("base", "build", "specific")]


def _kinds(week: WeekPlan) -> list[str]:
    return [kind_of(s.tags) for s in week.sessions]


# --------------------------------------------------------------------------- #
# Every rule, everywhere
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("distance", "level", "rest_days", "race_weekday"),
    list(
        product(
            ("sprint", "olympic", "half", "full"),
            ("novice", "intermediate", "advanced"),
            (frozenset({0}), frozenset({0, 4}), frozenset()),
            (6, 5, 0),
        )
    ),
)
def test_no_plan_breaks_a_rule_or_the_declared_hours(
    distance, level, rest_days, race_weekday
):
    hours = {"sprint": 3, "olympic": 7, "half": 10, "full": 16}[distance]
    race = START + timedelta(weeks=MAX_WEEKS[distance] - 1, days=race_weekday)
    inp, weeks = _plan(
        distance=distance,
        level=level,
        rest_days=rest_days,
        race_date=race,
        hours_per_week=hours,
        training_days=5,
    )
    assert plan_violations(weeks, _rules(inp), race) == []
    for week in weeks:
        assert week.minutes <= hours * 60
        # The race keeps its day, a rest day or not.
        assert all(
            s.date.weekday() not in rest_days
            for s in week.sessions
            if RACE not in s.tags
        )
        assert all(START <= s.date <= race for s in week.sessions)
        # One session of each kind, three activations at most.
        kinds = _kinds(week)
        assert all(kinds.count(k) <= 1 for k in KINDS if k != ACTIVATION)
        assert kinds.count(ACTIVATION) <= 3
    race_sessions = [s for s in _sessions(weeks) if RACE in s.tags]
    assert [s.date for s in race_sessions] == [race]


def test_a_24_week_ironman_on_few_days_is_placed_quickly():
    """The search stays bounded: 24 weeks of eight sessions on four days."""
    began = time.perf_counter()
    inp, weeks = _plan(
        distance="full",
        level="advanced",
        hours_per_week=17,
        weekly_minutes_now=700,
        training_days=4,
        rest_days=frozenset({0, 4, 2}),
    )
    assert time.perf_counter() - began < 5
    assert len(weeks) == 24
    assert plan_violations(weeks, _rules(inp), inp.race_date) == []
    for week in weeks:
        assert len({s.date for s in week.sessions}) <= 4


def test_the_same_inputs_give_the_same_plan():
    assert _plan()[1] == _plan()[1]


# --------------------------------------------------------------------------- #
# Length, phases, volume
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("distance", ["sprint", "olympic", "half", "full"])
def test_the_plan_length_follows_the_distance(distance):
    least, most = MIN_WEEKS[distance], MAX_WEEKS[distance]
    _, weeks = _plan(
        distance=distance, race_date=START + timedelta(weeks=most + 5, days=6)
    )
    assert len(weeks) == most
    _, short = _plan(
        distance=distance, race_date=START + timedelta(weeks=least - 1, days=6)
    )
    assert len(short) == least
    with pytest.raises(PlanError, match="trop tard"):
        _plan(distance=distance, race_date=START + timedelta(weeks=least - 2, days=6))


def test_phases_run_base_build_specific_taper_race():
    _, weeks = _plan(distance="full")
    phases = [w.phase for w in weeks]
    assert phases[-3:] == ["taper", "taper", "race"]
    order = ["base", "build", "specific", "taper", "race"]
    assert phases == sorted(phases, key=order.index)
    assert phases.count("specific") == 6


def test_loading_follows_three_weeks_up_one_down():
    _, weeks = _plan(distance="half", hours_per_week=12, weekly_minutes_now=240)
    loading = _loading(weeks)
    assert [w.recovery for w in loading] == [
        (i + 1) % 4 == 0 for i in range(len(loading))
    ]
    for before, lighter in zip(loading, loading[1:], strict=False):
        if lighter.recovery:
            assert lighter.minutes < before.minutes


@pytest.mark.parametrize("hours", [6, 8, 25])
def test_no_week_goes_past_the_declared_hours_or_the_level_s_peak(hours):
    _, weeks = _plan(distance="half", hours_per_week=hours, weekly_minutes_now=900)
    peak = min(hours, 10) * 60  # an intermediate's 70.3 peaks at 10 hours
    assert max(w.minutes for w in weeks) <= peak + 30  # rounded sessions


@pytest.mark.parametrize("distance", ["sprint", "olympic", "half", "full"])
def test_loading_weeks_split_the_sports_by_distance(distance):
    _, weeks = _plan(distance=distance, hours_per_week=25, level="advanced")
    totals = {"swimming": 0, "cycling": 0, "running": 0}
    for week in _loading(weeks):
        for sport, minutes in sport_minutes(week).items():
            totals[sport] += minutes
    whole = sum(totals.values())
    for sport, share in zip(totals, SPLIT[distance], strict=True):
        assert abs(totals[sport] / whole - share) < 0.08, (sport, totals)


@pytest.mark.parametrize("distance", ["sprint", "olympic", "half", "full"])
def test_long_sessions_stay_under_their_caps(distance):
    _, weeks = _plan(distance=distance, hours_per_week=25, level="advanced")
    for s in _sessions(weeks):
        if LONG_RIDE in s.tags:
            assert (s.duration_min or 0) <= LONG_CAP["bike"][distance]
        if LONG_RUN in s.tags:
            assert (s.duration_min or 0) <= LONG_CAP["run"][distance]
        if SWIM_EASY in s.tags:
            assert (s.duration_min or 0) <= LONG_CAP["swim"][distance]


def test_tri_level_reads_hours_and_sports():
    assert tri_level(500, 1) == "novice"
    assert tri_level(200, 3) == "novice"
    assert tri_level(300, 2) == "intermediate"
    assert tri_level(480, 2) == "intermediate"
    assert tri_level(480, 3) == "advanced"


# --------------------------------------------------------------------------- #
# The week's sessions
# --------------------------------------------------------------------------- #
def test_a_novice_week_holds_six_sessions_the_others_eight():
    _, novice = _plan(level="novice", hours_per_week=6)
    _, others = _plan(hours_per_week=10)
    base = next(w for w in novice if w.phase == "base" and not w.recovery)
    assert sorted(_kinds(base)) == sorted(
        [SWIM_KEY, SWIM_EASY, BIKE_KEY, LONG_RIDE, KEY_RUN, LONG_RUN]
    )
    base = next(w for w in others if w.phase == "base" and not w.recovery)
    assert sorted(_kinds(base)) == sorted(
        [
            SWIM_KEY,
            SWIM_EASY,
            BIKE_KEY,
            LONG_RIDE,
            BIKE_EASY,
            KEY_RUN,
            LONG_RUN,
            EASY_RUN,
        ]
    )
    assert not any(s.sport == "strength" for s in _sessions(novice + others))


def _brick_days(week: WeekPlan) -> list[date]:
    return [s.date for s in week.sessions if BRICK_BIKE in s.tags]


@pytest.mark.parametrize("distance", ["sprint", "olympic", "half", "full"])
def test_bricks_run_straight_off_the_bike_from_the_build_phase(distance):
    _, weeks = _plan(distance=distance, hours_per_week=12)
    for week in weeks:
        bikes = [s for s in week.sessions if BRICK_BIKE in s.tags]
        runs = [s for s in week.sessions if BRICK_RUN in s.tags]
        if week.phase in ("base", "taper", "race"):
            assert not bikes and not runs
            continue
        assert len(bikes) == len(runs) == 1
        bike, run = bikes[0], runs[0]
        assert bike.date == run.date and bike.sport == "cycling"
        # Done in that order: the bike first in the day, so written first.
        assert week.sessions.index(bike) < week.sessions.index(run)
        assert "enchaînement, juste après le vélo" in run.description
        on_long = week.phase == "specific" and distance in ("half", "full")
        assert (LONG_RIDE in bike.tags) == on_long
        assert (BIKE_KEY in bike.tags) == (not on_long)
        assert [s for s in week.sessions if s.date == bike.date] == [bike, run]


def test_a_recovery_week_s_brick_runs_ten_easy_minutes():
    _, weeks = _plan(distance="full", hours_per_week=14)
    recovery = [w for w in weeks if w.recovery and w.phase in ("build", "specific")]
    assert recovery
    for week in recovery:
        run = next(s for s in week.sessions if BRICK_RUN in s.tags)
        assert run.duration_min == 10 and run.intensity == "easy"


def test_two_sessions_share_a_day_only_as_a_brick_or_with_a_swim():
    _, weeks = _plan(training_days=4, rest_days=frozenset({0, 2}))
    for week in weeks:
        for day in {s.date for s in week.sessions}:
            same = [s for s in week.sessions if s.date == day]
            if len(same) < 2:
                continue
            assert len(same) == 2
            kinds = {kind_of(s.tags) for s in same}
            swims = [s for s in same if s.sport == "swimming"]
            assert kinds == {BRICK_BIKE, BRICK_RUN} or (
                len(swims) == 1
                and not any(s.tags & {LONG_RIDE, LONG_RUN, RACE} for s in same)
            )


def test_the_long_ride_and_the_long_run_are_never_on_consecutive_days():
    _, weeks = _plan(distance="half", hours_per_week=12)
    longs = sorted(
        s.date
        for s in _sessions(weeks)
        if s.tags & {LONG_RIDE, LONG_RUN} and "long" in s.tags
    )
    assert all((b - a).days != 1 for a, b in zip(longs, longs[1:], strict=False))


# --------------------------------------------------------------------------- #
# Taper and race week
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("distance", ["sprint", "olympic", "half", "full"])
def test_the_taper_lightens_and_ends_hard_sessions_early(distance):
    inp, weeks = _plan(distance=distance, hours_per_week=12)
    race = inp.race_date
    hard = [s.date for s in _sessions(weeks) if HARD in s.tags and RACE not in s.tags]
    assert (race - max(hard)).days >= LAST_HARD_DAYS[distance]
    days = TAPER_DAYS[distance]
    window = [s for s in _sessions(weeks) if 0 < (race - s.date).days <= days]
    peak = max(w.minutes for w in _loading(weeks))
    assert sum(s.duration_min or 0 for s in window) * 7 / days <= 0.6 * peak
    assert not any("long" in s.tags for s in window)


def test_race_week_activates_each_sport_then_races():
    inp, weeks = _plan(distance="olympic")
    race_week = weeks[-1]
    race = race_week.sessions[-1]
    assert (race.sport, race.session_type, race.date) == (
        "other",
        "race",
        inp.race_date,
    )
    assert race.description == (
        "Triathlon de Paris — Triathlon M : 1,5 km natation · 40 km vélo · "
        "10 km course à pied"
    )
    assert race.distance_km == 51.5
    activations = {
        s.sport: (inp.race_date - s.date).days
        for s in race_week.sessions
        if ACTIVATION in s.tags
    }
    assert activations == {"swimming": 3, "cycling": 2, "running": 1}
    assert not any(HARD in s.tags for s in race_week.sessions if RACE not in s.tags)
    bike = next(
        s for s in race_week.sessions if ACTIVATION in s.tags and s.sport == "cycling"
    )
    assert "vérifie ton vélo" in bike.description


def test_a_monday_race_activates_the_week_before():
    race = START + timedelta(weeks=15)  # a Monday
    inp, weeks = _plan(race_date=race)
    before = {
        s.sport: (race - s.date).days
        for s in weeks[-2].sessions
        if ACTIVATION in s.tags
    }
    # A rest day or a long session may move one by a day, never past the race.
    assert set(before) == {"swimming", "cycling", "running"}
    assert all(1 <= days <= 4 for days in before.values())
    assert plan_violations(weeks, _rules(inp), race) == []


def test_the_ironman_distance_is_named_without_a_trademark_claim():
    _, weeks = _plan(distance="full", race_name="IM Nice", hours_per_week=14)
    assert (
        weeks[-1]
        .sessions[-1]
        .description.startswith(
            "IM Nice — Triathlon distance Ironman : 3,8 km natation"
        )
    )


# --------------------------------------------------------------------------- #
# Targets and the Garmin export
# --------------------------------------------------------------------------- #
def _bike_keys(weeks) -> list[DraftSession]:
    return [s for s in _sessions(weeks) if BIKE_KEY in s.tags]


def _efforts(prescription: dict) -> list[dict]:
    out = []
    for step in prescription["steps"]:
        out += step["steps"] if step["kind"] == "repeat" else [step]
    return [s for s in out if s["kind"] == "effort"]


def test_bike_intervals_target_watts_from_the_ftp():
    _, weeks = _plan(ftp_w=250)
    tempo = next(s for s in _bike_keys(weeks) if "tempo" in s.description)
    effort = _efforts(tempo.prescription or {})[0]
    assert effort["target"] == {"kind": "power_w", "low": 190, "high": 218}
    assert "190–218 W" in tempo.description


def test_without_an_ftp_bike_intervals_target_heart_rate_zones_else_effort():
    _, weeks = _plan(ftp_w=None, hr_reference=True)
    zones = {
        e["target"]["low"]
        for s in _bike_keys(weeks)
        for e in _efforts(s.prescription or {})
    }
    assert zones <= {2, 3, 4} and {3, 4} <= zones
    _, bare = _plan(ftp_w=None, hr_reference=False)
    for s in _bike_keys(bare):
        for e in _efforts(s.prescription or {}):
            assert "target" not in e and e["notes"]


@pytest.mark.parametrize("pool", [25, 50])
@pytest.mark.parametrize("css", [None, 98])
def test_swims_are_whole_lengths_with_their_pace_in_the_notes(pool, css):
    _, weeks = _plan(
        pool_length_m=pool, css_sec_100m=css, distance="full", hours_per_week=14
    )
    swims = [s for s in _sessions(weeks) if s.prescription and s.sport == "swimming"]
    assert swims
    for s in swims:
        prescription = Prescription.model_validate(s.prescription)
        assert prescription.pool_length_m == pool

        def visit(steps):
            for step in steps:
                if step.kind == "repeat":
                    visit(step.steps)
                    continue
                assert step.target is None
                if step.duration_kind == "meters":
                    assert step.value % pool == 0

        visit(prescription.steps)
    notes = " ".join(e["notes"] for s in swims for e in _efforts(s.prescription or {}))
    assert ("CSS" in notes) == (css is not None)


@pytest.mark.parametrize("ftp", [None, 260])
@pytest.mark.parametrize("hr_reference", [False, True])
def test_every_prescribed_session_exports_to_garmin(ftp, hr_reference):
    from arete.garmin.workouts import convert

    zones = [(0, 120), (120, 140), (140, 155), (155, 170), (170, None)]
    _, weeks = _plan(
        distance="full", ftp_w=ftp, hr_reference=hr_reference, hours_per_week=14
    )
    prescribed = [s for s in _sessions(weeks) if s.prescription is not None]
    assert {s.sport for s in prescribed} == {"swimming", "cycling"}
    for s in prescribed:
        prescription = Prescription.model_validate(s.prescription)
        payload = convert(1, s.description[:40], s.sport, prescription, hr_ranges=zones)
        assert payload["workoutSegments"][0]["workoutSteps"]


def test_runs_are_written_as_the_running_grammar_reads_them():
    from arete.llm.running_grammar import parse_running

    _, weeks = _plan(distance="half", hours_per_week=12)
    keys = [s for s in _sessions(weeks) if KEY_RUN in s.tags]
    assert keys and all(parse_running(s.description) for s in keys)


# --------------------------------------------------------------------------- #
# Sessions the athlete edited
# --------------------------------------------------------------------------- #
def _kept(session: DraftSession, **changes) -> DraftSession:
    """A generated session as regeneration reads it back, edited."""
    tags = kept_tags(
        kind_of(session.tags), session.sport, session.session_type, session.intensity
    )
    assert tags is not None
    return replace(session, tags=tags, prescription=None, **changes)


@pytest.mark.parametrize("distance", ["sprint", "olympic", "half", "full"])
@pytest.mark.parametrize("level", ["novice", "intermediate", "advanced"])
@pytest.mark.parametrize("ftp", [None, 250])
def test_every_generated_session_reads_back_with_its_exact_tags(distance, level, ftp):
    """What regeneration reads back from a stored kind is what the rules saw:
    a long brick stays long, a taper ride is not long, the Ironman's race
    power ride stays easy."""
    _, weeks = _plan(distance=distance, level=level, ftp_w=ftp, hours_per_week=14)
    seen = set()
    for s in _sessions(weeks):
        kind = kind_of(s.tags)
        seen.add(kind)
        assert kept_tags(kind, s.sport, s.session_type, s.intensity) == s.tags | {KEPT}
    assert {BRICK_RUN, ACTIVATION, RACE} <= seen
    # A sprint's taper is its race week: no taper week, no taper ride.
    assert ({TAPER_RIDE, TAPER_RUN} <= seen) == (distance != "sprint")
    assert (BRICK_LONG_RIDE in seen) == (distance in ("half", "full"))
    assert kept_tags("compromised", "running", "tempo", None) is None


def test_a_moved_key_run_is_not_planned_twice():
    inp, plain = _plan()
    week = plain[2]
    key = next(s for s in week.sessions if KEY_RUN in s.tags)
    moved = _kept(key, date=week.start + timedelta(days=4), description="déplacée")
    _, weeks = _plan(kept=(moved,))
    again = next(w for w in weeks if w.start == week.start)
    assert [s for s in again.sessions if KEY_RUN in s.tags] == [moved]
    assert plan_violations(weeks, _rules(inp), inp.race_date) == []


def _brick_week(**kw):
    inp, plain = _plan(distance="olympic", hours_per_week=10, **kw)
    week = next(w for w in plain if w.phase == "build" and not w.recovery)
    bike = next(s for s in week.sessions if BRICK_BIKE in s.tags)
    run = next(s for s in week.sessions if BRICK_RUN in s.tags)
    return inp, week, bike, run


def test_a_kept_brick_bike_gets_its_run_after_it_that_day():
    inp, week, bike, _ = _brick_week()
    kept = _kept(bike, description="modifiée")
    _, weeks = _plan(distance="olympic", hours_per_week=10, kept=(kept,))
    again = next(w for w in weeks if w.start == week.start)
    day = [s for s in again.sessions if s.date == kept.date]
    assert len(day) == 2 and day[0] == kept
    assert BRICK_RUN in day[1].tags and KEPT not in day[1].tags
    assert sum(1 for s in again.sessions if BRICK_BIKE in s.tags) == 1
    assert plan_violations(weeks, _rules(inp), inp.race_date) == []


def test_a_kept_brick_run_stays_alone_and_its_bike_is_not_recreated():
    inp, week, _, run = _brick_week()
    kept = _kept(run, description="modifiée")
    _, weeks = _plan(distance="olympic", hours_per_week=10, kept=(kept,))
    again = next(w for w in weeks if w.start == week.start)
    assert [s for s in again.sessions if s.date == kept.date] == [kept]
    assert not any(BRICK_BIKE in s.tags for s in again.sessions)
    # Its ride is not planned as a plain bike key either.
    assert not any(BIKE_KEY in s.tags for s in again.sessions)
    assert again.dropped[0] == (
        "Vélo de l'enchaînement non recréé : tu as modifié la course qui le suit."
    )
    assert plan_violations(weeks, _rules(inp), inp.race_date) == []


@pytest.mark.parametrize("order", ["bike-run", "run-bike"])
def test_both_kept_brick_halves_stay_as_they_are(order):
    inp, week, bike, run = _brick_week()
    halves = (_kept(bike), _kept(run))
    kept = halves if order == "bike-run" else halves[::-1]
    _, weeks = _plan(distance="olympic", hours_per_week=10, kept=kept)
    again = next(w for w in weeks if w.start == week.start)
    assert [s for s in again.sessions if s.date == bike.date] == list(halves)
    assert sum(1 for s in again.sessions if s.tags & {BRICK_BIKE, BRICK_RUN}) == 2
    assert again.dropped == [] or "Vélo de l'enchaînement" not in again.dropped[0]


def test_a_kept_session_on_race_day_is_refused():
    inp, plain = _plan()
    easy = next(s for s in plain[-2].sessions if EASY_RUN in s.tags)
    with pytest.raises(PlanError, match="jour de la course"):
        _plan(kept=(_kept(easy, date=inp.race_date),))


def test_too_few_training_days_are_refused():
    with pytest.raises(PlanError, match="Au moins 4 jours"):
        _plan(rest_days=frozenset({0, 1, 2, 3}))
