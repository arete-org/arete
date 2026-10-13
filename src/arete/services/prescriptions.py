"""Provider-independent workout prescriptions and their validation."""

from __future__ import annotations

from datetime import date as Date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

MAX_STEPS = 100
MAX_REPEAT_DEPTH = 2
MAX_EXPANDED_STEPS = 1000


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Target(StrictModel):
    kind: Literal["pace_sec_km", "heart_rate_bpm", "power_w", "cadence_rpm", "hr_zone"]
    low: float = Field(gt=0, le=10000)
    high: float = Field(gt=0, le=10000)

    @model_validator(mode="after")
    def ordered(self):
        if self.low > self.high:
            raise ValueError("La borne basse doit précéder la borne haute.")
        if self.kind == "hr_zone" and (
            self.low != self.high or self.low not in range(1, 6)
        ):
            raise ValueError("La zone FC doit être un entier entre 1 et 5.")
        return self


class Step(StrictModel):
    kind: Literal["warmup", "effort", "recovery", "cooldown", "rest", "repeat"]
    duration_kind: Literal["seconds", "meters", "reps", "lap"] = "lap"
    value: float | None = Field(default=None, gt=0, le=1_000_000)
    target: Target | None = None
    secondary_target: Target | None = None
    repeat: int | None = Field(default=None, ge=2, le=100)
    steps: list[Step] = Field(default_factory=list, max_length=MAX_STEPS)
    exercise: str = Field(default="", max_length=120)
    garmin_exercise: str = Field(default="", max_length=120)
    weight_kg: float | None = Field(default=None, ge=0, le=1000)
    stroke: Literal["free", "back", "breast", "butterfly", "mixed"] | None = None
    notes: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def consistent(self):
        if self.kind == "repeat":
            if (
                not self.repeat
                or not self.steps
                or self.value
                or self.target
                or self.secondary_target
                or self.exercise
                or self.weight_kg is not None
                or self.stroke
            ):
                raise ValueError(
                    "Un bloc kind='repeat' exige repeat (entier de 2 à 100) et "
                    "steps (sous-étapes non vides). Place durée, distance et cible "
                    "sur chaque sous-étape, pas sur le bloc."
                )
        elif self.steps or self.repeat:
            raise ValueError("Seul un bloc répété peut contenir des étapes.")
        elif (self.duration_kind == "lap") != (self.value is None):
            raise ValueError(
                "Indique une valeur pour la durée, la distance ou les répétitions."
            )
        if (
            self.duration_kind == "reps"
            and self.value is not None
            and not self.value.is_integer()
        ):
            raise ValueError("Le nombre de répétitions doit être entier.")
        return self


class Prescription(StrictModel):
    version: Literal[1] = 1
    steps: list[Step] = Field(min_length=1, max_length=MAX_STEPS)
    pool_length_m: float | None = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def bounded(self):
        count = 0
        expanded = 0

        def visit(steps: list[Step], depth: int, multiplier: int) -> None:
            nonlocal count, expanded
            if depth > MAX_REPEAT_DEPTH:
                raise ValueError("Maximum deux niveaux de répétition.")
            for step in steps:
                count += 1
                if count > MAX_STEPS:
                    raise ValueError("Maximum 100 étapes par séance.")
                if step.kind == "repeat":
                    visit(step.steps, depth + 1, multiplier * (step.repeat or 1))
                else:
                    expanded += multiplier
                    if expanded > MAX_EXPANDED_STEPS:
                        raise ValueError("Maximum 1 000 étapes après répétition.")

        visit(self.steps, 0, 1)
        return self


class Provenance(StrictModel):
    document_id: UUID
    locator: str = Field(
        min_length=1,
        max_length=200,
        description="Exact block identifier shown in square brackets in the source, "
        "e.g. lignes 1-12. Never invent a description or use read_file line numbers.",
    )
    quote: str = Field(
        min_length=1,
        max_length=4000,
        description="Exact substring of that block, without read_file line numbers.",
    )


def strength_prescription(text: str, day: Date | None) -> Prescription:
    from arete.data.exercises_catalog import get_exercise
    from arete.strength.logging_service import parse_for_athlete

    parsed = parse_for_athlete(text, workout_date=day)
    if parsed.unparsed_lines or any(e.exercise_id is None for e in parsed.exercises):
        raise ValueError(
            "La grammaire ne reconnaît pas toute la séance de musculation. Corrige le texte source."
        )
    steps = []
    for exercise in parsed.exercises:
        definition = get_exercise(exercise.exercise_id or "")
        assert definition is not None
        for series in exercise.sets:
            steps.append(
                Step(
                    kind="warmup" if series.is_warmup else "effort",
                    duration_kind="reps",
                    value=series.reps,
                    exercise=exercise.name,
                    garmin_exercise=definition["name"],
                    weight_kg=series.weight_kg,
                )
            )
            if series.rest_sec:
                steps.append(
                    Step(kind="rest", duration_kind="seconds", value=series.rest_sec)
                )
            if len(steps) > MAX_STEPS:
                raise ValueError("Maximum 100 étapes (séries et repos) par séance.")
    return Prescription(steps=steps)


def prescription_from_description(text: str, sport: str) -> Prescription | None:
    """The run the description writes out, or None unless every part is read.

    Running only: cycling and swimming notations are not covered. Deterministic
    (Lark grammar); never a partial workout.
    """
    if sport != "running":
        return None
    from arete.llm.running_grammar import parse_running

    steps = parse_running(text)
    if steps is None:
        return None
    try:
        return Prescription.model_validate({"steps": steps})
    except ValidationError:  # a bound the text exceeds (steps, repeats)
        return None


def strength_sets(
    prescription: Prescription,
) -> list[tuple[str, float | None, float | None]]:
    """Expand bounded groups for comparison; rests and Garmin names add no sets."""
    result: list[tuple[str, float | None, float | None]] = []

    def visit(steps: list[Step]) -> None:
        for step in steps:
            if step.kind == "repeat":
                for _ in range(step.repeat or 1):
                    visit(step.steps)
            elif step.kind not in {"rest", "recovery"}:
                if step.duration_kind != "reps":
                    raise ValueError(
                        "La musculation doit préciser les répétitions de chaque série."
                    )
                result.append((step.exercise.casefold(), step.value, step.weight_kg))
                assert len(result) <= MAX_EXPANDED_STEPS

    visit(prescription.steps)
    return result


def conversation_prescription(
    prescription: Prescription | None, sport: str, day: Date, strength_text: str = ""
) -> Prescription:
    """Validate model input without allowing it to replace the strength grammar."""
    if len(strength_text) > 4_000:
        raise ValueError("Prescription trop volumineuse.")
    if strength_text and sport != "strength":
        raise ValueError('strength_text exige sport="strength".')
    if sport == "strength":
        if not strength_text:
            raise ValueError(
                "Fournis le texte exact de musculation pour vérifier les séries."
            )
        parsed = strength_prescription(strength_text, day)
        if prescription is None:
            return parsed
        if strength_sets(prescription) != strength_sets(parsed):
            raise ValueError(
                "Les séries ne correspondent pas au texte reconnu par la grammaire."
            )
        return prescription
    if prescription is None:
        raise ValueError("Une prescription structurée est requise.")
    return prescription


def describe(prescription: Prescription) -> str:
    """A bounded, literal summary; distance never invents a duration."""

    def step_text(step: Step) -> str:
        if step.kind == "repeat":
            return (
                f"{step.repeat} × ("
                + " / ".join(step_text(s) for s in step.steps)
                + ")"
            )
        value = step.value or 0
        amount = {
            "seconds": f"{value / 60:g} min" if value % 60 == 0 else f"{value:g} s",
            "meters": f"{value:g} m",
            "reps": f"{value:g} répétitions",
            "lap": "jusqu’au tour manuel",
        }[step.duration_kind]
        if step.exercise:
            amount = f"{step.exercise} · {amount}"
        if step.weight_kg is not None:
            amount += f" à {step.weight_kg:g} kg"
        if step.target:
            target = step.target
            if target.kind == "hr_zone":
                amount += f" Z{target.low:g}"
            else:
                unit = {
                    "pace_sec_km": "s/km",
                    "heart_rate_bpm": "bpm",
                    "power_w": "W",
                    "cadence_rpm": "tr/min",
                }[target.kind]
                amount += f" · {target.low:g}–{target.high:g} {unit}"
        if step.kind in {"recovery", "rest"}:
            amount = "récupération " + amount
        return amount

    return " · ".join(step_text(step) for step in prescription.steps)
