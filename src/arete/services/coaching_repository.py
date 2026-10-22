"""Repositories for the coach's written output: the daily briefings
(``app.coach_briefings``) and the session feedback (``app.session_feedback``).

One row per produced briefing, kept rather than recomputed: a run costs a
model call, and a failure must stay visible instead of leaving the dashboard
silently empty.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

import duckdb

from arete.dataio.db import connect, db_connection, transaction
from arete.dataio.ownership import require_owned
from arete.dataio.queries import sql_in
from arete.garmin.models import FILE_SOURCES, ActivitySource
from arete.services import settings
from arete.services.athlete_scope import resolve_athlete_id
from arete.services.settings import athlete_today

Priority = Literal["info", "warning", "alert"]
Source = Literal["agent", "rules"]
#: 'pending' marks a run in progress (``claim``); it is never served or audited.
Status = Literal["ok", "failed", "pending"]
Trigger = Literal["scheduler", "api"]


def naive_utc_now() -> datetime:
    """``created_at`` and ``reacted_at`` are naive UTC: instances on other
    clocks (Docker in Paris, Vercel in UTC) share the database. Rows written
    before that are local time, so the order of a day's rows is their id."""
    return settings.utc_now().replace(tzinfo=None)


#: The athlete's reaction to a briefing (``react``).
Reaction = Literal["up", "down"]
#: The previous briefings the dashboard lists.
HISTORY_LIMIT = 7


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
    #: Identifies the facts it was written from (``briefing.facts_digest``).
    facts_digest: str | None = None
    #: An earlier usable briefing of the same day was replaced by this one.
    revised: bool = False
    #: The athlete's reaction (``react``) and their optional word with it.
    reaction: str | None = None
    reaction_comment: str | None = None
    #: When the day's first usable briefing was written (``get_for_day``).
    first_created_at: datetime | None = None

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
            "created_at": (
                self.created_at.replace(tzinfo=UTC).isoformat()
                if self.created_at
                else None
            ),
        }


_COLUMNS = (
    "id, date, text, priority, source, status, error, trigger, created_at,"
    " facts_digest, reaction, reaction_comment"
)


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
        facts_digest=row[9],
        reaction=row[10],
        reaction_comment=row[11],
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
        facts_digest: str | None = None,
    ) -> int:
        user_id = resolve_athlete_id(user_id)
        conn = self._get_connection()
        try:
            result = conn.execute(
                """
                INSERT INTO coach_briefings
                    (user_id, date, text, priority, source, status, error,
                     trigger, created_at, facts_digest)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    naive_utc_now(),
                    facts_digest,
                ],
            ).fetchone()
        finally:
            conn.close()
        if result is None:
            raise RuntimeError("Failed to insert coach briefing")
        return int(result[0])

    def get_for_day(
        self,
        briefing_date: date | None = None,
        user_id: int | None = None,
        con: duckdb.DuckDBPyConnection | None = None,
    ) -> Briefing | None:
        """The day's usable briefing — newest first, failures skipped.

        A failed run is stored so it stays visible, but it is never what the
        dashboard shows: a later successful run for the same day wins, and
        when there is none the caller falls back to the rule text.
        """
        user_id = resolve_athlete_id(user_id)
        conn = con or self._get_connection()
        try:
            row = conn.execute(
                f"""
                SELECT {_COLUMNS}, count(*) OVER () > 1, arg_min(created_at, id) OVER ()
                FROM app.visible_coach_briefings
                WHERE user_id = ? AND date = ? AND status = 'ok'
                ORDER BY id DESC
                LIMIT 1
                """,
                [user_id, briefing_date or athlete_today()],
            ).fetchone()
        finally:
            if con is None:
                conn.close()
        if row is None:
            return None
        return replace(
            _row_to_briefing(row), revised=bool(row[12]), first_created_at=row[13]
        )

    def get(self, briefing_id: int) -> Briefing | None:
        """One of the athlete's usable briefings, whatever its day."""
        with db_connection() as conn:
            row = conn.execute(
                f"SELECT {_COLUMNS} FROM app.visible_coach_briefings"
                " WHERE id = ? AND status = 'ok'",
                [briefing_id],
            ).fetchone()
        return _row_to_briefing(row) if row else None

    def history(self, before: date, limit: int = HISTORY_LIMIT) -> list[Briefing]:
        """The athlete's previous days, newest first: each day's usable briefing."""
        with db_connection() as conn:
            rows = conn.execute(
                f"""
                SELECT {_COLUMNS} FROM app.visible_coach_briefings
                WHERE status = 'ok' AND date < ?
                QUALIFY row_number() OVER (
                    PARTITION BY date ORDER BY id DESC
                ) = 1
                ORDER BY date DESC
                LIMIT ?
                """,
                [before, min(limit, HISTORY_LIMIT)],
            ).fetchall()
        return [_row_to_briefing(row) for row in rows]

    def react(
        self, briefing_id: int, reaction: Reaction | None, comment: str | None
    ) -> Briefing:
        """Set the athlete's reaction to a briefing; None clears it.

        One per briefing (it lives on the row) and idempotent: sending the
        same reaction again leaves the same state. LookupError when the
        briefing is not one of the athlete's usable briefings.
        """
        assert reaction is not None or comment is None, "A comment needs a reaction"
        with db_connection() as conn:
            row = conn.execute(
                f"""
                UPDATE app.coach_briefings
                SET reaction = $reaction, reaction_comment = $comment,
                    reacted_at = CASE
                        WHEN $reaction IS NULL THEN NULL
                        -- The same answer again changes nothing, not even its time.
                        WHEN reaction IS NOT DISTINCT FROM $reaction
                         AND reaction_comment IS NOT DISTINCT FROM $comment
                        THEN reacted_at
                        ELSE $at
                    END
                WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL
                  AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL)
                  AND id = $id AND status = 'ok'
                RETURNING {_COLUMNS}
                """,
                {
                    "reaction": reaction,
                    "comment": comment,
                    "id": briefing_id,
                    "at": naive_utc_now(),
                },
            ).fetchone()
        if row is None:
            raise LookupError("Briefing introuvable")
        return _row_to_briefing(row)

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
                WHERE user_id = ? AND status <> 'pending'
                ORDER BY date DESC, id DESC
                LIMIT ?
                """,
                [user_id, limit],
            ).fetchall()
        finally:
            conn.close()
        return [_row_to_briefing(row) for row in rows]

    def claim(
        self,
        briefing_date: date,
        *,
        trigger: str,
        expiry: timedelta,
        user_id: int | None = None,
    ) -> tuple[int, bool] | None:
        """Mark the day's briefing as being produced; None while a run holds it.

        The marker is what keeps two instances from paying for the same
        briefing: the in-process lock only covers one. The flag is True when
        an expired marker was replaced: its run was stopped before it stored
        anything. Two instances claiming within the same few milliseconds can
        still both succeed (no unique key), at worst one extra model request.
        """
        user_id = resolve_athlete_id(user_id)
        # Naive UTC, like the scheduler's markers and every briefing's time.
        now = naive_utc_now()
        try:
            with transaction() as conn:
                held = conn.execute(
                    """
                    SELECT id, created_at FROM app.visible_coach_briefings
                    WHERE user_id = ? AND date = ? AND status = 'pending'
                    """,
                    [user_id, briefing_date],
                ).fetchall()
                if any(now - created < expiry for _, created in held):
                    return None
                for claim_id, _ in held:
                    self._release(conn, claim_id)
                row = conn.execute(
                    """
                    INSERT INTO app.coach_briefings
                        (user_id, date, text, priority, source, status, trigger,
                         created_at)
                    VALUES (?, ?, '', 'info', 'agent', 'pending', ?, ?)
                    RETURNING id
                    """,
                    [user_id, briefing_date, trigger, now],
                ).fetchone()
        except duckdb.TransactionException:
            return None  # another instance replaced the same expired marker
        assert row is not None
        return int(row[0]), bool(held)

    def release(self, claim_id: int) -> None:
        """Drop a run's marker once its outcome is stored (or it failed)."""
        with db_connection() as conn:
            self._release(conn, claim_id)

    @staticmethod
    def _release(conn: duckdb.DuckDBPyConnection, claim_id: int) -> None:
        conn.execute(
            "DELETE FROM app.coach_briefings WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND (id = ? AND status = 'pending')",
            [claim_id],
        )

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


MAX_PENDING_GARMIN_FEEDBACK = 20
#: Activities the daily feedback reads: Garmin's and imported files.
FEEDBACK_SOURCES = (
    ActivitySource.GARMIN_CONNECT.value,
    *sorted(source.value for source in FILE_SOURCES),
)
FEEDBACK_IMPORT_LOOKBACK_DAYS = 30


class SessionFeedbackRepository:
    """``app.session_feedback``: one row per cardio session, the latest wins."""

    def pending_garmin(self) -> tuple[list[int], int]:
        """Daily catch-up: 20 recent imports, independent of the activity date.

        Garmin's and imported files' (any watch). On-use refresh deliberately
        does not write feedback. Missing feedback is its durable queue; a
        30-day import window avoids announcing ancient historical rows when
        this behavior is first enabled.
        """
        with db_connection() as conn:
            rows = conn.execute(
                "SELECT a.id, COUNT(*) OVER () FROM app.visible_actual_sessions a "
                "LEFT JOIN app.visible_session_feedback f ON f.actual_session_id=a.id "
                f"WHERE a.source IN ({sql_in(FEEDBACK_SOURCES)}) "
                "AND f.actual_session_id IS NULL "
                "AND a.created_at >= current_timestamp - ? * INTERVAL '1 day' "
                "ORDER BY a.created_at, a.id LIMIT ?",
                [FEEDBACK_IMPORT_LOOKBACK_DAYS, MAX_PENDING_GARMIN_FEEDBACK],
            ).fetchall()
        return [int(row[0]) for row in rows], int(rows[0][1]) if rows else 0

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
