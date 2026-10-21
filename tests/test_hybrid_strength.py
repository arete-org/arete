"""Strength sessions and station circuits of Hyrox and hybrid plans (ARE-138)."""

from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta
from itertools import combinations

import pytest

from arete.data.exercise_matcher import match_exercise
from arete.data.exercises_catalog import EXERCISES_BY_ID
from arete.data.garmin_exercises import garmin_catalog_id
from arete.features.hybrid_plan import (
    BENCHMARK,
    HEAVY_LOWER,
    KEPT,
    STATION,
    UPPER,
    HybridInputs,
    default_rules,
    generate_hybrid_plan,
)
from arete.features.running import training_paces
from arete.services import hybrid_strength as hs
from arete.services.adaptation import ACWR_REST_AT, TSB_EASE_AT
from arete.services.prescriptions import Prescription
from arete.strength.models import Exercise, ExerciseCategory, MuscleGroup
from arete.strength.progression import ExerciseSession, WorkSet

RULES = default_rules(acwr_above=ACWR_REST_AT, tsb_below=TSB_EASE_AT)
START = date(2026, 10, 12)  # a Monday
RACE_DAY = START + timedelta(weeks=11, days=5)  # a Saturday, 12 weeks out
EQUIPMENT = ("sled", "ski_erg", "rower", "wall_ball")
#: Garmin or catalog names only a station with its equipment may emit.
NEEDS = {
    "sled": ("Sled Push", "Sled Pull", "traîneau"),
    "ski_erg": ("SkiErg",),
    "rower": ("Rowing Ergometer", "rameur"),
    "wall_ball": ("Wall Ball", "wall ball"),
}
STARTS = {
    "back_squat": hs.Start(100.0, True),
    "rdl": hs.Start(80.0, True),
    "lunges": hs.Start(16.0, True),
    "bench_press": hs.Start(60.0, False),
}


def _weeks(kind="hyrox", level="intermediate", equipment=EQUIPMENT, **kw):
    inputs = HybridInputs(
        start=START,
        race_date=RACE_DAY,
        kind=kind,
        level=level,
        weekly_minutes_now=150,
        training_days=5,
        rest_days=frozenset({0}),
        paces=training_paces(50.0),
        equipment=frozenset(equipment),
        **kw,
    )
    return generate_hybrid_plan(inputs, RULES)


def _prescribed(
    *,
    division="open",
    category="women",
    equipment=EQUIPMENT,
    starts=None,
    kind="hyrox",
    level="intermediate",
):
    return hs.prescribe(
        _weeks(kind=kind, level=level, equipment=equipment, division=division),
        level=level,
        division=division,
        category=category,
        equipment=frozenset(equipment),
        starts=STARTS if starts is None else starts,
    )


def _leaves(steps):
    for step in steps:
        if step["kind"] == "repeat":
            yield from _leaves(step["steps"])
        else:
            yield step


def _sessions(weeks, tag):
    return [(w, s) for w in weeks for s in w.sessions if tag in s.tags]


def _loads(draft):
    """Catalog id -> load of a strength session's sets."""
    out = {}
    for step in _leaves(draft.prescription["steps"]):
        if step["kind"] == "effort" and step.get("garmin_exercise"):
            cid = match_exercise(step["exercise"]).exercise_id
            out.setdefault(cid, set()).add(step["weight_kg"])
    return {
        cid: kg for cid, loads in out.items() if len(loads) == 1 and (kg := loads.pop())
    }


def test_every_strength_session_and_circuit_gets_valid_steps():
    for kind in ("hyrox", "hybrid"):
        weeks = _prescribed(kind=kind)
        targets = [
            s
            for w in weeks
            for s in w.sessions
            if s.tags & {HEAVY_LOWER, UPPER, STATION}
        ]
        assert targets
        for draft in targets:
            assert draft.sport == "strength"
            assert Prescription.model_validate(draft.prescription)
    benchmark = [s for _, s in _sessions(_prescribed(kind="hybrid"), BENCHMARK)]
    assert len(benchmark) == 1


def test_lower_body_follows_the_template_with_rests_and_reps_in_reserve():
    _, lower = _sessions(_prescribed(), HEAVY_LOWER)[0]
    steps = lower.prescription["steps"]
    efforts = [s for s in steps if s["kind"] == "effort"]
    names = [s["garmin_exercise"] for s in efforts]
    assert names == ["Back Squat"] * 4 + ["Romanian Deadlift"] * 3 + ["Lunges"] * 3
    assert [s["value"] for s in efforts[:4]] == [6] * 4
    assert all("RIR 2" in s["notes"] for s in efforts)
    assert steps[-1]["kind"] == "effort"  # no rest after the last set
    assert {s["value"] for s in steps if s["kind"] == "rest"} == {150, 120, 90}
    # The French names read back as the same catalog exercises in the log.
    assert {match_exercise(s["exercise"]).exercise_id for s in efforts} == {
        "back_squat",
        "rdl",
        "lunges",
    }


def test_no_history_leaves_the_load_to_the_athlete():
    weeks = _prescribed(starts={})
    for _, draft in _sessions(weeks, HEAVY_LOWER) + _sessions(weeks, UPPER):
        for step in _leaves(draft.prescription["steps"]):
            if step["kind"] != "effort":
                continue
            assert step["weight_kg"] is None
            entry = EXERCISES_BY_ID[match_exercise(step["exercise"]).exercise_id]
            loaded = entry["equipment"] != ["bodyweight"]
            assert ("charge à choisir" in step["notes"]) == loaded


def _week_loads(weeks):
    """(week, catalog id -> load) of every week's strength sessions."""
    return [
        (
            w,
            {
                k: v
                for s in w.sessions
                if s.tags & {HEAVY_LOWER, UPPER}
                for k, v in _loads(s).items()
            },
        )
        for w in weeks
    ]


def _light(week):
    return week.recovery or week.phase in ("taper", "race")


def _check_progression(history, starts):
    """One rise per loading block at most, within 15 % of the start; a light
    week strictly under the block before it."""
    current: dict[str, float] = {}
    after_light = False
    for week, loads in history:
        for cid, kg in loads.items():
            assert kg <= round(starts[cid].weight_kg * 1.15, 6), (week.start, cid)
            if cid not in current:
                current[cid] = kg
            elif _light(week):
                assert kg < current[cid], (week.start, cid)
            elif after_light:
                assert kg >= current[cid], (week.start, cid)
                current[cid] = kg
            else:  # same block, same load
                assert kg == current[cid], (week.start, cid)
        after_light = _light(week) and bool(loads)


def test_a_12_week_novice_plan_rises_once_per_block():
    weeks = _prescribed(level="novice")
    history = _week_loads(weeks)
    _check_progression(history, STARTS)
    squat = [(_light(w), x["back_squat"]) for w, x in history if "back_squat" in x]
    # Three loading blocks: 100, then 105, then 110; lighter weeks below.
    loading = [kg for light, kg in squat if not light]
    assert sorted(set(loading)) == [100.0, 105.0, 110.0]
    assert loading == sorted(loading)
    assert [kg for light, kg in squat if light][0] == 90.0  # 100 kg × 0.9
    # The first loading week starts from the history's next load.
    first = next(x for w, x in history if "back_squat" in x and not _light(w))
    assert first["back_squat"] == 100.0 and first["bench_press"] == 60.0


def test_a_16_week_pro_cycle_caps_the_rise_at_15_percent():
    template = next(w for w in _weeks(division="pro") if not _light(w))
    weeks = [
        replace(
            template,
            start=template.start + timedelta(weeks=k),
            recovery=k % 4 == 3,
            phase="build",
        )
        for k in range(16)
    ]
    out = hs.prescribe(
        weeks,
        level="intermediate",
        division="pro",
        category="men",
        equipment=frozenset(EQUIPMENT),
        starts=STARTS,
    )
    history = _week_loads(out)
    _check_progression(history, STARTS)
    blocks = [loads for w, loads in history if not w.recovery][::3]
    # Squat 100 → 115 (+15 %, reached); lunges 16 → 18 (19 would pass 18.4).
    assert [b["back_squat"] for b in blocks] == [100.0, 105.0, 110.0, 115.0]
    assert [b["lunges"] for b in blocks] == [16.0, 17.0, 18.0, 18.0]
    assert [b["bench_press"] for b in blocks] == [60.0, 62.5, 65.0, 67.5]
    deloads = [loads["back_squat"] for w, loads in history if w.recovery]
    assert deloads == [90.0, 95.0, 100.0, 102.5]
    # Pro circuits: four rounds on loading weeks, two on deloads.
    for week in out:
        for circuit in week.sessions:
            if STATION in circuit.tags:
                rounds = circuit.prescription["steps"][1]["repeat"]
                assert rounds == (2 if week.recovery else 4)
                assert f"{rounds} tours" in circuit.description


@pytest.mark.parametrize(
    "division,category,expected",
    [
        ("open", "women", (102, 78, 16, 10, 4)),
        ("open", "men", (152, 103, 24, 20, 6)),
        ("pro", "women", (152, 103, 24, 20, 6)),
        ("pro", "men", (202, 153, 32, 30, 9)),
        ("open", "mixed", (152, 103, 24, 20, 6)),
    ],
)
def test_station_loads_are_the_official_ones(division, category, expected):
    loads = hs.station_loads(division, category)
    assert loads is not None
    assert (
        loads.sled_push,
        loads.sled_pull,
        loads.farmers_carry,
        loads.sandbag_lunges,
        loads.wall_ball,
    ) == expected
    by_garmin = {
        "Sled Push": expected[0],
        "Sled Pull": expected[1],
        "Farmer Carry": expected[2],
        "Sandbag Lunges": expected[3],
        "Wall Ball": expected[4],
    }
    weeks = _prescribed(division=division, category=category)
    seen = set()
    for _, circuit in _sessions(weeks, STATION):
        for step in _leaves(circuit.prescription["steps"]):
            name = step.get("garmin_exercise")
            if name in by_garmin:
                assert step["weight_kg"] == by_garmin[name], name
                seen.add(name)
    assert seen == set(by_garmin)


def test_without_a_category_stations_carry_no_load():
    weeks = _prescribed(category=None)
    for _, circuit in _sessions(weeks, STATION):
        for step in _leaves(circuit.prescription["steps"]):
            assert step.get("weight_kg") is None
        assert "charge de ta catégorie" in circuit.description


@pytest.mark.parametrize(
    "equipment",
    [combo for n in range(len(EQUIPMENT) + 1) for combo in combinations(EQUIPMENT, n)],
)
def test_circuits_never_emit_missing_equipment(equipment):
    weeks = _prescribed(equipment=equipment, kind="hybrid")
    missing = [
        word for flag in EQUIPMENT if flag not in equipment for word in NEEDS[flag]
    ]
    circuits = _sessions(weeks, STATION)
    assert circuits
    for _, circuit in circuits:
        texts = [circuit.description.casefold()] + [
            f"{s.get('garmin_exercise', '')} {s.get('notes', '')}".casefold()
            for s in _leaves(circuit.prescription["steps"])
        ]
        for word in missing:
            assert not any(word.casefold() in text for text in texts), (word, texts)


def test_a_circuit_works_by_time_reps_and_lap_and_says_so():
    weeks = _prescribed(category="men")
    timed = reps = laps = 0
    for _, circuit in _sessions(weeks, STATION):
        if BENCHMARK in circuit.tags:
            continue
        assert circuit.description.startswith("Circuit stations, ")
        repeat = circuit.prescription["steps"][1]
        assert repeat["kind"] == "repeat" and repeat["repeat"] in (2, 3)
        for step in repeat["steps"]:
            if step["kind"] == "rest":
                assert step["value"] in (hs.STATION_REST_SEC, hs.ROUND_REST_SEC)
                continue
            assert step["duration_kind"] != "meters"
            timed += step["duration_kind"] == "seconds"
            reps += step["duration_kind"] == "reps"
            if step["duration_kind"] == "lap":
                laps += 1
                assert not step.get("garmin_exercise") and step["notes"]
            else:
                assert step["notes"].split(" à ")[0] in circuit.description
    assert timed and reps and laps


def test_the_benchmark_is_fixed_work_with_laps_for_distances():
    weeks = _prescribed(kind="hybrid", category="men")
    ((_, test),) = _sessions(weeks, BENCHMARK)
    steps = test.prescription["steps"]
    assert [s["notes"] for s in steps if s["notes"] == "1 km de course"] == [
        "1 km de course"
    ] * 4
    notes = " ".join(s["notes"] for s in steps)
    assert "25 m de poussée de traîneau à 152 kg" in notes
    assert "25 m de tirage de traîneau à 103 kg" in notes
    assert all(s["duration_kind"] in ("lap", "reps") for s in steps)
    assert "luge" not in test.description + notes


def test_kept_sessions_keep_their_content():
    weeks = _weeks()
    week = weeks[2]
    lower = next(s for s in week.sessions if HEAVY_LOWER in s.tags)
    kept = replace(lower, tags=lower.tags | {KEPT}, description="Ma séance")
    week.sessions[week.sessions.index(lower)] = kept
    out = hs.prescribe(
        weeks,
        level="intermediate",
        division="open",
        category="men",
        equipment=frozenset(EQUIPMENT),
        starts=STARTS,
    )
    assert kept in out[2].sessions and kept.prescription is None


def test_starting_loads_read_the_next_suggested_load():
    squat = Exercise(
        id=7,
        name="Back Squat",
        category=ExerciseCategory.SQUAT,
        primary_muscle=MuscleGroup("quads"),
    )

    class Repo:
        def get_exercise_by_catalog_id(self, cid):
            return squat if cid == "back_squat" else None

        def working_sessions(self, ids):
            assert ids == [7]
            sets = [WorkSet(6, 100.0, rir=3)] * 3
            return {7: [ExerciseSession(1, date(2026, 10, 1), sets)]}

    starts = hs.starting_loads(Repo())
    # Three reps in reserve: one lower-body increment above 100 kg.
    assert starts == {"back_squat": hs.Start(105.0, True)}


@pytest.mark.parametrize(
    "name,catalog_id",
    [
        ("fentes sandbag", "sandbag_lunges"),
        ("Fentes avec sac de sable", "sandbag_lunges"),
        ("sandbag lunges", "sandbag_lunges"),
        ("Fentes", "lunges"),
        ("fentes marchées", "lunges"),
        ("rameur", "row_erg"),
        ("farmers", "farmer_carry"),
        ("SkiErg", "ski_erg"),
        ("Poussée de traîneau", "sled_push"),
        ("Tirage de traîneau", "sled_pull"),
        ("sled push", "sled_push"),
        ("Burpee saut en longueur", "burpee_broad_jump"),
        ("Wall ball", "wall_ball"),
    ],
)
def test_catalog_names_and_aliases_resolve(name, catalog_id):
    assert match_exercise(name).exercise_id == catalog_id


@pytest.mark.parametrize(
    "category,sub,catalog_id",
    [
        ("SLED", "PUSH", "sled_push"),
        ("SLED", "BACKWARD_DRAG", "sled_pull"),
        ("SQUAT", "WALL_BALL", "wall_ball"),
        ("ROW", "INDOOR_ROW", "row_erg"),
        ("CARRY", "FARMERS_CARRY", "farmer_carry"),
        ("SANDBAG", "LUNGE", "sandbag_lunges"),
        ("LUNGE", "LUNGE", "lunges"),
        ("BENCH_PRESS", "BARBELL_BENCH_PRESS", "bench_press"),
        ("BANDED_EXERCISES", "LUNGE", None),  # too generic without its category
        ("SLED", "FORWARD_DRAG", None),
    ],
)
def test_garmin_station_names_map_back_to_the_catalog(category, sub, catalog_id):
    assert garmin_catalog_id(category, sub) == catalog_id


def _exported():
    """(name the step sends, catalog id) of every generated exercise."""
    for table in (hs.LOWER, hs.UPPER_BODY):
        for lifts in table.values():
            for lift in lifts:
                yield EXERCISES_BY_ID[lift.exercise]["name"], lift.exercise
    for dose in (*hs.CIRCUIT.values(), *hs.FALLBACKS.values()):
        if dose.catalog:
            yield dose.garmin, dose.catalog


@pytest.mark.parametrize("name,catalog_id", sorted(set(_exported())))
def test_every_generated_exercise_round_trips_through_garmin(name, catalog_id):
    """What a plan exports comes back on import as the same catalog exercise,
    so the strength draft keeps it."""
    from garminconnect.exercises import resolve

    from arete.garmin.workouts import _STRENGTH_NAMES

    entry = resolve(_STRENGTH_NAMES.get(name, name))
    assert entry is not None, name
    assert garmin_catalog_id(entry["category"], entry["exercise"]) == catalog_id


def test_every_named_station_dose_says_its_catalog_exercise():
    for dose in (*hs.CIRCUIT.values(), *hs.FALLBACKS.values()):
        if dose.catalog:
            assert match_exercise(dose.exercise).exercise_id == dose.catalog, dose
