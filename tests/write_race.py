"""Commit a competing write inside another path's snapshot window (ARE-150).

``race(monkeypatch, before, compete)`` wraps every DuckDB connection opened
meanwhile. The first statement matching ``before`` (a regular expression)
takes its transaction's snapshot, then ``compete()`` runs and commits on its
own connections, then the statement runs: exactly a concurrent writer that
commits between this path's snapshot and its write. A statement outside an
explicit transaction gets one around it, for the window inside a single
statement. Tests then assert the path took its conflict branch.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import duckdb


class _Rows:
    """The result of a statement whose autocommit transaction already ended."""

    def __init__(self, rows: list[tuple], description: Any) -> None:
        self._rows = rows
        self.description = description

    def fetchone(self) -> tuple | None:
        return self._rows.pop(0) if self._rows else None

    def fetchall(self) -> list[tuple]:
        rows, self._rows = self._rows, []
        return rows


class Race:
    def __init__(self, before: str, compete: Callable[[], object]) -> None:
        self.before = re.compile(before)
        self.compete = compete
        self.fired = False

    def run(self, con: duckdb.DuckDBPyConnection, opened: bool, sql, args, kwargs):
        self.fired = True
        if not opened:
            con.execute("BEGIN TRANSACTION")
        # The snapshot: this transaction's first table read, before the commit.
        con.execute("SELECT count(*) FROM app.schema_version").fetchall()
        self.compete()
        if opened:
            con.execute(sql, *args, **kwargs)
            return None
        try:
            con.execute(sql, *args, **kwargs)
            rows = _Rows(con.fetchall() if con.description else [], con.description)
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
        return rows


class _Racing:
    """A connection whose matching statement runs inside the race."""

    def __init__(self, con: duckdb.DuckDBPyConnection, race: Race) -> None:
        self._con = con
        self._race = race
        self._opened = False
        # Rows of a raced autocommit statement, read after its commit
        # (``counted`` returns its own wrapper, not this method's value).
        self._rows: _Rows | None = None

    def execute(self, sql, *args, **kwargs):
        self._rows = None
        head = str(sql).lstrip().upper()
        if head.startswith("BEGIN"):
            self._opened = True
        elif head.startswith(("COMMIT", "ROLLBACK")):
            self._opened = False
        if not self._race.fired and self._race.before.search(str(sql)):
            self._rows = self._race.run(self._con, self._opened, sql, args, kwargs)
        else:
            self._con.execute(sql, *args, **kwargs)
        return self

    def fetchone(self):
        return self._rows.fetchone() if self._rows is not None else self._con.fetchone()

    def fetchall(self):
        return self._rows.fetchall() if self._rows is not None else self._con.fetchall()

    def __enter__(self):
        self._con.__enter__()
        return self

    def __exit__(self, *exc):
        return self._con.__exit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._con, name)


@contextmanager
def race(monkeypatch, before: str, compete: Callable[[], object]) -> Iterator[Race]:
    """Run the block with ``compete`` committed inside ``before``'s window."""
    real = duckdb.connect
    state = Race(before, compete)
    with monkeypatch.context() as patched:
        patched.setattr(
            duckdb, "connect", lambda *a, **k: _Racing(real(*a, **k), state)
        )
        yield state
    assert state.fired, f"no statement matched {before!r}"
