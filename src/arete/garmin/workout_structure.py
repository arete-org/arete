"""A planned session as watch steps: warm-up, blocks, repeats, cool-down.

Derived from the session type, its duration and the athlete's own zones, so a
planned "tempo 50 min Z4" becomes 10' Z2 + 30' Z4 + 10' Z1 with bpm ranges the
watch can show. An explicit ``structure_json`` on the session wins over the
derivation. Pure: no I/O, no Garmin types (``garmin/workouts.py`` adapts these
steps to Garmin's payload).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Literal

from arete.features.hr_zones import ZoneModel
from arete.garmin.models import PlannedSession

StepKind = Literal["warmup", "interval", "recovery", "cooldown"]

#: Sports a structured workout is sent for (Garmin's running and cycling).
PUSHABLE_SPORTS = frozenset({"running", "cycling"})
_NOT_STRUCTURED = frozenset(
    {"strength", "hypertrophy", "power", "deload", "cross_training", "other"}
)
#: Types ``derive`` fills with a generic template (warm-up, fixed blocks,
#: cool-down) that ignores whatever the session's description prescribes.
TEMPLATE_TYPES = frozenset({"tempo", "intervals"})
RACE_PACE_MARGIN_SEC = 10
INTERVAL_WORK_SEC = 180
INTERVAL_REST_SEC = 120


@dataclass(frozen=True)
class Step:
    kind: StepKind
    duration_sec: int | None = None
    distance_m: int | None = None
    zone: int | None = None  # 1-5, what the step is described as
    hr_low: int | None = None
    hr_high: int | None = None
    pace_fast_sec_km: int | None = None
    pace_slow_sec_km: int | None = None


@dataclass(frozen=True)
class Repeat:
    iterations: int
    steps: tuple[Step, ...] = field(default_factory=tuple)


Block = Step | Repeat


class NotPushable(ValueError):
    """The session has no structure a watch can follow; the message says why."""


def _hr_step(kind: StepKind, minutes: float, zone: int, zones: ZoneModel) -> Step:
    low, high = zones.target_range(zone)
    return Step(
        kind=kind,
        duration_sec=int(round(minutes * 60)),
        zone=zone,
        hr_low=low,
        hr_high=high,
    )


def _zone_number(target: str | None, default: int) -> int:
    if (
        target
        and len(target) == 2
        and target[0].upper() == "Z"
        and target[1] in "12345"
    ):
        return int(target[1])
    return default


def needs_explicit_steps(sport: str, session_type: str) -> bool:
    """Whether only explicit steps, not the type's template, can describe it."""
    return sport in PUSHABLE_SPORTS and session_type in TEMPLATE_TYPES


def ensure_template_fits(session: PlannedSession) -> None:
    """Raise ``NotPushable`` when the template would contradict the description.

    A described tempo or interval session without explicit steps would reach
    the watch as the type's generic template, not the workout the coach wrote.
    A running description the grammar reads entirely counts as explicit steps
    (``garmin_export.described_prescription`` exports them).
    """
    from arete.services.prescriptions import prescription_from_description

    if (
        not session.prescription
        and not session.structure_json
        and (session.description or "").strip()
        and needs_explicit_steps(session.sport, session.session_type.value)
        and prescription_from_description(session.description or "", session.sport)
        is None
    ):
        raise NotPushable(
            "Séance décrite sans étapes : le modèle générique du type de séance "
            "ne reprend pas la description. Complète les étapes pour l’export "
            "Garmin (coach : set_session_prescription)."
        )


def derive(
    session: PlannedSession,
    zones: ZoneModel,
    threshold_pace_sec_km: int | None = None,
) -> tuple[Block, ...]:
    """The session's steps; raises ``NotPushable`` with a French reason."""
    if session.structure_json:
        return from_json(session.structure_json)
    if session.sport == "strength":
        raise NotPushable(
            "Ajoute les exercices et séries de musculation pour exporter cette séance vers Garmin."
        )
    if session.sport not in PUSHABLE_SPORTS:
        raise NotPushable(
            "Ce sport exige une prescription explicite pour l’export Garmin."
        )
    kind = session.session_type.value
    if kind in _NOT_STRUCTURED:
        raise NotPushable("Ce type de séance n'a pas de structure pour la montre.")
    minutes = session.target_duration_min

    if kind == "race":
        if session.target_distance_km:
            distance = int(round(session.target_distance_km * 1000))
            if threshold_pace_sec_km:
                return (
                    Step(
                        kind="interval",
                        distance_m=distance,
                        pace_fast_sec_km=threshold_pace_sec_km - RACE_PACE_MARGIN_SEC,
                        pace_slow_sec_km=threshold_pace_sec_km + RACE_PACE_MARGIN_SEC,
                    ),
                )
            return (Step(kind="interval", distance_m=distance),)
        if not minutes:
            raise NotPushable("Course sans distance ni durée prévue.")
        return (Step(kind="interval", duration_sec=minutes * 60),)

    if not minutes:
        raise NotPushable("Séance sans durée prévue.")

    if kind in ("recovery", "endurance", "long_run"):
        default = 1 if kind == "recovery" else 2
        zone = _zone_number(session.target_hr_zone, default)
        return (_hr_step("interval", minutes, zone, zones),)

    edge = 10 if minutes >= 40 else 5
    main = minutes - 2 * edge
    if main <= 0:
        raise NotPushable(
            "Durée trop courte pour un échauffement et un retour au calme."
        )
    warmup = _hr_step("warmup", edge, 2, zones)
    cooldown = _hr_step("cooldown", edge, 1, zones)

    if kind == "tempo":
        zone = _zone_number(session.target_hr_zone, 4)
        return (warmup, _hr_step("interval", main, zone, zones), cooldown)

    # intervals: 3' hard / 2' easy, as many as the main block holds
    zone = _zone_number(session.target_hr_zone, 5)
    reps = max(1, int(main * 60) // (INTERVAL_WORK_SEC + INTERVAL_REST_SEC))
    work = _hr_step("interval", INTERVAL_WORK_SEC / 60, zone, zones)
    rest = _hr_step("recovery", INTERVAL_REST_SEC / 60, 1, zones)
    return (warmup, Repeat(iterations=reps, steps=(work, rest)), cooldown)


def estimated_seconds(blocks: tuple[Block, ...]) -> int:
    total = 0
    for block in blocks:
        if isinstance(block, Repeat):
            total += block.iterations * estimated_seconds(block.steps)
        elif block.duration_sec:
            total += block.duration_sec
        elif block.distance_m and block.pace_slow_sec_km:
            total += int(block.distance_m / 1000 * block.pace_slow_sec_km)
    return total


def _step_fr(step: Step) -> str:
    if step.distance_m:
        amount = f"{step.distance_m / 1000:g} km"
    else:
        minutes = (step.duration_sec or 0) / 60
        amount = f"{minutes:g}'"
    if step.zone:
        return f"{amount} Z{step.zone}"
    if step.pace_fast_sec_km:
        pace = step.pace_fast_sec_km + RACE_PACE_MARGIN_SEC
        return f"{amount} à {pace // 60}:{pace % 60:02d}/km"
    return amount


def describe_fr(blocks: tuple[Block, ...]) -> str:
    """ "10' Z2 · 4×(3' Z5 / 2' Z1) · 10' Z1"."""
    parts = []
    for block in blocks:
        if isinstance(block, Repeat):
            inner = " / ".join(_step_fr(s) for s in block.steps)
            parts.append(f"{block.iterations}×({inner})")
        else:
            parts.append(_step_fr(block))
    return " · ".join(parts)


def to_json(blocks: tuple[Block, ...]) -> str:
    def encode(block: Block) -> dict:
        if isinstance(block, Repeat):
            return {
                "repeat": block.iterations,
                "steps": [asdict(s) for s in block.steps],
            }
        return asdict(block)

    return json.dumps([encode(b) for b in blocks])


def from_json(raw: str) -> tuple[Block, ...]:
    def decode(item: dict) -> Block:
        if "repeat" in item:
            return Repeat(
                iterations=int(item["repeat"]),
                steps=tuple(Step(**s) for s in item["steps"]),
            )
        return Step(**item)

    try:
        return tuple(decode(item) for item in json.loads(raw))
    except (TypeError, ValueError, KeyError) as e:
        raise NotPushable("Structure de séance illisible.") from e
