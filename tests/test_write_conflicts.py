"""DuckDB detects a write-write conflict only between writes of one form (ARE-150).

On a keyed table (every ``app`` table has a primary key) DuckDB runs a plain
``UPDATE`` in place, but an ``UPDATE`` with ``RETURNING``, an update of a key
column, an upsert with ``RETURNING`` and a ``DELETE`` as a delete (plus an
insert). An in-place update conflicts only with another in-place update of
the same column, a delete only with another delete. Across the two forms
nothing is detected, whether the other write is committed or still running:
the later one overwrites, or vanishes while reporting its row changed.

Arete's rule (docs/architecture.md): every runtime ``UPDATE``, ``ON CONFLICT
DO UPDATE`` and ``INSERT OR REPLACE`` carries ``RETURNING``, so every write of
a row is a delete and any two writers of it conflict.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import duckdb
import pytest

ROOT = Path(__file__).resolve().parents[1] / "src" / "arete"

#: Run by the boot before the app serves (single writer): exempt from the rule.
MIGRATIONS = {
    "dataio/init_duckdb.py",
    *(p.relative_to(ROOT).as_posix() for p in (ROOT / "dataio").glob("*_schema.py")),
}

IN_PLACE = "UPDATE t SET status = 'A' WHERE id = 1"
#: The forms Arete writes with: each one deletes the row version it replaces.
DELETING = {
    "update returning": "UPDATE t SET status = 'A' WHERE id = 1 RETURNING id",
    "upsert returning": (
        "INSERT INTO t VALUES (1, 'A') ON CONFLICT (id) "
        "DO UPDATE SET status = excluded.status RETURNING id"
    ),
    "insert or replace returning": "INSERT OR REPLACE INTO t VALUES (1, 'A') RETURNING id",
    "delete": "DELETE FROM t WHERE id = 1 RETURNING id",
}
GUARDED = {
    "update returning": "UPDATE t SET status = 'B' WHERE id = 1 AND status = 'pending' RETURNING id",
    "delete": "DELETE FROM t WHERE id = 1 AND status = 'pending' RETURNING id",
}


def _two_writers() -> tuple[duckdb.DuckDBPyConnection, ...]:
    db = duckdb.connect(":memory:")
    db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, status VARCHAR)")
    db.execute("INSERT INTO t VALUES (1, 'pending')")
    return db, db.cursor(), db.cursor()


def _stale(guarded: duckdb.DuckDBPyConnection) -> None:
    """Take the guarded transaction's snapshot, as a read before its write."""
    guarded.execute("BEGIN TRANSACTION")
    guarded.execute("SELECT * FROM t").fetchall()


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason=(
        "DuckDB 1.4.2 (still 1.5.6 and 2.0 dev, 2026-10): a delete-and-insert "
        "write does not see an in-place UPDATE committed after its snapshot. "
        "Passing means the engine fixed it: the RETURNING rule can be relaxed."
    ),
)
@pytest.mark.parametrize("write", GUARDED)
def test_engine_conflicts_a_stale_write_with_an_in_place_update(write):
    db, first, second = _two_writers()
    _stale(second)
    first.execute(IN_PLACE)
    try:
        second.execute(GUARDED[write]).fetchall()
        second.execute("COMMIT")
    except duckdb.TransactionException:
        return
    assert db.execute("SELECT status FROM t").fetchall() == [("A",)], "lost update"


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason=(
        "DuckDB 1.4.2 (still 1.5.6 and 2.0 dev, 2026-10): an in-place UPDATE "
        "over a row deleted since its snapshot reports the row changed and "
        "writes nothing. Passing means the engine fixed it."
    ),
)
def test_engine_conflicts_a_stale_in_place_update_with_a_delete():
    db, first, second = _two_writers()
    _stale(second)
    first.execute(DELETING["update returning"]).fetchall()
    try:
        changed = second.execute(
            "UPDATE t SET status = 'B' WHERE id = 1 AND status = 'pending'"
        ).fetchone()
        second.execute("COMMIT")
    except duckdb.TransactionException:
        return
    assert changed == (0,), "a write reported done, then lost"


@pytest.mark.parametrize("committed", [True, False], ids=["committed", "running"])
@pytest.mark.parametrize("guarded", GUARDED)
@pytest.mark.parametrize("first_write", DELETING)
def test_two_deleting_writes_of_a_row_always_conflict(first_write, guarded, committed):
    """What the rule relies on: a stale guarded write never silently wins."""
    db, first, second = _two_writers()
    _stale(second)
    first.execute("BEGIN TRANSACTION")
    first.execute(DELETING[first_write]).fetchall()
    if committed:
        first.execute("COMMIT")
    with pytest.raises(duckdb.TransactionException):
        second.execute(GUARDED[guarded]).fetchall()
    second.execute("ROLLBACK")
    if not committed:
        first.execute("COMMIT")
    expected = [] if first_write == "delete" else [("A",)]
    assert db.execute("SELECT status FROM t").fetchall() == expected


def _sql_strings(tree: ast.AST):
    """Each SQL text with the line it starts on, concatenations joined."""
    parents = {
        child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)
    }

    def text(node: ast.AST) -> str | None:
        if isinstance(node, ast.Constant):
            return node.value if isinstance(node.value, str) else None
        if isinstance(node, ast.JoinedStr):
            return "".join(text(v) or "{}" for v in node.values)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = text(node.left), text(node.right)
            return (
                None
                if left is None and right is None
                else (left or "{}") + (right or "{}")
            )
        if isinstance(node, ast.IfExp):
            return (text(node.body) or "") + " " + (text(node.orelse) or "")
        return None

    for node in ast.walk(tree):
        parent = parents.get(node)
        if isinstance(parent, ast.Expr) or text(node) is None:
            continue  # a docstring, or not a string
        if (
            isinstance(parent, ast.JoinedStr | ast.BinOp | ast.IfExp)
            and text(parent) is not None
        ):
            continue  # part of a larger text, checked whole
        yield node.lineno, text(node)


WRITE_IN_PLACE = re.compile(
    r"\bUPDATE\s+\S+(\s+\w+)?\s+SET\b|\bDO\s+UPDATE\b|\bINSERT\s+OR\s+REPLACE\b"
)


def test_every_runtime_update_returns_so_duckdb_deletes_the_old_row():
    """An in-place write is the form no other writer's conflict check sees."""
    violations = [
        f"{path.relative_to(ROOT)}:{line}"
        for path in sorted(ROOT.rglob("*.py"))
        if path.relative_to(ROOT).as_posix() not in MIGRATIONS
        for line, sql in _sql_strings(ast.parse(path.read_text()))
        if WRITE_IN_PLACE.search(sql) and "RETURNING" not in sql
    ]
    assert not violations, "write without RETURNING (ARE-150):\n" + "\n".join(
        violations
    )
