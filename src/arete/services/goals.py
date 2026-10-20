"""Goals (``app.goals``): the dates a periodised plan is built towards.

A goal is a road ``race``, a ``hyrox`` race (8 km of running, whatever the
division) or a ``hybrid`` block without a race, whose ``race_date`` is the
block's last day. Hyrox and hybrid goals carry their details (division,
format, category, equipment, block length) as JSON.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

from arete.dataio.db import connect
from arete.services.settings import athlete_today

PRIORITIES = ("A", "B", "C")
STATUSES = ("active", "done", "cancelled")
GOAL_TYPES = ("race", "hyrox", "hybrid")
HYROX_DISTANCE_KM = 8.0
#: A hybrid block has no distance; the column requires one.
HYBRID_DISTANCE_KM = 0.0
_COLUMNS = (
    "id, name, race_date, distance_km, target_time_sec, priority, status, created_at,"
    " goal_type, details_json"
)
_EDITABLE = frozenset(
    {
        "name",
        "race_date",
        "distance_km",
        "target_time_sec",
        "priority",
        "status",
        "details",
    }
)


class GoalDetails(BaseModel):
    """A Hyrox goal's or hybrid block's details, as stored in ``details_json``."""

    model_config = ConfigDict(extra="forbid")

    division: Literal["open", "pro"] = "open"
    format: Literal["solo", "doubles"] = "solo"
    category: Literal["men", "women", "mixed"] | None = None
    #: Equipment flags, or ``["none"]`` when there is none.
    equipment: list[Literal["sled", "ski_erg", "rower", "wall_ball", "none"]] = ["none"]
    weeks: Literal[8, 12] = 12

    @field_validator("equipment")
    @classmethod
    def _equipment(cls, value: list[str]) -> list[str]:
        duplicated = len(set(value)) < len(value)
        if not value or duplicated or ("none" in value and len(value) > 1):
            raise ValueError("equipment")
        return value


_DETAIL_ERRORS = {
    "division": "La division doit être open ou pro.",
    "format": "Le format doit être solo ou doubles.",
    "category": "La catégorie doit être men, women ou mixed.",
    "equipment": "Le matériel est une liste parmi sled, ski_erg, rower et "
    'wall_ball, ou ["none"] sans matériel.',
    "weeks": "Le bloc dure 8 ou 12 semaines.",
}


def validate_details(goal_type: str, details: dict[str, Any] | None) -> str | None:
    """``details_json`` for a goal of ``goal_type``; ValueError in French."""
    if goal_type not in GOAL_TYPES:
        raise ValueError("Le type d’objectif doit être race, hyrox ou hybrid.")
    if goal_type == "race":
        if details:
            raise ValueError(
                "Les détails ne s’appliquent qu’aux objectifs Hyrox et hybrides."
            )
        return None
    try:
        parsed = GoalDetails.model_validate(details or {})
    except ValidationError as e:
        field_name = str(e.errors()[0]["loc"][0]) if e.errors()[0]["loc"] else ""
        raise ValueError(
            _DETAIL_ERRORS.get(field_name, f"Détail inconnu : {field_name}.")
        ) from None
    if goal_type == "hyrox" and parsed.category is None:
        raise ValueError("Indique la catégorie Hyrox : men, women ou mixed.")
    if parsed.category == "mixed" and parsed.format != "doubles":
        raise ValueError("La catégorie mixte se court en doubles.")
    return parsed.model_dump_json()


@dataclass(frozen=True)
class Goal:
    id: int
    name: str
    race_date: date
    distance_km: float
    target_time_sec: int | None
    priority: str
    status: str
    created_at: datetime | None
    goal_type: str = "race"
    details: dict[str, Any] | None = field(default=None, hash=False)

    def days_left(self, today: date | None = None) -> int:
        return (self.race_date - (today or athlete_today())).days

    def to_dict(self, today: date | None = None) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "race_date": self.race_date.isoformat(),
            "distance_km": self.distance_km,
            "target_time_sec": self.target_time_sec,
            "priority": self.priority,
            "status": self.status,
            "days_left": self.days_left(today),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "goal_type": self.goal_type,
            "details": self.details,
        }


def _from_row(row: tuple) -> Goal:
    *columns, goal_type, details = row  # the type and details come last
    return replace(
        Goal(*columns),
        goal_type=goal_type or "race",
        details=json.loads(details) if details else None,
    )


def _validate(fields: dict[str, Any]) -> None:
    if "priority" in fields and fields["priority"] not in PRIORITIES:
        raise ValueError("priority must be A, B or C")
    if "status" in fields and fields["status"] not in STATUSES:
        raise ValueError("status must be active, done or cancelled")
    if "distance_km" in fields and not 1 <= float(fields["distance_km"]) <= 250:
        raise ValueError("distance_km must be between 1 and 250")
    if (
        fields.get("target_time_sec") is not None
        and int(fields["target_time_sec"]) <= 0
    ):
        raise ValueError("target_time_sec must be positive")
    if "name" in fields and not str(fields["name"]).strip():
        raise ValueError("name must not be empty")


def list_goals(*, include_past: bool = False, today: date | None = None) -> list[Goal]:
    con = connect()
    try:
        # The athlete's day, not the database clock's (UTC on Vercel).
        where = "" if include_past else "AND race_date >= ?"
        rows = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_goals WHERE user_id = getvariable('arete_athlete_id') {where} ORDER BY race_date, id",
            [] if include_past else [today or athlete_today()],
        ).fetchall()
    finally:
        con.close()
    return [_from_row(r) for r in rows]


def get_goal(goal_id: int) -> Goal | None:
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_goals WHERE id = ?", [goal_id]
        ).fetchone()
    finally:
        con.close()
    return _from_row(row) if row else None


def next_goal(today: date | None = None, con=None) -> Goal | None:
    """The race the plan works towards: the soonest active A race, else any.
    A hybrid block is no race: never the next goal."""
    today = today or athlete_today()
    own = con is None
    con = con or connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_goals WHERE user_id = getvariable('arete_athlete_id') AND status = 'active' AND race_date >= ? AND coalesce(goal_type, 'race') <> 'hybrid' ORDER BY coalesce(priority = 'A', false) DESC, race_date, id LIMIT 1",
            [today],
        ).fetchone()
    finally:
        if own:
            con.close()
    return _from_row(row) if row else None


def create_goal(
    *,
    name: str,
    race_date: date,
    distance_km: float | None = None,
    target_time_sec: int | None = None,
    priority: str = "A",
    goal_type: str = "race",
    details: dict[str, Any] | None = None,
) -> Goal:
    details_json = validate_details(goal_type, details)
    if goal_type == "race" and distance_km is None:
        raise ValueError("La distance de la course est requise.")
    fields = {
        "name": name.strip(),
        "race_date": race_date,
        "distance_km": {"hyrox": HYROX_DISTANCE_KM, "hybrid": HYBRID_DISTANCE_KM}.get(
            goal_type, distance_km
        ),
        "target_time_sec": target_time_sec,
        "priority": priority,
        "goal_type": goal_type,
        "details_json": details_json,
    }
    checked = dict(fields)
    if goal_type != "race":  # a fixed or placeholder distance
        del checked["distance_km"]
    _validate(checked)
    con = connect()
    try:
        row = con.execute(
            "INSERT INTO app.goals (name, race_date, distance_km, target_time_sec, priority, goal_type, details_json) "
            f"VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING {_COLUMNS}",
            list(fields.values()),
        ).fetchone()
    finally:
        con.close()
    assert row is not None
    return _from_row(row)


def update_goal(goal_id: int, **fields: Any) -> Goal | None:
    unknown = set(fields) - _EDITABLE
    if unknown:
        raise ValueError(f"Not editable: {sorted(unknown)}")
    _validate(fields)
    if "details" in fields or "distance_km" in fields:
        current = get_goal(goal_id)
        if current is None:
            return None
        if "distance_km" in fields and current.goal_type != "race":
            raise ValueError(
                "La distance d’un objectif Hyrox ou hybride ne se modifie pas."
            )
        if "details" in fields:
            fields["details_json"] = validate_details(
                current.goal_type, fields.pop("details")
            )
    if fields:
        con = connect()
        try:
            con.execute(
                f"UPDATE app.goals SET {', '.join(f'{k} = ?' for k in fields)} WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id",
                [*fields.values(), goal_id],
            )
        finally:
            con.close()
    return get_goal(goal_id)


def delete_goal(goal_id: int) -> bool:
    """Delete the goal and the sessions its plan generated that are still to do."""
    from arete.services.plan_builder import _delete_future

    if get_goal(goal_id) is None:
        return False
    _delete_future(goal_id, athlete_today())
    con = connect()
    try:
        con.execute(
            "UPDATE app.planned_sessions SET goal_id = NULL WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (goal_id = ?) RETURNING id",
            [goal_id],
        )
        row = con.execute(
            "UPDATE app.goals SET deleted_at = current_timestamp WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id",
            [goal_id],
        ).fetchone()
    finally:
        con.close()
    return row is not None
