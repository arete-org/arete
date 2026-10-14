"""Experiment-only typed queries and SQL validation. Never imported by the app."""

from __future__ import annotations

import json
import threading
from pathlib import Path

import duckdb
import sqlglot
from sqlglot import exp

CATALOG = json.loads(Path(__file__).with_name("catalog.json").read_text())

MAX_ROWS = 100
MAX_RESULT_BYTES = 24_000
MAX_SQL_CHARS = 8_000
TABLES = {"sessions", "days", "plans", "strength"}
FUNCTIONS = {
    "AND",
    "OR",
    "SUM",
    "AVG",
    "COUNT",
    "MIN",
    "MAX",
    "ROUND",
    "COALESCE",
    "NULLIF",
    "CORR",
    "CAST",
    "LIST",
    "ARRAY_AGG",
    "ABS",
    "DATE_TRUNC",
}


def validate_sql(sql):
    if not isinstance(sql, str) or len(sql) > MAX_SQL_CHARS:
        raise ValueError("SQL exceeds 8000 characters")
    parsed = sqlglot.parse(sql, read="duckdb")
    if len(parsed) != 1 or not isinstance(parsed[0], exp.Select):
        raise ValueError("One SELECT required")
    tree = parsed[0]
    for node in tree.walk():
        if isinstance(node, (exp.Command, exp.Into, exp.With, exp.Union, exp.Subquery)):
            raise ValueError(
                "Only a flat analytical SELECT is enabled in this experiment"
            )
        if isinstance(node, exp.Table) and (
            node.name not in TABLES
            or node.db
            or node.catalog
            or not isinstance(node.this, exp.Identifier)
        ):
            raise ValueError("Unknown relation")
        if isinstance(node, exp.Func):
            name = (
                node.name.upper()
                if isinstance(node, exp.Anonymous)
                else node.sql_name()
            )
            if name not in FUNCTIONS:
                raise ValueError(f"Function not allowed: {name}")
    aliases = {t.alias_or_name: t.name for t in tree.find_all(exp.Table)}
    allowed = {
        frozenset((("sessions", "day_id"), ("days", "id"))),
        frozenset((("sessions", "planned_id"), ("plans", "id"))),
        frozenset((("plans", "actual_id"), ("sessions", "id"))),
    }
    joins = list(tree.find_all(exp.Join))
    if len(joins) > 2:
        raise ValueError("At most two declared joins")
    for join in joins:
        on = join.args.get("on")
        if not isinstance(on, exp.EQ) or not all(
            isinstance(c, exp.Column) for c in (on.left, on.right)
        ):
            raise ValueError("Join on one declared foreign key")
        keys = frozenset((aliases.get(c.table), c.name) for c in (on.left, on.right))
        if keys not in allowed:
            raise ValueError("Join is outside the semantic catalog")
    if joins:
        for aggregate in tree.find_all(exp.AggFunc):
            if any(
                aliases.get(c.table) == "days"
                or (not c.table and c.name in {"hrv", "sleep_duration_sec"})
                for c in aggregate.find_all(exp.Column)
            ):
                raise ValueError(
                    "Aggregate daily measurements on days separately to avoid session multiplication"
                )
    return tree.sql(dialect="duckdb")


def scoped_tables(tables, athlete_id=1):
    """Build the synthetic snapshot before any query; SQL cannot widen its scope."""
    filtered = {
        name: [
            r
            for r in rows
            if r.get("athlete_id", athlete_id) == athlete_id
            and r.get("source") != "strava"
        ]
        for name, rows in tables.items()
    }
    # Completion is the authoritative link. Synthetic sessions carry proposed
    # plan IDs too; only confirmed plan.actual_id links enter any candidate.
    completed_links = {
        r["actual_id"]: r["id"] for r in filtered["plans"] if r.get("actual_id")
    }
    filtered["sessions"] = [
        {**r, "planned_id": completed_links.get(r["id"])} for r in filtered["sessions"]
    ]
    return filtered


def connection(tables):
    tables = scoped_tables(tables)
    con = duckdb.connect(
        ":memory:",
        config={
            "threads": 1,
            "memory_limit": "256MB",
            "enable_external_access": False,
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
        },
    )
    for name in sorted(TABLES):
        rows = tables[name]
        assert 0 < len(rows) <= 10_000
        keys = list(rows[0])
        types = []
        for key in keys:
            value = next((r[key] for r in rows if r[key] is not None), None)
            types.append("DOUBLE" if isinstance(value, (int, float)) else "VARCHAR")
        con.execute(
            f"CREATE TABLE {name} ("
            + ", ".join(f'"{k}" {t}' for k, t in zip(keys, types, strict=True))
            + ")"
        )
        con.executemany(
            f"INSERT INTO {name} VALUES (" + ", ".join("?" for _ in keys) + ")",
            [[r[k] for k in keys] for r in rows],
        )
    con.execute("SET lock_configuration=true")
    return con


def execute(con, sql, params=None):
    timer = threading.Timer(2.0, con.interrupt)
    timer.start()
    try:
        result = con.execute(validate_sql(sql), params or [])
        columns = [c[0] for c in result.description]
        rows = result.fetchmany(MAX_ROWS + 1)
        if len(rows) > MAX_ROWS:
            raise ValueError("Result exceeds 100 rows; aggregate or narrow the query")
        payload = dict(
            rows=[dict(zip(columns, r, strict=True)) for r in rows],
            complete=True,
            limits={"rows": MAX_ROWS, "bytes": MAX_RESULT_BYTES, "query_seconds": 2},
            units={entity: CATALOG[entity]["fields"] for entity in sorted(TABLES)},
            coverage={
                "snapshot": "synthetic athlete 1; local dates; NULL is unknown",
                "result_rows": len(rows),
            },
        )
        if len(json.dumps(payload).encode()) > MAX_RESULT_BYTES:
            raise ValueError("Result exceeds 24000 bytes; narrow the query")
        return payload
    finally:
        timer.cancel()
        timer.join()


def typed_query(con, tables, *, entity, metric, aggregate, filters=None, group_by=None):
    if entity not in TABLES or metric not in tables[entity][0]:
        raise ValueError("Unknown entity or metric")
    if aggregate not in {"sum", "avg", "min", "max", "count"}:
        raise ValueError("Unknown aggregate")
    groups = group_by or []
    if len(groups) > 2 or any(g not in tables[entity][0] for g in groups):
        raise ValueError("At most two declared grouping fields")
    predicates, params = [], []
    for key, value in (filters or {}).items():
        column, _, op = key.partition("__")
        operators = {"": "=", "lt": "<", "gt": ">", "gte": ">=", "lte": "<="}
        if column not in tables[entity][0] or op not in operators:
            raise ValueError("Unknown filter")
        predicates.append(f'"{column}" {operators[op]} ?')
        params.append(value)
    predicates.append(f'"{metric}" IS NOT NULL')
    where = " AND ".join(predicates)
    dimensions = ", ".join(f'"{g}"' for g in groups)
    result = execute(
        con,
        f'SELECT {dimensions + ", " if dimensions else ""}{aggregate}("{metric}") AS value, list(id) AS sources FROM {entity} WHERE {where}'
        + (f" GROUP BY {dimensions} ORDER BY {dimensions}" if groups else ""),
        params,
    )
    result["unit"] = (
        "count"
        if aggregate == "count"
        else CATALOG[entity]["fields"].get(metric, "identifier")
    )
    result["coverage"] = {
        "entity": entity,
        "snapshot_rows": len(tables[entity]),
        "missing_values": "excluded, never zero",
    }
    return result


def relationships(tables, source_ids):
    """One hop over declared, authoritative foreign keys; never inferred similarity."""
    if not 1 <= len(source_ids) <= 20:
        raise ValueError("Select between 1 and 20 source IDs")
    indexed = {r["id"]: r for rows in tables.values() for r in rows}
    if any(sid not in indexed for sid in source_ids):
        raise ValueError("Unknown source ID")
    selected = set(source_ids)
    edges = []
    for rows in tables.values():
        for row in rows:
            for field in ("planned_id", "day_id", "actual_id"):
                target = row.get(field)
                if target in indexed and (
                    row["id"] in source_ids or target in source_ids
                ):
                    edges.append({"from": row["id"], "to": target, "field": field})
                    selected.update((row["id"], target))
    if len(selected) > 40:
        raise ValueError("Traversal exceeds 40 nodes; narrow the source IDs")
    return {
        "rows": [indexed[sid] for sid in sorted(selected)],
        "edges": edges,
        "complete": True,
        "limits": {"hops": 1, "seeds": 20, "nodes": 40},
    }
