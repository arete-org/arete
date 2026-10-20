"""Login accounts, retained contact details and private athlete provisioning.

Roles: the owner (athlete 1) administers the instance by right and alone
names administrators, who see every athlete's state and can deactivate,
reactivate or unblock one. Every other account is an athlete.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from arete.config import config
from arete.dataio.db import connect
from arete.services import consent

logger = logging.getLogger(__name__)

OWNER_ATHLETE_ID = 1
ROLES = ("athlete", "admin")
_COLUMNS = (
    "id, clerk_user_id, email, name, athlete_id, email_verified_at, "
    "profile_synced_at, deleted_at, coalesce(role, 'athlete')"
)
#: The same columns, qualified for a query that joins ``app.athletes``.
_JOINED_COLUMNS = (
    "u.id, u.clerk_user_id, u.email, u.name, u.athlete_id, u.email_verified_at, "
    "u.profile_synced_at, u.deleted_at, coalesce(u.role, 'athlete')"
)


class AccountError(Exception):
    """An administration rule refused the action; ``status`` is its HTTP answer."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class AppUser:
    id: int
    clerk_user_id: str
    email: str
    name: str | None
    athlete_id: int | None
    email_verified_at: datetime | None = None
    profile_synced_at: datetime | None = None
    deleted_at: datetime | None = None
    role: str = "athlete"

    @property
    def is_owner(self) -> bool:
        return self.athlete_id == OWNER_ATHLETE_ID

    @property
    def is_admin(self) -> bool:
        return self.is_owner or self.role == "admin"

    def to_dict(self) -> dict:
        return {
            "email": self.email,
            "name": self.name,
            "athlete_id": self.athlete_id,
            "is_owner": self.is_owner,
            "role": self.role,
            "is_admin": self.is_admin,
        }


#: What scripts and the MCP server act as, with the API key: the athlete.
API_KEY_USER = AppUser(
    id=0, clerk_user_id="api-key", email="", name="API key", athlete_id=OWNER_ATHLETE_ID
)


def owner_emails() -> frozenset[str]:
    """The addresses that are the athlete: the environment first, then Settings."""
    if config.owner_emails:
        return frozenset(config.owner_emails)
    con = connect()
    try:
        row = con.execute(
            "SELECT email FROM app.user_settings WHERE user_id = 1"
        ).fetchone()
    finally:
        con.close()
    value = str(row[0] or "").strip().lower() if row else ""
    return frozenset({value}) if value else frozenset()


def _from_row(row: tuple) -> AppUser:
    return AppUser(*row)


def account_hash(clerk_user_id: str) -> str:
    """The erasure log's only identifier: Clerk ids are random, not guessable."""
    return hashlib.sha256(clerk_user_id.encode()).hexdigest()


def was_deleted(clerk_user_id: str) -> bool:
    """Whether this login erased its account: it gets no fresh athlete."""
    con = connect()
    try:
        row = con.execute(
            "SELECT 1 FROM app.account_deletions WHERE account_hash=?",
            [account_hash(clerk_user_id)],
        ).fetchone()
    finally:
        con.close()
    return row is not None


def get_user(clerk_user_id: str) -> AppUser | None:
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.users WHERE clerk_user_id = ?", [clerk_user_id]
        ).fetchone()
    finally:
        con.close()
    return _from_row(row) if row else None


def get_account(clerk_user_id: str) -> tuple[AppUser, bool, bool] | None:
    """The login, whether its athlete is live and whether the athlete's
    consent is in force (``services/consent.py``), in one query; None if unknown.

    The live flag is False for a deactivated or missing athlete, and True for a
    login with no athlete yet (nothing to deactivate).
    """
    consented, params = consent.in_force_sql("u.athlete_id")
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_JOINED_COLUMNS}, u.athlete_id IS NULL OR "
            "(a.id IS NOT NULL AND a.deleted_at IS NULL), "
            f"{consented} "
            "FROM app.users u LEFT JOIN app.athletes a ON a.id = u.athlete_id "
            "WHERE u.clerk_user_id = ?",
            [*params, clerk_user_id],
        ).fetchone()
    finally:
        con.close()
    return (_from_row(row[:-2]), bool(row[-2]), bool(row[-1])) if row else None


def upsert_user(
    clerk_user_id: str, email: str, name: str | None = None, *, verified: bool = False
) -> AppUser:
    """Atomically provision a private athlete; never infer ownership from unverified mail."""
    email = email.strip().lower()
    now = datetime.now()
    legacy_owner = verified and email in owner_emails()
    con = connect()
    try:
        con.execute("BEGIN TRANSACTION")
        con.execute(
            "INSERT INTO app.users (clerk_user_id,email,name,email_verified_at,profile_synced_at) "
            "VALUES (?,?,?,?,?) ON CONFLICT (clerk_user_id) DO UPDATE SET "
            "email=EXCLUDED.email,name=coalesce(EXCLUDED.name,app.users.name), "
            "email_verified_at=EXCLUDED.email_verified_at,profile_synced_at=EXCLUDED.profile_synced_at, "
            "last_seen_at=EXCLUDED.profile_synced_at RETURNING id",
            [clerk_user_id, email, name, now if verified else None, now],
        )
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.users WHERE clerk_user_id=?", [clerk_user_id]
        ).fetchone()
        assert row is not None
        user = _from_row(row)
        if user.athlete_id is None and user.deleted_at is None:
            if legacy_owner and _owner_held_by_another_address(con, email):
                # An owner address listed for someone else must not hand them
                # the original athlete's data and credentials: they get theirs.
                logger.warning(
                    "%s is an owner address, but athlete 1 belongs to another "
                    "account: provisioning a new athlete",
                    email,
                )
                legacy_owner = False
            athlete_id = OWNER_ATHLETE_ID
            if not legacy_owner:
                created = con.execute(
                    "INSERT INTO app.athletes(id) VALUES(nextval('app.athletes_seq')) RETURNING id"
                ).fetchone()
                assert created is not None
                athlete_id = int(created[0])
            con.execute(
                "UPDATE app.users SET athlete_id=? WHERE clerk_user_id=? RETURNING id",
                [athlete_id, clerk_user_id],
            )
            # Fresh accounts start empty; only defaults are shared with the
            # original athlete, never their preferences, files or credentials.
            con.execute(
                "INSERT INTO app.user_settings(user_id,display_name,email) VALUES(?,?,?) ON CONFLICT DO NOTHING",
                [athlete_id, name or "Athlète", email],
            )
            for statement in (
                "INSERT INTO app.game_profile(id,athlete_id) VALUES(1,?) ON CONFLICT DO NOTHING",
                "INSERT INTO app.game_owned(skin,athlete_id) VALUES('base',?) ON CONFLICT DO NOTHING",
                "INSERT INTO app.document_quota(id,used_bytes,athlete_id) VALUES(1,0,?) ON CONFLICT DO NOTHING",
            ):
                con.execute(statement, [athlete_id])
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.users WHERE clerk_user_id=?", [clerk_user_id]
        ).fetchone()
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()
    assert row is not None
    return _from_row(row)


def _owner_held_by_another_address(con: Any, email: str) -> bool:
    """Athlete 1 is claimed once: later claims must come from the same address."""
    holders = con.execute(
        "SELECT email FROM app.users WHERE athlete_id=? AND deleted_at IS NULL",
        [OWNER_ATHLETE_ID],
    ).fetchall()
    return any(str(row[0]).strip().lower() != email for row in holders)


def athlete_is_active(athlete_id: int) -> bool:
    con = connect()
    try:
        return (
            con.execute(
                "SELECT 1 FROM app.athletes WHERE id=? AND deleted_at IS NULL",
                [athlete_id],
            ).fetchone()
            is not None
        )
    finally:
        con.close()


def list_users() -> list[AppUser]:
    con = connect()
    try:
        rows = con.execute(f"SELECT {_COLUMNS} FROM app.users ORDER BY id").fetchall()
    finally:
        con.close()
    return [_from_row(r) for r in rows]


@dataclass(frozen=True)
class AthleteAccount:
    """An athlete and one of its logins; an athlete may have none or several."""

    athlete_id: int
    user_id: int | None
    email: str | None
    name: str | None
    role: str
    last_seen_at: datetime | None
    last_sync_at: datetime | None
    sync_lease_until: datetime | None
    lease_stuck: bool
    deactivated_at: datetime | None

    @property
    def is_owner(self) -> bool:
        return self.athlete_id == OWNER_ATHLETE_ID

    def to_dict(self) -> dict:
        # Stored timestamps are the server's local time: say which one. The
        # scheduler stores its daily marker and lease in UTC.
        def aware(value: datetime | None) -> datetime | None:
            return value.astimezone() if value is not None else None

        def utc(value: datetime | None) -> datetime | None:
            return value.replace(tzinfo=UTC) if value is not None else None

        return {
            "athlete_id": self.athlete_id,
            "user_id": self.user_id,
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "is_owner": self.is_owner,
            "last_seen_at": aware(self.last_seen_at),
            "last_sync_at": utc(self.last_sync_at),
            "sync_lease_until": utc(self.sync_lease_until),
            "lease_stuck": self.lease_stuck,
            "deactivated_at": aware(self.deactivated_at),
        }


def list_accounts() -> list[AthleteAccount]:
    """Every athlete with its logins, for administrators; no private data.

    ``last_seen_at`` moves with the hourly profile refresh. A lease past its
    expiry belongs to a scheduled run that failed or was stopped.
    """
    con = connect()
    try:
        rows = con.execute(
            "SELECT a.id, u.id, u.email, u.name, coalesce(u.role, 'athlete'), "
            "u.last_seen_at, a.last_sync_at, a.sync_lease_until, "
            "coalesce(a.sync_lease_until < (current_timestamp AT TIME ZONE 'UTC'), false), "
            "a.deleted_at "
            "FROM app.athletes a LEFT JOIN app.users u ON u.athlete_id = a.id "
            "ORDER BY a.id, u.id"
        ).fetchall()
    finally:
        con.close()
    return [AthleteAccount(*row) for row in rows]


def deactivate_athlete(athlete_id: int, *, actor: AppUser) -> None:
    """Close every login of the athlete; its data stays, hidden from everyone.

    Nobody deactivates the owner's athlete, and only the owner deactivates an
    administrator's (an administrator cannot lock themselves out either).
    """
    if athlete_id == OWNER_ATHLETE_ID:
        raise AccountError("L'athlète du propriétaire ne peut pas être désactivé.")
    con = connect()
    try:
        con.execute("BEGIN TRANSACTION")
        if (
            con.execute(
                "SELECT 1 FROM app.athletes WHERE id=?", [athlete_id]
            ).fetchone()
            is None
        ):
            raise AccountError("Athlète inconnu.", 404)
        administrator = con.execute(
            "SELECT 1 FROM app.users WHERE athlete_id=? AND deleted_at IS NULL "
            "AND role='admin' LIMIT 1",
            [athlete_id],
        ).fetchone()
        if administrator is not None and not actor.is_owner:
            raise AccountError(
                "Seul le propriétaire peut désactiver un administrateur.", 403
            )
        con.execute(
            "UPDATE app.athletes SET deleted_at=current_timestamp WHERE id=? AND deleted_at IS NULL RETURNING id",
            [athlete_id],
        )
        con.execute(
            "UPDATE app.users SET deleted_at=current_timestamp WHERE athlete_id=? AND deleted_at IS NULL RETURNING id",
            [athlete_id],
        )
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()


def reactivate_athlete(athlete_id: int) -> None:
    """Reopen the athlete and its logins; the data reappears as it was."""
    con = connect()
    try:
        con.execute("BEGIN TRANSACTION")
        row = con.execute(
            "UPDATE app.athletes SET deleted_at=NULL WHERE id=? RETURNING id",
            [athlete_id],
        ).fetchone()
        if row is None:
            raise AccountError("Athlète inconnu.", 404)
        con.execute(
            "UPDATE app.users SET deleted_at=NULL WHERE athlete_id=? RETURNING id",
            [athlete_id],
        )
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()


def set_role(user_id: int, role: str) -> AppUser:
    """The owner names or removes an administrator; the owner's own logins keep
    their right, which comes from the athlete, not from this column."""
    assert role in ROLES, f"Unknown role: {role}"
    con = connect()
    try:
        row = con.execute(
            f"SELECT {_COLUMNS} FROM app.users WHERE id=?", [user_id]
        ).fetchone()
        if row is None:
            raise AccountError("Compte inconnu.", 404)
        if _from_row(row).is_owner:
            raise AccountError("Le propriétaire est administrateur d'office.")
        updated = con.execute(
            f"UPDATE app.users SET role=? WHERE id=? RETURNING {_COLUMNS}",
            [role, user_id],
        ).fetchone()
    finally:
        con.close()
    assert updated is not None
    return _from_row(updated)
