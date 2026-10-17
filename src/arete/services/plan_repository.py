"""The plan-decision log (``app.plan_decisions``): one row per session and day."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from datetime import date as Date
from typing import Any

import duckdb

from arete.dataio.db import connect
from arete.services.athlete_scope import resolve_athlete_id

_COLUMNS = (
    "id, date, planned_session_id, decision, reason, readiness_score, "
    "readiness_source, acwr, original_json, adapted_json, applied_at, "
    "reverted_at, created_at, state, revision, session_revision, readiness_measured_on, snoozed_until"
)


#: ``readiness_source`` of a decision the athlete chose (« Modifier », ARE-61):
#: no readiness made it, and the RPG's prescribed rests leave it out.
ATHLETE_CHOICE = "athlete"
#: ``readiness_source`` of a missed session's replanning (ARE-61 Part 2): a
#: proposal of the evening, made from no readiness either.
MISSED_REPLAN = "missed"


class AlreadyDecided(Exception):
    """That session already has a decision for that day."""


@dataclass(frozen=True)
class PlanDecision:
    id: int
    date: date
    planned_session_id: int
    decision: str
    reason: str
    readiness_score: float | None
    readiness_source: str | None
    acwr: float | None
    original: dict[str, Any] | None
    adapted: dict[str, Any] | None
    applied_at: datetime | None
    reverted_at: datetime | None
    created_at: datetime | None
    state: str = "applied"
    revision: int = 1
    session_revision: int | None = None
    readiness_measured_on: Date | None = None
    snoozed_until: Date | None = None

    def to_dict(self) -> dict[str, Any]:
        def iso(value: date | datetime | None) -> str | None:
            return value.isoformat() if value else None

        return {
            "id": self.id,
            "date": self.date.isoformat(),
            "planned_session_id": self.planned_session_id,
            "decision": self.decision,
            "reason": self.reason,
            "readiness_score": self.readiness_score,
            "readiness_source": self.readiness_source,
            "acwr": self.acwr,
            "original": self.original,
            "adapted": self.adapted,
            "applied_at": iso(self.applied_at),
            "reverted_at": iso(self.reverted_at),
            "created_at": iso(self.created_at),
            "state": self.state,
            "revision": self.revision,
            "session_revision": self.session_revision,
            "readiness_measured_on": iso(self.readiness_measured_on),
            "snoozed_until": iso(self.snoozed_until),
        }


def _loads(raw: str | None) -> dict[str, Any] | None:
    return json.loads(raw) if raw else None


def _from_row(row: tuple) -> PlanDecision:
    return PlanDecision(
        id=row[0],
        date=row[1],
        planned_session_id=row[2],
        decision=row[3],
        reason=row[4],
        readiness_score=row[5],
        readiness_source=row[6],
        acwr=row[7],
        original=_loads(row[8]),
        adapted=_loads(row[9]),
        applied_at=row[10],
        reverted_at=row[11],
        created_at=row[12],
        state=row[13],
        revision=row[14],
        session_revision=row[15],
        readiness_measured_on=row[16],
        snoozed_until=row[17],
    )


class PlanDecisionRepository:
    """CRUD over ``app.plan_decisions``. One connection per method."""

    def create(
        self,
        *,
        day: date,
        planned_session_id: int,
        decision: str,
        reason: str,
        readiness_score: float | None,
        readiness_source: str | None,
        acwr: float | None,
        original: dict[str, Any],
        adapted: dict[str, Any] | None,
        user_id: int | None = None,
        state: str = "pending",
        session_revision: int | None = None,
        readiness_measured_on: Date | None = None,
        con: duckdb.DuckDBPyConnection | None = None,
    ) -> PlanDecision:
        """Claim the day's decision for that session; raises ``AlreadyDecided``.

        ``state="applied"`` stamps ``applied_at`` (the athlete's own choice,
        written with the session). ``con`` joins the caller's transaction.
        """
        user_id = resolve_athlete_id(user_id)
        own = con is None
        con = con or connect()
        try:
            row = con.execute(
                f"""
                INSERT INTO app.plan_decisions
                    (user_id, date, planned_session_id, decision, reason,
                     readiness_score, readiness_source, acwr, original_json,
                     adapted_json, state, session_revision, readiness_measured_on,
                     applied_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                        CASE WHEN ? = 'applied' THEN now() END)
                RETURNING {_COLUMNS}
                """,
                [
                    user_id,
                    day,
                    planned_session_id,
                    decision,
                    reason,
                    readiness_score,
                    readiness_source,
                    acwr,
                    json.dumps(original, ensure_ascii=False, default=str),
                    json.dumps(adapted, ensure_ascii=False) if adapted else None,
                    state,
                    session_revision,
                    readiness_measured_on,
                    state,
                ],
            ).fetchone()
        except duckdb.ConstraintException as e:
            raise AlreadyDecided(f"session {planned_session_id} on {day}") from e
        finally:
            if own:
                con.close()
        if row is None:  # pragma: no cover - RETURNING always yields the row
            raise RuntimeError("Failed to insert plan decision")
        return _from_row(row)

    def reapply(
        self,
        decision_id: int,
        revision: int,
        *,
        decision: str,
        reason: str,
        original: dict[str, Any],
        adapted: dict[str, Any] | None,
        session_revision: int,
        con: duckdb.DuckDBPyConnection,
        state: str = "applied",
        origin: str = ATHLETE_CHOICE,
    ) -> PlanDecision | None:
        """Write the athlete's choice over a closed decision of the day.

        ``state="pending"`` with ``origin=MISSED_REPLAN`` writes the evening's
        replanning proposal instead, not applied.

        The day keeps one row per session (the unique key): a declined or
        reverted decision, or a proposal snoozed past today, is replaced in
        place, by compare-and-set on the revision the athlete's page read
        (the caller keeps what it replaced in ``original["replaced"]``).
        None when that row changed meanwhile or is still open.
        """
        row = con.execute(
            f"""
            UPDATE app.plan_decisions SET
                decision = ?, reason = ?, readiness_score = NULL,
                readiness_source = ?, acwr = NULL, original_json = ?,
                adapted_json = ?,
                applied_at = CASE WHEN ? = 'applied' THEN now() END,
                reverted_at = NULL, state = ?, revision = revision + 1,
                session_revision = ?, readiness_measured_on = NULL,
                snoozed_until = NULL
            WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL
              AND id = ? AND revision = ?
              AND (state = 'dismissed' OR reverted_at IS NOT NULL
                   OR (state IN ('pending', 'discussion') AND snoozed_until > date))
            RETURNING {_COLUMNS}
            """,
            [
                decision,
                reason,
                origin,
                json.dumps(original, ensure_ascii=False, default=str),
                json.dumps(adapted, ensure_ascii=False) if adapted else None,
                state,
                state,
                session_revision,
                decision_id,
                revision,
            ],
        ).fetchone()
        return _from_row(row) if row else None

    def get(self, decision_id: int) -> PlanDecision | None:
        con = connect()
        try:
            row = con.execute(
                f"SELECT {_COLUMNS} FROM app.visible_plan_decisions WHERE id = ?",
                [decision_id],
            ).fetchone()
        finally:
            con.close()
        return _from_row(row) if row else None

    def list_for_day(
        self, day: date, user_id: int | None = None, con=None
    ) -> list[PlanDecision]:
        user_id = resolve_athlete_id(user_id)
        own = con is None
        con = con or connect()
        try:
            rows = con.execute(
                f"SELECT {_COLUMNS} FROM app.visible_plan_decisions WHERE user_id = ? AND date = ? ORDER BY id",
                [user_id, day],
            ).fetchall()
        finally:
            if own:
                con.close()
        return [_from_row(r) for r in rows]

    def mark(self, decision_id: int, column: str) -> None:
        """Stamp ``applied_at`` or ``reverted_at`` with now."""
        if column not in ("applied_at", "reverted_at"):
            raise ValueError(column)
        con = connect()
        try:
            con.execute(
                f"UPDATE app.plan_decisions SET {column} = ? WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) ",
                [datetime.now(), decision_id],
            )
        finally:
            con.close()
