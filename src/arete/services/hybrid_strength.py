"""The steps of a Hyrox or hybrid plan's strength sessions and station circuits.

``features.hybrid_plan`` decides which sessions a week holds and where; this
module writes their steps so they export to Garmin and feed the strength log
like any structured strength session: catalog exercises with sets, reps (or
seconds), rests and reps in reserve, and station work with its official load.

Loads come from the athlete's own history (``strength.progression``): the
next session's load, then one increment per loading week; a deload or taper
week keeps about 90 % of it and never more. An exercise never logged has no
load: the athlete fills it in. Station loads follow the goal's division and
category; without a category, the notes ask for the category's load.

Garmin strength steps end on reps, time or the lap button, never on a
distance: a station Garmin has no exercise for (SkiErg, burpee broad jumps),
and every distance in the end-of-block test, is a lap step its notes name.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Literal

from arete.data.exercises_catalog import EXERCISES_BY_ID
from arete.features.hybrid_plan import (
    BENCHMARK,
    HEAVY_LOWER,
    KEPT,
    STATION,
    STATIONS,
    UPPER,
    Division,
    Level,
    Station,
    station_effort,
)
from arete.features.plan_generator import DraftSession, WeekPlan
from arete.services.prescriptions import Prescription
from arete.strength.progression import increment, round_load

if TYPE_CHECKING:
    from arete.strength.models import Exercise
    from arete.strength.repository import StrengthRepository

Category = Literal["men", "women", "mixed"]

#: Share of the current load a deload or taper week lifts.
LIGHT_SHARE = 0.9
STATION_REST_SEC = 60
ROUND_REST_SEC = 120


@dataclass(frozen=True)
class Lift:
    """One exercise of a strength session: ``sets`` × ``amount``."""

    exercise: str  # catalog id
    sets: int
    amount: int  # reps, or seconds when ``timed``
    rest_sec: int
    rir: int | None = None  # reps in reserve, said in the notes
    timed: bool = False
    per_leg: bool = False


#: Lower body: squat, Romanian deadlift, lunges, as the session's title says.
LOWER: dict[Level, tuple[Lift, ...]] = {
    "novice": (
        Lift("back_squat", 3, 8, 120, rir=3),
        Lift("rdl", 3, 10, 90, rir=3),
        Lift("lunges", 2, 10, 90, rir=3, per_leg=True),
    ),
    "intermediate": (
        Lift("back_squat", 4, 6, 150, rir=2),
        Lift("rdl", 3, 8, 120, rir=2),
        Lift("lunges", 3, 10, 90, rir=2, per_leg=True),
    ),
    "advanced": (
        Lift("back_squat", 5, 5, 180, rir=2),
        Lift("rdl", 4, 6, 150, rir=2),
        Lift("lunges", 3, 12, 90, rir=1, per_leg=True),
    ),
}
#: Upper body and core: a press, a pull and a timed plank.
UPPER_BODY: dict[Level, tuple[Lift, ...]] = {
    "novice": (
        Lift("bench_press", 3, 10, 90, rir=3),
        Lift("dumbbell_row", 3, 10, 90, rir=3),
        Lift("plank", 3, 30, 45, timed=True),
    ),
    "intermediate": (
        Lift("bench_press", 4, 8, 120, rir=2),
        Lift("pull_ups", 4, 6, 120, rir=2),
        Lift("plank", 3, 45, 45, timed=True),
    ),
    "advanced": (
        Lift("bench_press", 4, 6, 150, rir=2),
        Lift("pull_ups", 4, 8, 120, rir=1),
        Lift("plank", 3, 60, 45, timed=True),
    ),
}


@dataclass(frozen=True)
class StationLoads:
    sled_push: float  # kg, sled included
    sled_pull: float  # kg, sled included
    farmers_carry: float  # kg per hand
    sandbag_lunges: float
    wall_ball: float


_WOMEN = StationLoads(102, 78, 16, 10, 4)
_MEN = StationLoads(152, 103, 24, 20, 6)
_MEN_PRO = StationLoads(202, 153, 32, 30, 9)
#: Official HYROX loads: HYROX Single Rulebook, season 2025/26 (R1), section
#: 9 "Movement standards, distances and weights": sled push 102 / 152 / 202 kg
#: and sled pull 78 / 103 / 153 kg, sled included; farmers carry 2 × 16 / 24 /
#: 32 kg; sandbag lunges 10 / 20 / 30 kg; wall balls 4 / 6 / 9 kg, for Women /
#: Women Pro and Men / Men Pro. Mixed doubles race the Men (Open) loads and
#: have no Pro division (published division guides; the singles rulebook
#: does not state it).
OFFICIAL_LOADS: dict[tuple[Division, Category], StationLoads] = {
    ("open", "women"): _WOMEN,
    ("open", "men"): _MEN,
    ("pro", "women"): _MEN,
    ("pro", "men"): _MEN_PRO,
    ("open", "mixed"): _MEN,
    ("pro", "mixed"): _MEN,
}


def station_loads(division: Division, category: Category | None) -> StationLoads | None:
    """The race's station loads; None when the goal has no category."""
    return OFFICIAL_LOADS[(division, category)] if category else None


@dataclass(frozen=True)
class Dose:
    """One station's work in a circuit: an exercise for ``reps`` or
    ``seconds``, or, with neither, a manual-lap step ``label`` describes."""

    label: str  # French: the description and the lap step's notes
    exercise: str = ""  # what the strength log reads (French)
    garmin: str = ""  # catalog English name or exact Garmin name
    reps: int | None = None
    seconds: int | None = None
    load: str | None = None  # a ``StationLoads`` field


_BURPEES = Dose("20 burpees", "Burpees", "Burpee", reps=20)
_JUMP_SQUATS = Dose("20 squats sautés", "Squats sautés", "Jump Squat", reps=20)
#: A training circuit's work per station, ``STATIONS`` ids. Sleds, carry and
#: rower work for a time at the race load (a Garmin strength step cannot end
#: on a distance); reps stations keep their reps.
CIRCUIT: dict[str, Dose] = {
    "ski_erg": Dose("SkiErg 500 m"),
    "sled_push": Dose(
        "poussée de traîneau 1'",
        "Poussée de traîneau",
        "Sled Push",
        seconds=60,
        load="sled_push",
    ),
    "sled_pull": Dose(
        "tirage de traîneau 1'",
        "Tirage de traîneau",
        "Sled Pull",
        seconds=60,
        load="sled_pull",
    ),
    "burpee_broad_jump": Dose("20 burpees broad jumps"),
    "rower": Dose("rameur 2'", "Rameur", "Rowing Ergometer", seconds=120),
    "farmers_carry": Dose(
        "farmers carry 1'",
        "Marche du fermier",
        "Farmer Carry",
        seconds=60,
        load="farmers_carry",
    ),
    "sandbag_lunges": Dose(
        "20 fentes avec sac de sable",
        "Fentes avec sac de sable",
        "Sandbag Lunge",
        reps=20,
        load="sandbag_lunges",
    ),
    "wall_ball": Dose(
        "20 wall balls", "Wall ball", "Wall Ball", reps=20, load="wall_ball"
    ),
}
#: The same work without the station's equipment (``Station.equipment``).
FALLBACKS: dict[str, Dose] = {
    "ski_erg": _BURPEES,
    "sled_push": Dose(
        "20 fentes marchées", "Fentes marchées", "Walking Lunge", reps=20
    ),
    "sled_pull": _JUMP_SQUATS,
    "rower": _BURPEES,
    "wall_ball": _JUMP_SQUATS,
}
_STATIONS = {s.id: s for s in STATIONS}


@dataclass(frozen=True)
class Start:
    """An exercise's next load from the athlete's history."""

    weight_kg: float
    lower_body: bool


def _lifts() -> list[str]:
    return sorted(
        {
            lift.exercise
            for table in (LOWER, UPPER_BODY)
            for lifts in table.values()
            for lift in lifts
        }
    )


def starting_loads(repo: StrengthRepository | None = None) -> dict[str, Start]:
    """The load each template exercise starts at: the next session's
    (``suggest_next``, without today's readiness: the sessions are ahead),
    for the exercises the athlete logged with a load."""
    from arete.services.strength_progress import is_lower_body, suggestion_for
    from arete.strength.repository import StrengthRepository

    repo = repo or StrengthRepository()
    found: dict[str, tuple[int, Exercise]] = {}
    for cid in _lifts():
        exercise = repo.get_exercise_by_catalog_id(cid)
        if exercise is not None and exercise.id is not None:
            found[cid] = (exercise.id, exercise)
    history = repo.working_sessions([i for i, _ in found.values()])
    out: dict[str, Start] = {}
    for cid, (identifier, exercise) in found.items():
        suggestion = suggestion_for(exercise, history.get(identifier, []), None)
        if suggestion is not None and suggestion.weight_kg is not None:
            out[cid] = Start(suggestion.weight_kg, is_lower_body(exercise))
    return out


def _lighter(load: float) -> float:
    return min(round_load(load * LIGHT_SHARE), load)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'s' if n > 1 else ''}"


def _lift_steps(lift: Lift, weight: float | None) -> list[dict[str, Any]]:
    entry = EXERCISES_BY_ID[lift.exercise]
    notes = []
    if lift.per_leg:
        notes.append("par jambe")
    if lift.rir is not None:
        notes.append(
            f"RIR {lift.rir} : garde {_plural(lift.rir, 'répétition')} en réserve"
        )
    if weight is None and entry["equipment"] != ["bodyweight"]:
        notes.append("charge à choisir : aucune série enregistrée")
    effort = {
        "kind": "effort",
        "duration_kind": "seconds" if lift.timed else "reps",
        "value": lift.amount,
        "exercise": entry["name_fr"],
        "garmin_exercise": entry["name"],
        "weight_kg": weight,
        "notes": " ; ".join(notes),
    }
    rest = {"kind": "rest", "duration_kind": "seconds", "value": lift.rest_sec}
    return [step for _ in range(lift.sets) for step in (effort, rest)]


def strength_prescription(
    lifts: Sequence[Lift], loads: Mapping[str, float]
) -> dict[str, Any]:
    """Each lift's sets with a rest after each, but the session's last."""
    steps = [s for lift in lifts for s in _lift_steps(lift, loads.get(lift.exercise))]
    return _valid({"version": 1, "steps": steps[:-1]})


def _valid(prescription: dict[str, Any]) -> dict[str, Any]:
    return Prescription.model_validate(prescription).model_dump(mode="json")


def circuit_dose(station: Station, equipment: frozenset[str]) -> Dose:
    """The station's circuit work, or its fallback without the equipment."""
    if station.equipment is None or station.equipment in equipment:
        return CIRCUIT[station.id]
    return FALLBACKS[station.id]


def _load_text(dose: Dose, loads: StationLoads | None) -> str:
    if dose.load is None:
        return ""
    if loads is None:
        return " (charge de ta catégorie)"
    kg = getattr(loads, dose.load)
    return f" à 2 × {kg:g} kg" if dose.load == "farmers_carry" else f" à {kg:g} kg"


def _station_step(dose: Dose, loads: StationLoads | None) -> dict[str, Any]:
    if dose.reps is None and dose.seconds is None:
        return {"kind": "effort", "duration_kind": "lap", "notes": dose.label}
    weight = getattr(loads, dose.load) if loads and dose.load else None
    notes = dose.label + _load_text(dose, loads)
    if dose.load == "farmers_carry" and weight is not None:
        notes += " : la charge est celle de chaque main"
    return {
        "kind": "effort",
        "duration_kind": "reps" if dose.reps is not None else "seconds",
        "value": dose.reps if dose.reps is not None else dose.seconds,
        "exercise": dose.exercise,
        "garmin_exercise": dose.garmin,
        "weight_kg": weight,
        "notes": notes,
    }


def circuit(
    draft: DraftSession,
    *,
    rounds: int,
    equipment: frozenset[str],
    loads: StationLoads | None,
) -> DraftSession:
    """A training circuit: ``rounds`` × the week's stations, rests between
    them; its description says the same work as its steps."""
    stations = [_STATIONS[i] for i in draft.stations]
    generated = "Circuit stations : " + ", ".join(
        station_effort(s, equipment) for s in stations
    )
    assert draft.description.startswith(generated), draft.description
    doses = [circuit_dose(s, equipment) for s in stations]
    children: list[dict[str, Any]] = []
    for k, dose in enumerate(doses):
        last = k == len(doses) - 1
        children.append(_station_step(dose, loads))
        children.append(
            {
                "kind": "rest",
                "duration_kind": "seconds",
                "value": ROUND_REST_SEC if last else STATION_REST_SEC,
            }
        )
    prescription = {
        "version": 1,
        "steps": [
            {
                "kind": "warmup",
                "duration_kind": "lap",
                "notes": "Échauffement : 10' de cardio facile et de mobilité",
            },
            {"kind": "repeat", "repeat": rounds, "steps": children},
            {
                "kind": "cooldown",
                "duration_kind": "lap",
                "notes": "Retour au calme : 5' facile",
            },
        ],
    }
    description = (
        f"Circuit stations, {rounds} tours : "
        + ", ".join(d.label + _load_text(d, loads) for d in doses)
        + " ; récup 1' entre les stations, 2' entre les tours"
        + draft.description[len(generated) :]
    )
    return replace(draft, description=description, prescription=_valid(prescription))


def benchmark(
    draft: DraftSession, *, equipment: frozenset[str], loads: StationLoads | None
) -> DraftSession:
    """The end-of-block test: each 1 km, then its station, against the clock.
    Fixed work: a reps station whose circuit work is the generated one is an
    exercise step; any distance is a lap step its notes describe."""
    steps: list[dict[str, Any]] = [
        {
            "kind": "warmup",
            "duration_kind": "lap",
            "notes": "Échauffement : 10' de footing et de mobilité",
        }
    ]
    for station_id in draft.stations:
        station = _STATIONS[station_id]
        effort = station_effort(station, equipment)
        dose = circuit_dose(station, equipment)
        steps.append(
            {"kind": "effort", "duration_kind": "lap", "notes": "1 km de course"}
        )
        if dose.reps is not None and dose.label == effort:
            steps.append(_station_step(dose, loads))
        else:
            steps.append(
                {
                    "kind": "effort",
                    "duration_kind": "lap",
                    "notes": effort + _load_text(dose, loads),
                }
            )
    steps.append(
        {
            "kind": "cooldown",
            "duration_kind": "lap",
            "notes": "Retour au calme : 10' facile",
        }
    )
    return replace(draft, prescription=_valid({"version": 1, "steps": steps}))


def prescribe(
    weeks: Sequence[WeekPlan],
    *,
    level: Level,
    division: Division,
    category: Category | None,
    equipment: frozenset[str],
    starts: Mapping[str, Start],
) -> list[WeekPlan]:
    """The weeks with their strength sessions' and circuits' steps; the
    athlete's kept sessions stay as they are. Loads rise one increment per
    loading week after the first; a deload or taper week lifts
    ``LIGHT_SHARE`` of the current load."""
    current = {cid: s.weight_kg for cid, s in starts.items()}
    stations = station_loads(division, category)
    loading = 0
    out: list[WeekPlan] = []
    for week in weeks:
        light = week.recovery or week.phase in ("taper", "race")
        if not light:
            if loading:
                current = {
                    cid: round_load(kg + increment(kg, starts[cid].lower_body))
                    for cid, kg in current.items()
                }
            loading += 1
        loads = {cid: _lighter(kg) for cid, kg in current.items()} if light else current
        rounds = 2 if light else 3 + (division == "pro")
        sessions = []
        for draft in week.sessions:
            if KEPT in draft.tags:
                sessions.append(draft)
            elif HEAVY_LOWER in draft.tags:
                sessions.append(
                    replace(
                        draft, prescription=strength_prescription(LOWER[level], loads)
                    )
                )
            elif UPPER in draft.tags:
                sessions.append(
                    replace(
                        draft,
                        prescription=strength_prescription(UPPER_BODY[level], loads),
                    )
                )
            elif BENCHMARK in draft.tags:
                sessions.append(benchmark(draft, equipment=equipment, loads=stations))
            elif STATION in draft.tags:
                sessions.append(
                    circuit(draft, rounds=rounds, equipment=equipment, loads=stations)
                )
            else:
                sessions.append(draft)
        out.append(replace(week, sessions=sessions))
    return out
