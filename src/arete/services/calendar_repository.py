"""Durable connection preferences and one-shot actions, never chat history."""

import json
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta

import duckdb

from arete.dataio.db import db_connection, write_idempotent
from arete.services.calendar_models import (
    ACTION_TTL_SECONDS,
    MAX_ACTION_CHARS,
    MAX_PENDING_ACTIONS,
    CalendarError,
)

CALENDAR_DDL = """
CREATE TABLE IF NOT EXISTS app.calendar_connections (
    connection_key VARCHAR PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE,
    revision BIGINT NOT NULL DEFAULT 0, selection VARCHAR NOT NULL DEFAULT '{"readable":[],"writable":[]}',
    consent_hash VARCHAR, consent_expires DOUBLE
);
CREATE TABLE IF NOT EXISTS app.calendar_actions (
    id VARCHAR PRIMARY KEY, connection_key VARCHAR NOT NULL,
    revision BIGINT NOT NULL, thread_id VARCHAR NOT NULL,
    payload VARCHAR NOT NULL, status VARCHAR NOT NULL,
    expires DOUBLE NOT NULL, updated DOUBLE NOT NULL,
    result VARCHAR NOT NULL DEFAULT '{}'
);
"""
#: Migration 34: the training plan followed into one writable calendar. The
#: connection keeps the Clerk user id the daily cron rebuilds the provider
#: from (no signed-in user there), and each synced session its own event.
PLAN_SYNC_DDL = """
ALTER TABLE app.calendar_connections ADD COLUMN IF NOT EXISTS clerk_user_id VARCHAR;
ALTER TABLE app.calendar_connections ADD COLUMN IF NOT EXISTS plan_sync BOOLEAN DEFAULT FALSE;
ALTER TABLE app.calendar_connections ADD COLUMN IF NOT EXISTS plan_calendar VARCHAR;
ALTER TABLE app.calendar_connections ADD COLUMN IF NOT EXISTS plan_synced_at DOUBLE;
ALTER TABLE app.calendar_connections ADD COLUMN IF NOT EXISTS plan_error VARCHAR;
ALTER TABLE app.calendar_connections ADD COLUMN IF NOT EXISTS plan_requested BOOLEAN DEFAULT FALSE;
ALTER TABLE app.calendar_connections ADD COLUMN IF NOT EXISTS plan_lease DOUBLE;
ALTER TABLE app.planned_sessions ADD COLUMN IF NOT EXISTS google_event_id VARCHAR;
ALTER TABLE app.planned_sessions ADD COLUMN IF NOT EXISTS google_calendar_id VARCHAR;
ALTER TABLE app.planned_sessions ADD COLUMN IF NOT EXISTS google_event_etag VARCHAR;
ALTER TABLE app.planned_sessions ADD COLUMN IF NOT EXISTS google_event_hash VARCHAR;
"""

#: The planned-session fields an event is built from, then its sync state.
PLAN_SESSION_COLUMNS = (
    "id, date, sport, session_type, target_duration_min, target_distance_km, "
    "target_intensity, description, coalesce(status, 'pending'), "
    "google_event_id, google_calendar_id, google_event_etag, google_event_hash"
)


def now() -> float:
    return datetime.now(UTC).timestamp()


class CalendarRepository:
    def __init__(self, key: str):
        self.key = key

    @contextmanager
    def transaction(self):
        try:
            with db_connection() as con:
                con.execute("BEGIN TRANSACTION")
                try:
                    con.execute(
                        "INSERT INTO app.calendar_connections (connection_key) VALUES (?) ON CONFLICT DO NOTHING",
                        [self.key],
                    )
                    # Serialize decisions/settings across workers through an MVCC row write.
                    con.execute(
                        "UPDATE app.calendar_connections SET revision = revision WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ?) RETURNING connection_key",
                        [self.key],
                    )
                    yield con
                    con.execute("COMMIT")
                except BaseException:
                    con.execute("ROLLBACK")
                    raise
        except duckdb.TransactionException as exc:
            raise CalendarError(
                "Une autre opération Calendar est en cours. Actualise son état.", 409
            ) from exc

    def state(self) -> dict:
        with db_connection() as con:
            row = con.execute(
                "SELECT enabled, revision, selection FROM app.visible_calendar_connections WHERE connection_key = ?",
                [self.key],
            ).fetchone()
        return {
            "enabled": bool(row and row[0]),
            "revision": row[1] if row else 0,
            "selection": json.loads(row[2])
            if row
            else {"readable": [], "writable": []},
        }

    def configure(
        self, *, enabled: bool, selection: dict, expected_revision: int | None = None
    ) -> None:
        with self.transaction() as con:
            if expected_revision is not None:
                row = con.execute(
                    "SELECT revision FROM app.visible_calendar_connections WHERE connection_key = ?",
                    [self.key],
                ).fetchone()
                if row[0] != expected_revision:
                    raise CalendarError(
                        "Connexion modifiée pendant l’opération. Recommence.", 409
                    )
            con.execute(
                "UPDATE app.calendar_connections SET enabled = ?, selection = ?, revision = revision + 1, consent_hash = NULL, consent_expires = NULL WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ?) RETURNING connection_key",
                [enabled, json.dumps(selection), self.key],
            )
            con.execute(
                "UPDATE app.calendar_actions SET status = 'invalidated', updated = ? WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ? AND status = 'pending') RETURNING id",
                [now(), self.key],
            )

    def add(self, action_id: str, revision: int, thread_id: str, payload: dict) -> None:
        if len(json.dumps(payload, ensure_ascii=False)) > MAX_ACTION_CHARS:
            raise CalendarError(
                "Événement trop volumineux pour une validation complète.", 413
            )
        with self.transaction() as con:
            state = con.execute(
                "SELECT enabled, revision FROM app.visible_calendar_connections WHERE connection_key = ?",
                [self.key],
            ).fetchone()
            if not state or not state[0] or state[1] != revision:
                raise CalendarError(
                    "Connexion ou permissions modifiées. Recommence la proposition.",
                    409,
                )
            count = con.execute(
                "SELECT COUNT(*) FROM app.visible_calendar_actions WHERE connection_key = ? AND status = 'pending' AND expires > ?",
                [self.key, now()],
            ).fetchone()[0]
            if count >= MAX_PENDING_ACTIONS:
                raise CalendarError("Trop de propositions Calendar en attente.", 429)
            # Keep a bounded time horizon for sensitive event snapshots.
            con.execute(
                "DELETE FROM app.calendar_actions WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ? AND updated < ?) ",
                [self.key, now() - timedelta(days=30).total_seconds()],
            )
            con.execute(
                "INSERT INTO app.calendar_actions (id, connection_key, revision, thread_id, payload, status, expires, updated) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
                [
                    action_id,
                    self.key,
                    revision,
                    thread_id,
                    json.dumps(payload),
                    now() + ACTION_TTL_SECONDS,
                    now(),
                ],
            )

    def get(self, action_id: str) -> dict:
        with db_connection() as con:
            row = con.execute(
                "SELECT id, thread_id, payload, status, expires, updated, result, revision FROM app.visible_calendar_actions WHERE id = ? AND connection_key = ?",
                [action_id, self.key],
            ).fetchone()
        if row is None:
            raise CalendarError("Proposition introuvable.", 404)
        status = row[3]
        if status == "pending" and row[4] <= now():
            status = "expired"
        if status == "executing" and row[5] + 60 <= now():
            status = "uncertain"
        return {
            "id": row[0],
            "thread_id": row[1],
            **json.loads(row[2]),
            "status": status,
            "expires_at": datetime.fromtimestamp(row[4], UTC).isoformat(),
            "result": json.loads(row[6]),
            "revision": row[7],
        }

    def claim(self, action_id: str, decision: str) -> bool:
        with self.transaction() as con:
            row = con.execute(
                """UPDATE app.calendar_actions SET status = ?, updated = ?
                WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id = ? AND connection_key = ? AND status = 'pending' AND expires > ?
                AND revision = (SELECT revision FROM app.visible_calendar_connections WHERE connection_key = ? AND enabled)) RETURNING id""",
                [
                    "executing" if decision == "approve" else "rejected",
                    now(),
                    action_id,
                    self.key,
                    now(),
                    self.key,
                ],
            ).fetchone()
        return row is not None

    def finish(self, action_id: str, status: str, result: dict) -> None:
        with db_connection() as con:
            con.execute(
                "UPDATE app.calendar_actions SET status = ?, result = ?, updated = ? WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (id = ? AND connection_key = ? AND status IN ('executing', 'uncertain')) RETURNING id",
                [status, json.dumps(result), now(), action_id, self.key],
            )

    # ── Training plan sync (migration 34) ────────────────────────────────

    def event_prefix(self) -> str:
        """This connection's event ids: ``arete`` + key prefix + session id.

        Google accepts client ids in base32hex (a-v, 0-9); the key is hex.
        Choosing the id ourselves makes a create idempotent: a retry after a
        lost response finds the event instead of adding a second one.
        """
        return "arete" + self.key[:12]

    def plan_state(self) -> dict:
        with db_connection() as con:
            row = con.execute(
                "SELECT enabled, selection, coalesce(plan_sync, FALSE), plan_calendar, plan_synced_at, plan_error FROM app.visible_calendar_connections WHERE connection_key = ?",
                [self.key],
            ).fetchone()
            (events,) = con.execute(
                "SELECT count(*) FROM app.visible_planned_sessions WHERE starts_with(google_event_id, ?)",
                [self.event_prefix()],
            ).fetchone() or (0,)
        return {
            "connected": bool(row and row[0]),
            "writable": json.loads(row[1])["writable"] if row else [],
            "enabled": bool(row and row[2]),
            "calendar_id": row[3] if row else None,
            "synced_at": datetime.fromtimestamp(row[4], UTC).isoformat()
            if row and row[4]
            else None,
            "error": row[5] if row else None,
            "events": int(events),
        }

    def configure_plan(
        self,
        *,
        enabled: bool,
        calendar_id: str | None = None,
        clerk_user_id: str | None = None,
    ) -> None:
        with self.transaction() as con:
            if not enabled:
                con.execute(
                    "UPDATE app.calendar_connections SET plan_sync = FALSE WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ?) RETURNING connection_key",
                    [self.key],
                )
                return
            assert calendar_id and clerk_user_id, "Plan sync needs a target and account"
            # One plan, one follower: the events stored on sessions belong to it.
            others = con.execute(
                "SELECT count(*) FROM app.visible_calendar_connections WHERE plan_sync AND connection_key <> ?",
                [self.key],
            ).fetchone()[0]
            foreign = con.execute(
                "SELECT count(*) FROM app.visible_planned_sessions WHERE google_event_id IS NOT NULL AND NOT starts_with(google_event_id, ?)",
                [self.event_prefix()],
            ).fetchone()[0]
            if others or foreign:
                raise CalendarError(
                    "Le plan est déjà synchronisé par un autre compte ou environnement : désactive-le là-bas et retire ses événements d’abord.",
                    409,
                )
            con.execute(
                "UPDATE app.calendar_connections SET plan_sync = TRUE, plan_calendar = ?, clerk_user_id = ?, plan_error = NULL WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ?) RETURNING connection_key",
                [calendar_id, clerk_user_id, self.key],
            )

    @staticmethod
    def plan_sync_accounts() -> list[tuple[str, str]]:
        """(connection key, Clerk user id) of every connection following the plan."""
        with db_connection() as con:
            rows = con.execute(
                "SELECT connection_key, clerk_user_id FROM app.visible_calendar_connections WHERE enabled AND plan_sync AND clerk_user_id IS NOT NULL"
            ).fetchall()
        return [(row[0], row[1]) for row in rows]

    def claim_plan_sync(self, seconds: float) -> bool:
        """Ask for a pass; take the lease unless another run holds it.

        The holder sees the request and runs one more pass, so a change
        written while it synced is not left behind. Both writes rerun on a
        conflict: the request sets the same value, the lease's condition
        re-reads it; one still conflicting after the reruns counts as busy.
        """
        try:
            write_idempotent(
                "UPDATE app.calendar_connections SET plan_requested = TRUE WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ?) RETURNING connection_key",
                [self.key],
            )
            row = write_idempotent(
                "UPDATE app.calendar_connections SET plan_lease = ? WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ? AND coalesce(plan_lease, 0) < ?) RETURNING 1",
                [now() + seconds, self.key, now()],
            )
        except duckdb.TransactionException:
            return False
        return bool(row)

    def begin_plan_pass(self) -> None:
        with db_connection() as con:
            con.execute(
                "UPDATE app.calendar_connections SET plan_requested = FALSE WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ?) RETURNING connection_key",
                [self.key],
            )

    def release_plan_sync(self, *, error: str | None, force: bool) -> bool:
        """Record the outcome and free the lease; False when a pass is owed.

        Rerun on a conflict: a request for another pass then fails the
        condition, any other writer leaves it to hold, and the lease is freed.
        """
        return bool(
            write_idempotent(
                "UPDATE app.calendar_connections SET plan_lease = NULL, plan_synced_at = ?, plan_error = ? WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (connection_key = ?) "
                + ("" if force else " AND NOT coalesce(plan_requested, FALSE)")
                + " RETURNING 1",
                [now(), error, self.key],
            )
        )

    @staticmethod
    def timezone() -> str:
        """The athlete's timezone setting, which dates the plan's events."""
        with db_connection() as con:
            row = con.execute(
                "SELECT timezone FROM app.visible_user_settings WHERE user_id = getvariable('arete_athlete_id')"
            ).fetchone()
        return row[0] if row and row[0] else "Europe/Paris"

    def plan_sessions(self, start: date, end: date, recent: date) -> list[tuple]:
        """Sessions to show from ``start`` to ``end``, then every other one
        still holding this connection's event (completed ones only from
        ``recent``: older ones simply keep theirs)."""
        with db_connection() as con:
            rows = con.execute(
                f"""SELECT {PLAN_SESSION_COLUMNS} FROM app.visible_planned_sessions
                WHERE (date BETWEEN ? AND ? AND coalesce(status, 'pending') IN ('pending', 'modified'))
                OR (starts_with(google_event_id, ?) AND (coalesce(status, 'pending') <> 'completed' OR date >= ?))
                ORDER BY date, id""",
                [start, end, self.event_prefix(), recent],
            ).fetchall()
        return rows

    def session_statuses(self, ids: list[int]) -> dict[int, str]:
        if not ids:
            return {}
        with db_connection() as con:
            rows = con.execute(
                "SELECT id, coalesce(status, 'pending') FROM app.visible_planned_sessions WHERE list_contains(?, id)",
                [ids],
            ).fetchall()
        return {row[0]: row[1] for row in rows}

    def synced_events(self) -> list[tuple[int, str, str]]:
        """(session id, event id, calendar id) of every event still recorded."""
        with db_connection() as con:
            rows = con.execute(
                "SELECT id, google_event_id, google_calendar_id FROM app.visible_planned_sessions WHERE starts_with(google_event_id, ?) ORDER BY date, id",
                [self.event_prefix()],
            ).fetchall()
        return [(row[0], row[1], row[2]) for row in rows]

    def record_event(
        self,
        session_id: int,
        calendar_id: str | None,
        event_id: str | None,
        etag: str | None,
        digest: str | None,
    ) -> None:
        """What Google holds for a session; all ``None`` forgets the event."""
        with db_connection() as con:
            con.execute(
                "UPDATE app.planned_sessions SET google_calendar_id = ?, google_event_id = ?, google_event_etag = ?, google_event_hash = ? WHERE user_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=user_id AND scope_owner.deleted_at IS NULL) AND (id = ?) RETURNING id",
                [calendar_id, event_id, etag, digest, session_id],
            )
