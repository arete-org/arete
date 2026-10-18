"""Erase the signed-in athlete for good: files, rows, account (ARE-128).

Physical deletion, unlike an administrator's deactivation. The athlete's
directory goes first, then one transaction deletes every row of every private
relation ``dataio.tenant_schema`` declares (soft-deleted rows included), the
account rows and writes the erasure log: the day and a one-way hash of each
login's Clerk id, nothing else. One transaction keeps the request within a
handful of database round trips and makes a failure leave the account whole,
signed in, for a retry to finish the job.

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
from arete.dataio.db import db_connection, transaction
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
    """Every athlete-keyed deletion, as one script: one round trip, not sixty.

    The id is inlined, as an integer from the trusted scope, because a script
    of several statements takes no parameters.
    """
    assert type(athlete_id) is int and athlete_id > 0, "trusted athlete id"
    keyed = [(table, owner_column(table)) for table in PRIVATE_TABLES]
    keyed += list(ATHLETE_ACCOUNT_TABLES.items())
    return ";\n".join(
        f"DELETE FROM app.{table} WHERE {column}={athlete_id}"
        for table, column in keyed
    )


def _logins(athlete_id: int) -> list[str]:
    with db_connection() as con:
        rows = con.execute(
            "SELECT clerk_user_id FROM app.users WHERE athlete_id=?", [athlete_id]
        ).fetchall()
    return [str(row[0]) for row in rows]


def erase_current_athlete() -> list[str]:
    """Erase the scoped athlete; returns its Clerk logins, for the caller to delete.

    Raises ``AccountError`` for the owner, before anything is touched. Its
    database work is one transaction: a failure rolls it all back and a retry
    starts again; the directory, removed first, is idempotent to remove.
    """
    athlete_id = current_athlete_id()
    if athlete_id == OWNER_ATHLETE_ID:
        raise AccountError(OWNER_DETAIL)
    logins = _logins(athlete_id)
    directory = config.data_dir
    assert directory != config.storage_root, "an athlete directory is never the root"
    if directory.is_dir():
        shutil.rmtree(directory)
    marks = ",".join("?" * len(logins)) or "NULL"
    with transaction() as con:
        con.execute(_statements(athlete_id))
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
    logger.info("Erased an athlete and %d login(s)", len(logins))
    return logins
