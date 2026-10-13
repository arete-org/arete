"""Deterministic prescription conversion. Never silently weaken a workout."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from arete.garmin.workout_structure import Block, Repeat, estimated_seconds
from arete.garmin.workout_structure import Step as LegacyStep

if TYPE_CHECKING:
    from datetime import date

    from arete.garmin.client import GarminClient

from arete.services.prescriptions import Prescription, Step, Target

# Exact catalog equivalents only: fuzzy substitutions can change the exercise.
_STRENGTH_NAMES = {
    "Back Squat": "Barbell Back Squat",
    "Lunges": "Lunge",
    "Calf Raises": "Calf Raise",
    "Leg Extension": "Leg Extensions",
}


def _target(target: Target, hr_ranges: list[tuple[int, int | None]] | None) -> dict:
    kind = target.kind
    low, high = target.low, target.high
    if kind == "hr_zone":
        if not hr_ranges:
            raise ValueError(
                "Configure un seuil ou une FC maximale mesurée avant d’exporter une zone FC."
            )
        low, upper = hr_ranges[int(low) - 1]
        if upper is None or low == 0:
            raise ValueError(
                "Une zone ouverte exige des bornes FC explicites pour Garmin."
            )
        high = upper
        kind = "heart_rate_bpm"
    ids = {
        "pace_sec_km": (6, "pace.zone"),
        "heart_rate_bpm": (4, "heart.rate.zone"),
        "power_w": (2, "power.zone"),
        "cadence_rpm": (3, "cadence"),
    }
    identifier, key = ids[kind]
    if kind == "pace_sec_km":
        low, high = 1000 / high, 1000 / low
    return {
        "targetType": {"workoutTargetTypeId": identifier, "workoutTargetTypeKey": key},
        "targetValueOne": low,
        "targetValueTwo": high,
    }


def convert(
    session_id: int,
    name: str,
    sport: str,
    prescription: Prescription,
    *,
    hr_ranges: list[tuple[int, int | None]] | None = None,
) -> dict[str, Any]:
    from garminconnect import workout as w
    from garminconnect.exercises import resolve

    classes = {
        "running": w.RunningWorkout,
        "cycling": w.CyclingWorkout,
        "swimming": w.SwimmingWorkout,
        "strength": w.StrengthWorkout,
        "walking": w.WalkingWorkout,
        "hiking": w.HikingWorkout,
    }
    if sport not in classes:
        raise ValueError(f"Sport non exportable : {sport}.")
    if sport == "swimming" and not prescription.pool_length_m:
        raise ValueError("Longueur du bassin requise.")
    if sport != "swimming" and prescription.pool_length_m is not None:
        raise ValueError("La longueur du bassin ne s’applique qu’à la natation.")
    sport_type = classes[sport].model_fields["sportType"].default_factory()
    order = 0

    def steps(items: list[Step]) -> list[dict]:
        nonlocal order
        result = []
        for step in items:
            order += 1
            index = order
            if step.kind == "repeat":
                group = w.create_repeat_group(
                    step.repeat, steps(step.steps), index
                ).model_dump(exclude_none=True)
                if step.notes:
                    group["description"] = step.notes
                # Unset stays absent: an older copy on Garmin still matches.
                if step.skip_last_recovery is not None:
                    group["skipLastRestStep"] = step.skip_last_recovery
                result.append(group)
                continue
            if (
                step.exercise
                or step.garmin_exercise
                or step.weight_kg is not None
                or step.duration_kind == "reps"
            ) and sport != "strength":
                raise ValueError(
                    "Exercices et charges ne sont exportables qu’en musculation."
                )
            if step.stroke and sport != "swimming":
                raise ValueError("Le type de nage ne s’applique qu’à la natation.")
            if (
                sport == "strength"
                and step.kind in {"rest", "recovery"}
                and (
                    step.exercise
                    or step.garmin_exercise
                    or step.weight_kg is not None
                    or step.duration_kind == "reps"
                )
            ):
                raise ValueError(
                    "Un repos de musculation ne peut pas masquer un exercice ou une charge."
                )
            if sport == "strength" and step.kind not in {"rest", "recovery"}:
                name = step.garmin_exercise or step.exercise
                entry = resolve(_STRENGTH_NAMES.get(name, name))
                if not entry or step.duration_kind != "reps":
                    raise ValueError(
                        f"Choisis un exercice Garmin exact et un nombre de répétitions pour « {step.exercise} »."
                    )
                item = w.create_strength_exercise_step(
                    entry["category"],
                    step_order=index,
                    reps=int(step.value or 0),
                    exercise_name=entry["exercise"],
                    weight_kg=step.weight_kg,
                ).model_dump(exclude_none=True)
                if step.kind != "effort":
                    identifier = 1 if step.kind == "warmup" else 2
                    item["stepType"] = {
                        "stepTypeId": identifier,
                        "stepTypeKey": step.kind,
                    }
            else:
                kinds = {
                    "warmup": (1, "warmup"),
                    "effort": (3, "interval"),
                    "recovery": (4, "recovery"),
                    "cooldown": (2, "cooldown"),
                    "rest": (5, "rest"),
                }
                conditions = {
                    "seconds": (2, "time"),
                    "meters": (3, "distance"),
                    "lap": (1, "lap.button"),
                    "reps": (10, "reps"),
                }
                k, label = kinds[step.kind]
                if sport == "swimming" and step.kind in {"effort", "recovery"}:
                    if step.kind == "recovery":
                        raise ValueError(
                            "En natation, précise un repos ou une étape de nage avec son objectif de récupération dans les notes."
                        )
                    k, label = 8, "main"
                c, condition = conditions[step.duration_kind]
                item = {
                    "type": "ExecutableStepDTO",
                    "stepOrder": index,
                    "stepType": {"stepTypeId": k, "stepTypeKey": label},
                    "endCondition": {
                        "conditionTypeId": c,
                        "conditionTypeKey": condition,
                    },
                    "targetType": {
                        "workoutTargetTypeId": 1,
                        "workoutTargetTypeKey": "no.target",
                    },
                }
                if step.value is not None:
                    item["endConditionValue"] = step.value
            for secondary, target in (
                (False, step.target),
                (True, step.secondary_target),
            ):
                if target:
                    if sport in {"strength", "swimming"} or (
                        target.kind == "power_w" and sport != "cycling"
                    ):
                        raise ValueError(
                            f"Cible {target.kind} non prise en charge pour {sport}."
                        )
                    converted = _target(target, hr_ranges)
                    item.update(
                        {
                            (
                                "secondary" + key[0].upper() + key[1:]
                                if secondary
                                else key
                            ): value
                            for key, value in converted.items()
                        }
                    )
            if sport == "swimming":
                if step.duration_kind == "meters" and (step.value or 0) % (
                    prescription.pool_length_m or 1
                ):
                    raise ValueError(
                        "La distance doit être un multiple de la longueur du bassin."
                    )
                if step.stroke:
                    strokes = {
                        "free": (6, "free"),
                        "back": (2, "backstroke"),
                        "breast": (3, "breaststroke"),
                        "butterfly": (5, "fly"),
                    }
                    if step.stroke not in strokes:
                        raise ValueError(
                            "Nage mixte non représentable sans détailler l’ordre et la distance de chaque nage."
                        )
                    identifier, key = strokes[step.stroke]
                    item["strokeType"] = {
                        "strokeTypeId": identifier,
                        "strokeTypeKey": key,
                    }
            if step.notes:
                item["description"] = step.notes
            result.append(item)
        return result

    # Display order is presentation metadata, not part of the workout contract.
    sport_type = {k: v for k, v in sport_type.items() if k != "displayOrder"}
    payload = {
        "workoutName": name,
        "description": f"ARETE_SESSION:{session_id}",
        "sportType": sport_type,
        "estimatedDurationInSecs": 0,
        "workoutSegments": [
            {
                "segmentOrder": 1,
                "sportType": sport_type,
                "workoutSteps": steps(prescription.steps),
            }
        ],
    }
    if sport == "swimming":
        payload["poolLength"] = prescription.pool_length_m
        payload["poolLengthUnit"] = {"unitKey": "meter"}
    return payload


def canonical(value: Any) -> Any:
    """Compare semantic fields; Garmin adds IDs, defaults and display metadata."""
    ignored = {
        "workoutId",
        "ownerId",
        "author",
        "createdDate",
        "updatedDate",
        "estimatedDurationInSecs",
        "displayOrder",
        "displayable",
        "stepId",
        "childStepId",
        "workoutSegmentId",
        "segmentId",
        "isWheelchair",
        "shared",
        "consumer",
        "atpPlanId",
        "workoutProvider",
        "workoutSourceId",
        "accessControlRule",
        "avgTrainingSpeed",
        "estimateType",
        "estimatedDistanceInMeters",
        "estimatedDistanceUnit",
        "updatedDateTime",
        "createdDateTime",
        "isSessionTransitionEnabled",
        "trainingPlanId",
    }
    if isinstance(value, dict):
        return {
            k: canonical(v)
            for k, v in value.items()
            if k not in ignored and v is not None
        }
    if isinstance(value, list):
        return [canonical(v) for v in value]
    return value


def matches(expected: Any, actual: Any) -> bool:
    """Verify every requested field; Garmin may return extra computed fields."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            k in actual and matches(v, actual[k])
            for k, v in expected.items()
            if k != "estimatedDurationInSecs"
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(expected) == len(actual)
            and all(matches(a, b) for a, b in zip(expected, actual, strict=True))
        )
    if isinstance(expected, float | int) and isinstance(actual, float | int):
        return abs(expected - actual) < 0.00001
    return bool(expected == actual)


# Existing derivation applies only to sessions without a document prescription.
SPORT_TYPES: dict[str, dict[str, Any]] = {
    "running": {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1},
    "cycling": {"sportTypeId": 2, "sportTypeKey": "cycling", "displayOrder": 2},
}
STEP_TYPES: dict[str, dict[str, Any]] = {
    "warmup": {"stepTypeId": 1, "stepTypeKey": "warmup", "displayOrder": 1},
    "cooldown": {"stepTypeId": 2, "stepTypeKey": "cooldown", "displayOrder": 2},
    "interval": {"stepTypeId": 3, "stepTypeKey": "interval", "displayOrder": 3},
    "recovery": {"stepTypeId": 4, "stepTypeKey": "recovery", "displayOrder": 4},
    "repeat": {"stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6},
}
END_CONDITIONS: dict[str, dict[str, Any]] = {
    "time": {"conditionTypeId": 2, "conditionTypeKey": "time", "displayOrder": 2},
    "distance": {
        "conditionTypeId": 3,
        "conditionTypeKey": "distance",
        "displayOrder": 3,
    },
    "iterations": {
        "conditionTypeId": 7,
        "conditionTypeKey": "iterations",
        "displayOrder": 7,
    },
}
TARGET_TYPES: dict[str, dict[str, Any]] = {
    "none": {
        "workoutTargetTypeId": 1,
        "workoutTargetTypeKey": "no.target",
        "displayOrder": 1,
    },
    "heart_rate": {
        "workoutTargetTypeId": 4,
        "workoutTargetTypeKey": "heart.rate.zone",
        "displayOrder": 4,
    },
    "pace": {
        "workoutTargetTypeId": 6,
        "workoutTargetTypeKey": "pace.zone",
        "displayOrder": 6,
    },
}


def _speed(sec_per_km: int) -> float:
    """Garmin's pace targets are speeds, in metres per second."""
    return round(1000 / sec_per_km, 3)


def _executable(step: LegacyStep, order: int) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "ExecutableStepDTO",
        "stepOrder": order,
        "stepType": STEP_TYPES[step.kind],
    }
    if step.distance_m:
        payload["endCondition"] = END_CONDITIONS["distance"]
        payload["endConditionValue"] = float(step.distance_m)
    else:
        payload["endCondition"] = END_CONDITIONS["time"]
        payload["endConditionValue"] = float(step.duration_sec or 0)
    if step.hr_low is not None and step.hr_high is not None:
        payload["targetType"] = TARGET_TYPES["heart_rate"]
        payload["targetValueOne"] = step.hr_low
        payload["targetValueTwo"] = step.hr_high
    elif step.pace_fast_sec_km and step.pace_slow_sec_km:
        payload["targetType"] = TARGET_TYPES["pace"]
        payload["targetValueOne"] = _speed(step.pace_slow_sec_km)
        payload["targetValueTwo"] = _speed(step.pace_fast_sec_km)
    else:
        payload["targetType"] = TARGET_TYPES["none"]
    return payload


def _steps(
    blocks: tuple[Block, ...] | tuple[LegacyStep, ...], start: int
) -> tuple[list, int]:
    """Payload steps, numbered depth-first as Garmin numbers them."""
    out: list[dict[str, Any]] = []
    order = start
    for block in blocks:
        if isinstance(block, Repeat):
            group_order = order
            inner, order = _steps(block.steps, order + 1)
            out.append(
                {
                    "type": "RepeatGroupDTO",
                    "stepOrder": group_order,
                    "stepType": STEP_TYPES["repeat"],
                    "numberOfIterations": block.iterations,
                    "smartRepeat": False,
                    "endCondition": END_CONDITIONS["iterations"],
                    "endConditionValue": float(block.iterations),
                    "workoutSteps": inner,
                }
            )
        else:
            out.append(_executable(block, order))
            order += 1
    return out, order


def build_payload(
    blocks: tuple[Block, ...], *, name: str, description: str, sport: str
) -> dict[str, Any]:
    """The workout as Garmin's ``POST /workout-service/workout`` expects it."""
    sport_type = SPORT_TYPES[sport]
    steps, _ = _steps(blocks, 1)
    return {
        "workoutName": name[:80],
        "description": description[:500],
        "sportType": sport_type,
        "estimatedDurationInSecs": estimated_seconds(blocks),
        "workoutSegments": [
            {"segmentOrder": 1, "sportType": sport_type, "workoutSteps": steps}
        ],
    }


def upload_and_schedule(
    client: GarminClient, payload: dict[str, Any], day: date
) -> tuple[str, str | None]:
    """Create the workout and put it on ``day``: (workout id, schedule id)."""
    created = client.upload_workout(payload)
    workout_id = str(created["workoutId"])
    scheduled = client.schedule_workout(workout_id, day)
    schedule_id = (
        scheduled.get("workoutScheduleId") if isinstance(scheduled, dict) else None
    )
    return workout_id, str(schedule_id) if schedule_id is not None else None


def remove(
    client: GarminClient, workout_id: str | None, schedule_id: str | None
) -> None:
    """Take an earlier copy off the calendar and delete it; gone already is fine."""
    for action, value in (
        (client.unschedule_workout, schedule_id),
        (client.delete_workout, workout_id),
    ):
        if value is None:
            continue
        try:
            action(value)
        except Exception as e:  # noqa: BLE001 - a missing copy is not an error
            if "404" not in str(e):
                raise
