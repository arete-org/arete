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
import shutil
import threading
from collections.abc import Iterator
from contextlib import contextmanager

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


def remote_database() -> str:
    """``md:arete`` -> ``arete``; a bare ``md:`` means MotherDuck's default."""
    return config.db_target.removeprefix("md:") or "my_db"


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    if os.getenv("VERCEL_ENV") == "preview" and config.db_target == "md:arete":
        raise RuntimeError(
            "Preview requires a separate ARETE_DB; production md:arete is forbidden"
        )
    if config.is_remote_db:
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
    if not os.path.isdir(os.environ.get("HOME", "")):
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
