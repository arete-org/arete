"""Confirm literal onboarding answers in the existing athlete-scoped Markdown ledger.

Drafts stay in the athlete's browser. profile.md is the only durable biography:
CompositeBackend reads/edits/forgets it, and journal_block supplies it to Chiron.
No new table, duplicate fact store, model request or training plan is created.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from functools import partial
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from arete.services import memory
from arete.services.settings import UserSettingsUpdate

Goal = Literal["restart", "progress", "race", "consistency"]
Sport = Literal["running", "strength", "cycling", "other"]
Day = Literal[
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
]
GOALS = {
    "restart": "Reprendre le sport",
    "progress": "Progresser",
    "race": "Préparer une course",
    "consistency": "Rester régulier",
}
SPORTS = {
    "running": "course à pied",
    "strength": "renforcement",
    "cycling": "vélo",
    "other": "autre sport",
}
DAYS = {
    "monday": "lundi",
    "tuesday": "mardi",
    "wednesday": "mercredi",
    "thursday": "jeudi",
    "friday": "vendredi",
    "saturday": "samedi",
    "sunday": "dimanche",
}


class Answers(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    goal: Goal | None = None
    description: str | None = Field(default=None, min_length=1, max_length=280)
    race_name: str | None = Field(default=None, min_length=1, max_length=180)
    race_date: date | None = None
    sports: list[Sport] = Field(default_factory=list, max_length=4)
    weekly_training_goal: int | None = Field(default=None, ge=1, le=14, strict=True)
    rest_day_preference: list[Day] | None = Field(default=None, max_length=7)
    constraints: str | None = Field(default=None, min_length=1, max_length=280)
    timezone: str | None = Field(default=None, max_length=80)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        return UserSettingsUpdate.validate_timezone(value) if value else None

    @model_validator(mode="after")
    def consistent(self) -> Answers:
        if (self.race_name or self.race_date) and self.goal != "race":
            raise ValueError("Les informations de course nécessitent cet objectif.")
        if len(set(self.sports)) != len(self.sports):
            raise ValueError("Sport répété.")
        days = self.rest_day_preference or []
        if len(set(days)) != len(days):
            raise ValueError("Jour de repos répété.")
        return self


class ConfirmOnboarding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: UUID
    expected_revision: int = Field(ge=0)
    answers: Answers


def get_progress() -> dict:
    file = memory.read_file(memory.PROFILE_LEDGER)
    return {
        "revision": file.revision,
        "status": "completed" if file.revision else "not_started",
    }


def render_answers(answers: Answers) -> str:
    """JSON-quote free-text answers inside Markdown; no inferred constraints/phases.

    The athlete reads this recap too: an unanswered question is left out
    rather than written as a blank, and a race fits on one line.
    """
    quote = partial(json.dumps, ensure_ascii=False)
    race = [quote(answers.race_name)] if answers.race_name else []
    if answers.race_date:
        race.append(answers.race_date.isoformat())
    rows: list[tuple[str, str | None]] = [
        ("Prénom", answers.display_name and quote(answers.display_name)),
        ("Objectif", GOALS[answers.goal] if answers.goal else None),
        ("Précisions", answers.description and quote(answers.description)),
        ("Course envisagée", " · ".join(race) or None),
        (
            "Sports pratiqués",
            ", ".join(SPORTS[sport] for sport in answers.sports) or None,
        ),
        (
            "Séances souhaitées par semaine",
            str(answers.weekly_training_goal) if answers.weekly_training_goal else None,
        ),
        (
            "Jours de repos préférés",
            ", ".join(DAYS[day] for day in answers.rest_day_preference or []) or None,
        ),
        ("Contraintes déclarées", answers.constraints and quote(answers.constraints)),
        ("Fuseau horaire confirmé", answers.timezone),
    ]
    given = [f"- {label} : {value}" for label, value in rows if value]
    intro = "Réponses confirmées par l’athlète."
    if answers.goal == "race":
        intro += " Une course exprime une intention, pas un plan."
    if len(given) < len(rows):
        # Skipped answers stay unknown: no default fills them in.
        intro += " Ce qui n’y figure pas reste à préciser."
    return "\n\n".join([intro, "\n".join(given)]) if given else intro


def confirm(command: ConfirmOnboarding) -> dict:
    digest = hashlib.sha256(command.answers.model_dump_json().encode()).hexdigest()
    marker = f"<!-- onboarding:{command.command_id}:{digest} -->"
    file = memory.read_file(memory.PROFILE_LEDGER)
    # Only a still-present receipt acknowledges a lost response. Forgetting
    # erases it too; an old request cannot resurrect a deleted profile.
    if marker in file.content:
        return get_progress()
    if file.revision or command.expected_revision:
        raise memory.MemoryConflict(
            "Profil déjà enregistré ou modifié. Relis-le avant de le corriger avec Chiron."
        )
    memory.append_entry(
        memory.PROFILE_LEDGER,
        "Mon point de départ avec Arete",
        render_answers(command.answers) + "\n\n" + marker,
        expected_revision=0,
    )
    return get_progress()


def confirmed_context() -> dict:
    file = memory.read_file(memory.PROFILE_LEDGER)
    return {
        "revision": file.revision,
        "content": file.content if not file.forgotten else "",
        "forgotten": file.forgotten,
    }
