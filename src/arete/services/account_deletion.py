"""Erase the signed-in athlete for good: files, rows, account (ARE-128).

Physical deletion, unlike an administrator's deactivation. One transaction
deletes every row of every private relation ``dataio.tenant_schema``
declares (soft-deleted rows included), the account rows, and writes the
erasure log: the day and a one-way hash of each login's Clerk id, nothing
else. It keeps the request within a handful of database round trips and makes
a failure leave the account whole, signed in, for a retry to finish the job.
The athlete's directory goes after the commit, best effort.

The owner's athlete is never erased here: the instance keeps its owner, who
administers it by right (``services/users.py``).

It acts on the trusted athlete scope only. Requests already running, and
other instances within the account cache's bound, cannot be revoked: a write
they finish afterwards lands under an id no login maps to any more. The
caller deletes the Clerk users afterwards (``api/auth.py``).
"""

from __future__ import annotations

import logging
import shutil

from arete.config import config
from arete.dataio.db import transaction
from arete.dataio.tenant_schema import PRIVATE_TABLES, owner_column
from arete.services.athlete_scope import current_athlete_id
from arete.services.users import OWNER_ATHLETE_ID, AccountError, account_hash

logger = logging.getLogger(__name__)

OWNER_DETAIL = (
    "Le compte propriétaire ne peut pas être supprimé depuis l'application : "
    "l'instance resterait sans propriétaire. Sa suppression se fait à la main, "
    "par l'opérateur de l'instance."
)
#: Account rows keyed by the athlete, erased with its private relations.
ATHLETE_ACCOUNT_TABLES = {
    "slack_identities": "athlete_id",
    "slack_athletes": "athlete_id",
    "users": "athlete_id",
    "athletes": "id",
}
#: Rows keyed by a login's Clerk id rather than by the athlete.
LOGIN_TABLES = ("slack_identities", "slack_private_threads", "slack_operations")


def _statements(athlete_id: int) -> str:
    """Every athlete-keyed deletion but the logins', as one script: one round
    trip, not sixty.

    The id is inlined, as an integer from the trusted scope, because a script
    of several statements takes no parameters.
    """
    assert type(athlete_id) is int and athlete_id > 0, "trusted athlete id"
    keyed = [(table, owner_column(table)) for table in PRIVATE_TABLES]
    keyed += [(t, c) for t, c in ATHLETE_ACCOUNT_TABLES.items() if t != "users"]
    return ";\n".join(
        f"DELETE FROM app.{table} WHERE {column}={athlete_id}"
        for table, column in keyed
    )


def _remove_files(athlete_id: int) -> None:
    """Best effort, once the rows are gone: a sync writing there may race it."""
    directory = config.data_dir
    assert directory != config.storage_root, "an athlete directory is never the root"
    try:
        if directory.is_dir():
            shutil.rmtree(directory)
    except OSError:
        try:
            left = sum(1 for path in directory.rglob("*") if path.is_file())
        except OSError:
            left = -1  # unknown: the directory changed while counting
        logger.exception(
            "Athlete %d erased, but %d file(s) remain in its directory",
            athlete_id,
            left,
        )


def erase_current_athlete() -> list[str]:
    """Erase the scoped athlete; returns its Clerk logins, for the caller to delete.

    Raises ``AccountError`` for the owner, before anything is touched. The
    database work is one transaction: a failure rolls it all back, files
    included since they go only after the commit, and a retry starts again.
    The logins are deleted, and returned, inside it: one attached meanwhile
    is erased, logged and handed to Clerk like the others.
    """
    athlete_id = current_athlete_id()
    if athlete_id == OWNER_ATHLETE_ID:
        raise AccountError(OWNER_DETAIL)
    with transaction() as con:
        logins = [
            str(row[0])
            for row in con.execute(
                "DELETE FROM app.users WHERE athlete_id=? RETURNING clerk_user_id",
                [athlete_id],
            ).fetchall()
        ]
        con.execute(_statements(athlete_id))
        marks = ",".join("?" * len(logins)) or "NULL"
        for table in LOGIN_TABLES:
            con.execute(
                f"DELETE FROM app.{table} WHERE account_id IN ({marks})", logins
            )
        if logins:
            con.executemany(
                "INSERT INTO app.account_deletions (account_hash, deleted_on) "
                "VALUES (?, current_date) ON CONFLICT DO NOTHING",
                [[account_hash(login)] for login in logins],
            )
    logger.info("Erased athlete %d and %d login(s)", athlete_id, len(logins))
    _remove_files(athlete_id)
    return logins
