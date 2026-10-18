"""Erase the signed-in athlete for good: rows, account, files (ARE-128).

Physical deletion, unlike an administrator's deactivation. The walk covers
every private relation ``dataio.tenant_schema`` declares (each with the
children that inherit its owner, one transaction per family), soft-deleted
rows included, then the athlete's files on disk, then the account tables in
one last transaction that also writes the erasure log: the day and a one-way
hash of each login's Clerk id, nothing else.

It acts on the trusted athlete scope only. Requests already running, and
other instances within the account cache's bound, cannot be revoked: a write
they finish afterwards lands under an id no login maps to any more. The
caller deletes the Clerk users afterwards (``api/auth.py``).
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Iterator
from pathlib import Path

from arete.config import config
from arete.dataio.db import db_connection, transaction
from arete.dataio.mirror import MIRRORED_DIRS, MIRRORED_FILES
from arete.dataio.tenant_schema import PARENTS, PRIVATE_TABLES, owner_column
from arete.garmin.token_store import ACCOUNT_FILE, TOKEN_FILE
from arete.services.athlete_scope import current_athlete_id
from arete.services.memory import memory_root
from arete.services.users import OWNER_ATHLETE_ID, AccountError, account_hash

logger = logging.getLogger(__name__)

LAST_ADMIN_DETAIL = (
    "Tu es le seul administrateur de cette instance : nomme un autre "
    "administrateur avant de supprimer ton compte."
)


def table_groups() -> list[tuple[str, ...]]:
    """Each private root relation with the relations inheriting its owner."""
    children: dict[str, list[str]] = {}
    for child, (_, parent, _) in PARENTS.items():
        children.setdefault(parent, []).append(child)

    def family(table: str) -> Iterator[str]:
        yield table
        for child in sorted(children.get(table, ())):
            yield from family(child)

    groups = [tuple(family(t)) for t in PRIVATE_TABLES if t not in PARENTS]
    covered = [table for group in groups for table in group]
    assert sorted(covered) == sorted(PRIVATE_TABLES), "a private relation is missed"
    return groups


def athlete_paths(athlete_id: int) -> list[Path]:
    """Where the athlete's files live on this instance's disk (scope set).

    Another athlete's directory is theirs alone. Athlete 1's is the storage
    root itself, which holds the local database and the others' directories:
    only the paths the application writes for an athlete go.
    """
    root = config.data_dir
    if athlete_id != OWNER_ATHLETE_ID:
        assert root != config.storage_root, "an athlete directory is never the root"
        return [root]
    paths = [root / name for name in (*MIRRORED_DIRS, *MIRRORED_FILES)]
    # ARETE_GARMIN_TOKENS_DIR may name a directory of the host: its files only.
    tokens = [config.garmin_tokens_dir / name for name in (TOKEN_FILE, ACCOUNT_FILE)]
    return [*paths, *tokens, config.fit_dir, memory_root()]


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _logins(athlete_id: int) -> list[str]:
    """The athlete's Clerk logins; refused while it is the last administrator."""
    with db_connection() as con:
        rows = con.execute(
            "SELECT clerk_user_id, coalesce(role, 'athlete') FROM app.users "
            "WHERE athlete_id=?",
            [athlete_id],
        ).fetchall()
        administrator = athlete_id == OWNER_ATHLETE_ID or any(
            role == "admin" for _, role in rows
        )
        if administrator:
            # The owner is administrator by right: any live login of athlete 1.
            other = con.execute(
                "SELECT 1 FROM app.users u JOIN app.athletes a ON a.id=u.athlete_id "
                "WHERE u.athlete_id<>? AND u.deleted_at IS NULL AND a.deleted_at IS NULL "
                "AND (u.athlete_id=? OR u.role='admin') LIMIT 1",
                [athlete_id, OWNER_ATHLETE_ID],
            ).fetchone()
            if other is None:
                raise AccountError(LAST_ADMIN_DETAIL)
    return [str(row[0]) for row in rows]


def erase_current_athlete() -> list[str]:
    """Erase the scoped athlete; returns its Clerk logins, for the caller to delete.

    Idempotent: a failure part-way leaves the account signed in, and running
    it again finishes the job. Raises ``AccountError`` before any deletion
    when the athlete is the instance's last administrator.
    """
    athlete_id = current_athlete_id()
    logins = _logins(athlete_id)
    for group in table_groups():
        with transaction() as con:
            for table in group:
                con.execute(
                    f"DELETE FROM app.{table} WHERE {owner_column(table)}=?",
                    [athlete_id],
                )
    for path in athlete_paths(athlete_id):
        _remove(path)
    marks = ",".join("?" * len(logins)) or "NULL"
    with transaction() as con:
        con.execute(
            f"DELETE FROM app.slack_identities WHERE athlete_id=? OR account_id IN ({marks})",
            [athlete_id, *logins],
        )
        for table in ("slack_private_threads", "slack_operations"):
            con.execute(
                f"DELETE FROM app.{table} WHERE account_id IN ({marks})", logins
            )
        con.execute("DELETE FROM app.slack_athletes WHERE athlete_id=?", [athlete_id])
        con.execute("DELETE FROM app.users WHERE athlete_id=?", [athlete_id])
        con.execute("DELETE FROM app.athletes WHERE id=?", [athlete_id])
        for login in logins:
            con.execute(
                "INSERT INTO app.account_deletions (account_hash, deleted_on) "
                "VALUES (?, current_date) ON CONFLICT DO NOTHING",
                [account_hash(login)],
            )
    logger.info("Erased an athlete and %d login(s)", len(logins))
    return logins
