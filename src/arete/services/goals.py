"""Goal races (``app.goals``): the dates a periodised plan is built towards."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from arete.dataio.db import connect
from arete.services.settings import athlete_today

PRIORITIES = ("A", "B", "C")
STATUSES = ("active", "done", "cancelled")
_COLUMNS = (
    "id, name, race_date, distance_km, target_time_sec, priority, status, created_at"
)
_EDITABLE = frozenset(
    {"name", "race_date", "distance_km", "target_time_sec", "priority", "status"}
)


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
        }


def _from_row(row: tuple) -> Goal:
    return Goal(*row)


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


def list_goals(*, include_past: bool = False) -> list[Goal]:
    con = connect()
    try:
        # The athlete's day, not the database clock's (UTC on Vercel).
        where = "" if include_past else "AND race_date >= ?"
        rows = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_goals WHERE user_id = getvariable('arete_athlete_id') {where} ORDER BY race_date, id",
            [] if include_past else [athlete_today()],
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


def next_goal(today: date | None = None) -> Goal | None:
    """The race the plan works towards: the soonest active A race, else any."""
    today = today or athlete_today()
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.visible_goals WHERE user_id = getvariable('arete_athlete_id') AND status = 'active' AND race_date >= ? ORDER BY coalesce(priority = 'A', false) DESC, race_date, id LIMIT 1",
            [today],
        ).fetchone()
    finally:
        con.close()
    return _from_row(row) if row else None


def create_goal(
    *,
    name: str,
    race_date: date,
    distance_km: float,
    target_time_sec: int | None = None,
    priority: str = "A",
) -> Goal:
    fields = {
        "name": name.strip(),
        "race_date": race_date,
        "distance_km": distance_km,
        "target_time_sec": target_time_sec,
        "priority": priority,
    }
    _validate(fields)
    con = connect()
    try:
        row = con.execute(
            "INSERT INTO app.goals (name, race_date, distance_km, target_time_sec, priority) "
            f"VALUES (?, ?, ?, ?, ?) RETURNING {_COLUMNS}",
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
    if fields:
        con = connect()
        try:
            con.execute(
                f"UPDATE app.goals SET {', '.join(f'{k} = ?' for k in fields)} WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) ",
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
            "UPDATE app.planned_sessions SET goal_id = NULL WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (goal_id = ?) ",
            [goal_id],
        )
        row = con.execute(
            "UPDATE app.goals SET deleted_at = current_timestamp WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id",
            [goal_id],
        ).fetchone()
    finally:
        con.close()
    return row is not None
