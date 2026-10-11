"""Verified Slack identity; Slack roles never authorize Arete administration."""

from dataclasses import replace

from arete.config import config
from arete.dataio.db import db_connection, transaction
from arete.services import slack_athletes, users

MAX_IDENTITIES = 10_000


def account_for_email(email: str) -> users.AppUser | None:
    email = email.strip().lower()
    athlete = slack_athletes.athlete_for_email(email)
    if athlete is None or not users.athlete_is_active(athlete):
        return None
    with db_connection() as con:
        rows = con.execute(
            "SELECT clerk_user_id FROM app.users WHERE lower(email)=? "
            "AND email_verified_at IS NOT NULL AND deleted_at IS NULL LIMIT 2",
            [email],
        ).fetchall()
    if len(rows) == 1:
        actor = users.get_user(rows[0][0])
        if (
            actor
            and not actor.deleted_at
            and actor.email_verified_at
            and actor.athlete_id == athlete
        ):
            return actor
        return None
    if not rows and email in config.owner_emails:
        # Preserve the explicitly configured legacy owner, without inferring
        # ownership from a missing account or from an unverified address.
        return replace(
            users.API_KEY_USER, clerk_user_id="slack-owner:" + email, email=email
        )
    return None


def link(team: str, slack_user: str, email: str, timezone: str) -> None:
    actor = account_for_email(email)
    with transaction() as con:
        if actor is None:
            con.execute(
                "DELETE FROM app.slack_identities WHERE team_id=? AND slack_user_id=?",
                [team, slack_user],
            )
            return
        existing = con.execute(
            "SELECT 1 FROM app.slack_identities WHERE team_id=? AND slack_user_id=?",
            [team, slack_user],
        ).fetchone()
        count = con.execute("SELECT count(*) FROM app.slack_identities").fetchone()
        assert count is not None
        if not existing and count[0] >= MAX_IDENTITIES:
            raise ValueError("Annuaire Slack plein ; intervention requise.")
        con.execute(
            "INSERT INTO app.slack_identities (team_id,slack_user_id,email,account_id,athlete_id,timezone) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT (team_id,slack_user_id) DO UPDATE SET "
            "email=EXCLUDED.email,account_id=EXCLUDED.account_id,athlete_id=EXCLUDED.athlete_id,"
            "timezone=EXCLUDED.timezone,verified_at=now()",
            [
                team,
                slack_user,
                actor.email,
                actor.clerk_user_id,
                actor.athlete_id,
                timezone,
            ],
        )


def identity(team: str, slack_user: str) -> tuple[users.AppUser, str] | None:
    with db_connection() as con:
        row = con.execute(
            "SELECT email,account_id,athlete_id,timezone FROM app.slack_identities "
            "WHERE team_id=? AND slack_user_id=?",
            [team, slack_user],
        ).fetchone()
    if row is None:
        return None
    actor = account_for_email(row[0])
    if actor is None or (actor.clerk_user_id, actor.athlete_id) != (row[1], row[2]):
        return None
    return actor, row[3]


def require_admin(team: str, slack_user: str, account_id: str) -> users.AppUser:
    resolved = identity(team, slack_user)
    if (
        resolved is None
        or not resolved[0].is_admin
        or resolved[0].clerk_user_id != account_id
    ):
        raise PermissionError(
            "Cette opération est réservée aux administrateurs Arete actifs."
        )
    return resolved[0]


def private_owner(thread_id: str) -> str | None:
    with db_connection() as con:
        row = con.execute(
            "SELECT account_id FROM app.slack_private_threads WHERE thread_id=?",
            [thread_id],
        ).fetchone()
    return row[0] if row else None


def mark_private(thread_id: str, account_id: str) -> None:
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.slack_private_threads VALUES (?,?) ON CONFLICT DO NOTHING",
            [thread_id, account_id],
        )
    assert private_owner(thread_id) == account_id, "Private thread owner cannot change"
