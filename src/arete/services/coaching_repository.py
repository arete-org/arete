"""Repositories for the coach's written output: the daily briefings
(``app.coach_briefings``) and the session feedback (``app.session_feedback``).

One row per produced briefing, kept rather than recomputed: a run costs a
model call, and a failure must stay visible instead of leaving the dashboard
silently empty.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

import duckdb

from arete.dataio.db import connect, db_connection
from arete.dataio.ownership import require_owned
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.settings import athlete_today

Priority = Literal["info", "warning", "alert"]
Source = Literal["agent", "rules"]
Status = Literal["ok", "failed"]
Trigger = Literal["scheduler", "api"]


@dataclass(frozen=True)
class Briefing:
    """One day's briefing, as stored."""

    id: int
    date: date
    text: str
    priority: str
    source: str
    status: str
    error: str | None
    trigger: str
    created_at: datetime | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "date": self.date.isoformat(),
            "text": self.text,
            "priority": self.priority,
            "source": self.source,
            "status": self.status,
            "error": self.error,
            "trigger": self.trigger,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


_COLUMNS = "id, date, text, priority, source, status, error, trigger, created_at"


def _row_to_briefing(row: tuple) -> Briefing:
    return Briefing(
        id=int(row[0]),
        date=row[1],
        text=row[2],
        priority=row[3],
        source=row[4],
        status=row[5],
        error=row[6],
        trigger=row[7],
        created_at=row[8],
    )


class BriefingRepository:
    """CRUD over ``app.coach_briefings``. One connection per method."""

    def _get_connection(self) -> duckdb.DuckDBPyConnection:
        conn = connect()
        conn.execute("SET search_path = 'app'")
        return conn

    def create(
        self,
        *,
        text: str,
        briefing_date: date | None = None,
        priority: str = "info",
        source: str = "rules",
        status: str = "ok",
        error: str | None = None,
        trigger: str = "api",
        user_id: int | None = None,
    ) -> int:
        user_id = resolve_athlete_id(user_id)
        conn = self._get_connection()
        try:
            result = conn.execute(
                """
                INSERT INTO coach_briefings
                    (user_id, date, text, priority, source, status, error,
                     trigger, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                [
                    user_id,
                    briefing_date or athlete_today(),
                    text,
                    priority,
                    source,
                    status,
                    error,
                    trigger,
                    datetime.now(),
                ],
            ).fetchone()
        finally:
            conn.close()
        if result is None:
            raise RuntimeError("Failed to insert coach briefing")
        return int(result[0])

    def get_for_day(
        self, briefing_date: date | None = None, user_id: int | None = None
    ) -> Briefing | None:
        """The day's usable briefing — newest first, failures skipped.

        A failed run is stored so it stays visible, but it is never what the
        dashboard shows: a later successful run for the same day wins, and
        when there is none the caller falls back to the rule text.
        """
        user_id = resolve_athlete_id(user_id)
        conn = self._get_connection()
        try:
            row = conn.execute(
                f"""
                SELECT {_COLUMNS} FROM visible_coach_briefings
                WHERE user_id = ? AND date = ? AND status = 'ok'
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                """,
                [user_id, briefing_date or athlete_today()],
            ).fetchone()
        finally:
            conn.close()
        return _row_to_briefing(row) if row else None

    def list_recent(
        self, limit: int = 30, user_id: int | None = None
    ) -> list[Briefing]:
        """Recent briefings, failures included — this is the audit view."""
        user_id = resolve_athlete_id(user_id)
        conn = self._get_connection()
        try:
            rows = conn.execute(
                f"""
                SELECT {_COLUMNS} FROM visible_coach_briefings
                WHERE user_id = ?
                ORDER BY date DESC, created_at DESC, id DESC
                LIMIT ?
                """,
                [user_id, limit],
            ).fetchall()
        finally:
            conn.close()
        return [_row_to_briefing(row) for row in rows]

    def delete_for_day(self, briefing_date: date, user_id: int | None = None) -> int:
        """Drop a day's briefings; returns how many went. Used to force a redo."""
        user_id = resolve_athlete_id(user_id)
        conn = self._get_connection()
        try:
            rows = conn.execute(
                "DELETE FROM coach_briefings WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (user_id = ? AND date = ?) RETURNING id",
                [user_id, briefing_date],
            ).fetchall()
        finally:
            conn.close()
        return len(rows)


@dataclass(frozen=True)
class StoredFeedback:
    """The coach's word on one cardio session, as the session page shows it."""

    session_id: int
    text: str
    source: str
    trigger: str
    created_at: datetime | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "source": self.source,
            "trigger": self.trigger,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class SessionFeedbackRepository:
    """``app.session_feedback``: one row per cardio session, the latest wins."""

    def save(self, session_id: int, *, text: str, source: str, trigger: str) -> None:
        with db_connection() as conn:
            require_owned(conn, "actual_sessions", session_id)
            conn.execute(
                "DELETE FROM app.session_feedback WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (actual_session_id = ?) ",
                [session_id],
            )
            conn.execute(
                "INSERT INTO app.session_feedback "
                "(actual_session_id, text, source, trigger, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                [session_id, text, source, trigger, datetime.now()],
            )

    def get(self, session_id: int) -> StoredFeedback | None:
        with db_connection() as conn:
            row = conn.execute(
                "SELECT actual_session_id, text, source, trigger, created_at FROM app.visible_session_feedback WHERE actual_session_id = ?",
                [session_id],
            ).fetchone()
        return StoredFeedback(*row) if row else None

    def with_feedback(self, session_ids: list[int]) -> set[int]:
        """Which of these sessions already have one (a run never pays twice)."""
        if not session_ids:
            return set()
        with db_connection() as conn:
            rows = conn.execute(
                "SELECT actual_session_id FROM app.visible_session_feedback WHERE list_contains(?, actual_session_id)",
                [session_ids],
            ).fetchall()
        return {int(r[0]) for r in rows}
