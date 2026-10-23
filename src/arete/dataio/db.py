"""DuckDB connection helpers.

Two backends behind one ``connect()``:

- a local file (the default): one connection per call, closed by the caller,
  because DuckDB allows a single writer per file;
- MotherDuck (``ARETE_DB=md:<database>``): one connection per process, and a
  cursor per call. Opening a MotherDuck connection costs ~0.3 s (and ~7 s the
  first time, to fetch the extension), a query on an open one ~5 ms — so the
  connection is the expensive part and is kept. Closing the cursor a caller
  gets back leaves the shared connection open.
"""

from __future__ import annotations

import logging
import os
import pathlib
import re
import shutil
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, cast

import duckdb

from arete.config import config
from arete.observability.requests import counted

logger = logging.getLogger(__name__)

#: Writable home for DuckDB when the filesystem is read-only except ``/tmp``.
REMOTE_HOME = pathlib.Path("/tmp/duckdb")
#: Extensions downloaded at build time (``scripts/bundle_duckdb_extensions.py``).
BUNDLED_EXTENSIONS = pathlib.Path(__file__).resolve().parents[3] / "duckdb_extensions"

_remote: duckdb.DuckDBPyConnection | None = None
_remote_lock = threading.Lock()
_local_connect_lock = threading.Lock()


def get_db_path() -> pathlib.Path:
    return config.db_path


#: Created during MotherDuck's trial: their 7-day snapshot retention makes the
#: boot's backup clone fail on the current plan, so a migration can never run
#: there. Kept untouched as backups of their ``_v2`` copies (docs/deployment.md).
RETIRED_DATABASES = frozenset({"arete", "arete_preview"})


def remote_database() -> str:
    """``md:arete_v2`` -> ``arete_v2``; a bare ``md:`` means MotherDuck's default."""
    return config.db_target.removeprefix("md:") or "my_db"


def _database_name() -> str:
    """The name only: a connection string's options may carry a token."""
    return remote_database().split("?", 1)[0].lower()


def warn_production_database() -> None:
    """Outside Vercel, a database not named for previews is production's: this
    process writes real athletes' data and its scheduler runs their daily jobs."""
    if config.serverless:
        return
    if not config.is_remote_db:
        return
    name = _database_name()
    if "preview" in name:
        return
    logger.warning(
        "ARETE_DB names %s, not a preview database: this process writes production data",
        name,
    )


def _refuse_wrong_database() -> None:
    """A retired database anywhere; on a preview, any database not named for
    previews (production's name has changed once already)."""
    name = _database_name()
    if name in RETIRED_DATABASES:
        raise RuntimeError(f"{name} is retired: point ARETE_DB at its _v2 copy")
    if os.getenv("VERCEL_ENV") == "preview" and "preview" not in name:
        raise RuntimeError(
            f"Preview requires a separate ARETE_DB named for previews; {name} is forbidden"
        )


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    idle = _idle.get()
    if idle is None or read_only:
        return _open(read_only)
    con = idle.take(_owner())
    if con is None:
        con = _open(read_only)
    # Read after the open: the first one opens the shared MotherDuck connection.
    return cast(duckdb.DuckDBPyConnection, _Lease(con, idle, _owner()))


def _open(read_only: bool) -> duckdb.DuckDBPyConnection:
    if config.is_remote_db:
        _refuse_wrong_database()
        con = _remote_cursor()
        configure_athlete(con)
        return con
    db_path = get_db_path()
    if not read_only:
        db_path.parent.mkdir(parents=True, exist_ok=True)
    # Concurrent opens can race DuckDB's instance-cache cleanup when the last
    # connection closes. Serialize opening only; queries keep separate connections.
    with _local_connect_lock:
        con = counted(duckdb.connect(str(db_path), read_only=read_only))
    con.execute("PRAGMA threads=4;")
    con.execute(f"PRAGMA temp_directory='{db_path.parent}';")
    configure_athlete(con)
    return con


def configure_athlete(con: duckdb.DuckDBPyConnection) -> None:
    from arete.services.athlete_scope import database_athlete_id

    con.execute("SET VARIABLE arete_athlete_id = ?", [database_athlete_id()])


#: Most idle connections one run keeps: nested calls rarely hold more than two.
MAX_IDLE_CONNECTIONS = 4
#: Statements that change a connection's session for whoever uses it next.
_SESSION_CHANGES = ("SET", "RESET", "PRAGMA", "USE", "ATTACH", "DETACH", "LOAD")
_SEARCH_PATH = re.compile(r"SET\s+search_path\s*=\s*'app'\s*;?\s*$", re.IGNORECASE)

#: Whose connection it is: the athlete of its variable and, on MotherDuck, the
#: shared connection its cursor belongs to (one replaced since is not reused).
_Owner = tuple[int | None, object | None]


def _owner() -> _Owner:
    from arete.services.athlete_scope import database_athlete_id

    return database_athlete_id(), _remote if config.is_remote_db else None


class _Idle:
    """The connections a run's callers closed cleanly, with their owner."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._connections: list[tuple[_Owner, duckdb.DuckDBPyConnection]] = []
        self._closed = False

    def take(self, owner: _Owner) -> duckdb.DuckDBPyConnection | None:
        with self._lock:
            for i, ((athlete, parent), con) in enumerate(self._connections):
                if athlete == owner[0] and parent is owner[1]:
                    del self._connections[i]
                    return con
        return None

    def give_back(self, owner: _Owner, con: duckdb.DuckDBPyConnection) -> None:
        with self._lock:
            if not self._closed and len(self._connections) < MAX_IDLE_CONNECTIONS:
                self._connections.append((owner, con))
                return
        con.close()

    def drop(self, *, closing: bool = False) -> None:
        with self._lock:
            self._closed = self._closed or closing
            connections, self._connections = self._connections, []
        for _, con in connections:
            con.close()


_idle: ContextVar[_Idle | None] = ContextVar("arete_idle_connections", default=None)


class _Lease:
    """One caller's use of a reusable connection, until it closes it.

    ``close`` hands the connection back only as a new one would be: no
    transaction left open, no failed statement (it may come from a lost
    connection, so every idle one is closed with it), no session setting
    changed. The repositories' ``SET search_path = 'app'`` is reset on the
    way back; any other change closes the connection. Each ``connect`` gets
    its own lease: closing it twice cannot hand back a connection that another
    caller took since.
    """

    __slots__ = (
        "_changed",
        "_con",
        "_failed",
        "_idle",
        "_in_transaction",
        "_owner",
        "_search_path",
    )

    def __init__(
        self, con: duckdb.DuckDBPyConnection, idle: _Idle, owner: _Owner
    ) -> None:
        self._con: duckdb.DuckDBPyConnection | None = con
        self._idle = idle
        self._owner = owner
        self._failed = self._in_transaction = False
        self._changed = self._search_path = False

    def _open_con(self) -> duckdb.DuckDBPyConnection:
        if self._con is None:
            raise duckdb.ConnectionException("Connection already closed!")
        return self._con

    def _run(self, method: str, sql: str, args: Any, kwargs: Any) -> _Lease:
        con = self._open_con()
        try:
            getattr(con, method)(sql, *args, **kwargs)
        except BaseException:
            self._failed = True
            raise
        statement = sql.strip()
        head = statement.split(None, 1)[0].upper() if statement else ""
        if head == "BEGIN":
            self._in_transaction = True
        elif head in ("COMMIT", "ROLLBACK", "END", "ABORT"):
            self._in_transaction = False
        elif _SEARCH_PATH.match(statement):
            self._search_path = True
        elif head in _SESSION_CHANGES or statement.upper().startswith("CREATE TEMP"):
            self._changed = True
        return self

    def execute(self, sql: str, *args: Any, **kwargs: Any) -> _Lease:
        return self._run("execute", sql, args, kwargs)

    def executemany(self, sql: str, *args: Any, **kwargs: Any) -> _Lease:
        return self._run("executemany", sql, args, kwargs)

    def begin(self) -> _Lease:
        self._open_con().begin()
        self._in_transaction = True
        return self

    def commit(self) -> _Lease:
        self._open_con().commit()
        self._in_transaction = False
        return self

    def rollback(self) -> _Lease:
        self._open_con().rollback()
        self._in_transaction = False
        return self

    def close(self) -> None:
        con, self._con = self._con, None
        if con is None:
            return
        if self._failed:
            con.close()
            self._idle.drop()
            return
        if self._in_transaction or self._changed:
            con.close()  # a transaction rolls back, as before
            return
        if self._search_path:
            try:
                con.execute("RESET search_path")
            except duckdb.Error:
                con.close()
                self._idle.drop()
                return
        self._idle.give_back(self._owner, con)

    def __enter__(self) -> _Lease:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._open_con(), name)


@contextmanager
def reuse_connections() -> Iterator[None]:
    """Within this block, a connection a caller closed serves the next one.

    For a scheduled run's long sequence of short calls: a new connection costs
    its setup statements (``USE`` and the athlete's variable on MotherDuck,
    the PRAGMAs locally), about two thirds of the daily run's (ARE-105). Each
    caller still gets a connection of its own, with no transaction open, the
    default session and the current athlete's variable; read-only ones are
    never reused. A MotherDuck connection lost while idle is found by the
    next caller's first statement, which fails as it would have on a cursor
    opened just before the loss; the cursors after it reconnect. The idle ones
    close when the block ends.
    """
    idle = _Idle()
    token = _idle.set(idle)
    try:
        yield
    finally:
        _idle.reset(token)
        idle.drop(closing=True)


def _seed_extensions() -> None:
    """Copy the build's extensions where DuckDB looks for them, once.

    ``scripts/bundle_duckdb_extensions.py`` downloads them at build time; the
    bundle is read-only, and DuckDB's default directory under its home stays
    writable. Without a bundle DuckDB downloads them as before.
    """
    target = REMOTE_HOME / ".duckdb" / "extensions"
    if BUNDLED_EXTENSIONS.is_dir() and not target.exists():
        shutil.copytree(BUNDLED_EXTENSIONS, target)
        logger.info("Seeded DuckDB extensions from %s", BUNDLED_EXTENSIONS)


def _open_remote() -> duckdb.DuckDBPyConnection:
    """Attach MotherDuck from an in-memory catalog.

    ``home_directory`` cannot be passed to ``duckdb.connect`` for an ``md:``
    path, so the connection starts in memory, points DuckDB's home at a
    writable directory, then attaches. The token comes from
    ``MOTHERDUCK_TOKEN`` in the environment.
    """
    REMOTE_HOME.mkdir(parents=True, exist_ok=True)
    _seed_extensions()
    # The MotherDuck extension also reads $HOME, which Vercel leaves empty or,
    # for a large function, points at a /home/vercel that does not exist.
    home = os.environ.get("HOME", "")
    if not (os.path.isdir(home) and os.access(home, os.W_OK)):
        os.environ["HOME"] = str(REMOTE_HOME)
    con = duckdb.connect()
    con.execute(f"SET home_directory='{REMOTE_HOME}'")
    con.execute(f"SET temp_directory='{REMOTE_HOME / 'tmp'}'")
    con.execute("ATTACH 'md:'")
    database = remote_database()
    con.execute(f"CREATE DATABASE IF NOT EXISTS {database}")
    con.execute(f"USE {database}")
    logger.info("Connected to MotherDuck database %s", database)
    return con


def _remote_cursor() -> duckdb.DuckDBPyConnection:
    """A cursor on the shared MotherDuck connection, reopened once if it died.

    A cursor starts in the in-memory catalog, not in the database the parent
    connection uses, hence the ``USE`` on every one.
    """
    global _remote
    database = remote_database()
    for attempt in (1, 2):
        with _remote_lock:
            if _remote is None:
                _remote = _open_remote()
            parent = _remote
        try:
            cursor = counted(parent.cursor())
            cursor.execute(f"USE {database}")
            return cursor
        except duckdb.Error:
            if attempt == 2:
                raise
            logger.warning("MotherDuck connection lost, reconnecting", exc_info=True)
            with _remote_lock:
                if _remote is parent:
                    _remote = None
    raise AssertionError("unreachable")


def reset_remote() -> None:
    """Drop the shared MotherDuck connection (tests, configuration changes)."""
    global _remote
    with _remote_lock:
        if _remote is not None:
            _remote.close()
        _remote = None


@contextmanager
def db_connection(read_only: bool = False) -> Iterator[duckdb.DuckDBPyConnection]:
    """Always close; default to the same mode as concurrent API writers.

    DuckDB rejects overlapping connections with different read_only settings,
    even when the read-only caller only executes SELECT statements.
    """
    con = connect(read_only=read_only)
    try:
        yield con
    finally:
        con.close()


#: Attempts of an idempotent write whose row a concurrent writer changed (ARE-150),
#: and the wait before each rerun times its number: the conflict is raised while
#: the other transaction may still be open, so an immediate rerun would hit it.
IDEMPOTENT_WRITE_ATTEMPTS = 3
IDEMPOTENT_WRITE_RETRY_SECONDS = 0.2


def write_idempotent(sql: str, params: list) -> list[tuple]:
    """Run one write, rerun on a write-write conflict; returns its rows.

    Only for a write whose rerun is safe whatever committed in between: it sets
    the same values, or its condition re-reads the row. The last conflict raises.
    """
    for attempt in range(1, IDEMPOTENT_WRITE_ATTEMPTS + 1):
        try:
            with db_connection() as con:
                return con.execute(sql, params).fetchall()
        except duckdb.TransactionException:
            if attempt == IDEMPOTENT_WRITE_ATTEMPTS:
                raise
            logger.info(
                "Write conflict, attempt %d of %d", attempt, IDEMPOTENT_WRITE_ATTEMPTS
            )
            time.sleep(IDEMPOTENT_WRITE_RETRY_SECONDS * attempt)
    raise AssertionError("unreachable")


@contextmanager
def transaction() -> Iterator[duckdb.DuckDBPyConnection]:
    """Do not replay transactions: their callers own idempotency decisions."""
    with db_connection() as con:
        con.execute("BEGIN TRANSACTION")
        try:
            yield con
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
