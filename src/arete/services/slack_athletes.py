"""Which athlete a Slack author is, and that athlete's Slack preferences.

Identity follows sign-in: a Slack profile email resolves to an athlete only
through a verified Arete login (or the operator's owner addresses), never
through a Slack-side claim alone. ``app.users`` and ``app.slack_athletes`` are
global tables keyed by athlete, read before any scope exists; every write here
is limited to the trusted current athlete.
"""

from __future__ import annotations

import time

import duckdb

from arete.config import config
from arete.dataio.db import db_connection
from arete.services.athlete_scope import current_athlete_id
from arete.services.users import OWNER_ATHLETE_ID


def athlete_for_email(email: str) -> int | None:
    """The single active athlete behind a verified address, else None."""
    email = email.strip().lower()
    if not email:
        return None
    with db_connection() as con:
        rows = con.execute(
            "SELECT DISTINCT u.athlete_id FROM app.users u "
            "JOIN app.athletes a ON a.id = u.athlete_id "
            "WHERE lower(u.email) = ? AND u.email_verified_at IS NOT NULL "
            "AND u.deleted_at IS NULL AND a.deleted_at IS NULL",
            [email],
        ).fetchall()
    athletes = {int(r[0]) for r in rows}
    if email in config.owner_emails:
        athletes.add(OWNER_ATHLETE_ID)
    # Two athletes behind one address is ambiguous: refuse rather than guess.
    return athletes.pop() if len(athletes) == 1 else None


def public_replies() -> bool:
    with db_connection() as con:
        row = con.execute(
            "SELECT public_replies FROM app.slack_athletes WHERE athlete_id = ?",
            [current_athlete_id()],
        ).fetchone()
    return bool(row and row[0])


def set_public_replies(enabled: bool) -> bool:
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.slack_athletes (athlete_id, public_replies) VALUES (?, ?) "
            "ON CONFLICT (athlete_id) DO UPDATE SET public_replies = EXCLUDED.public_replies RETURNING athlete_id",
            [current_athlete_id(), enabled],
        )
    return enabled


def ensure_row(athlete_id: int) -> None:
    """Create the athlete's row on its own, so reservations only ever update it.

    Two first messages can insert at once; the loser's conflict means the row
    exists or is about to, so retry the idempotent insert briefly.
    """
    for attempt in range(5):
        try:
            with db_connection() as con:
                con.execute(
                    "INSERT INTO app.slack_athletes (athlete_id) VALUES (?) "
                    "ON CONFLICT DO NOTHING",
                    [athlete_id],
                )
            return
        except (duckdb.TransactionException, duckdb.ConstraintException):
            if attempt == 4:
                raise
            time.sleep(0.05 * (attempt + 1))
