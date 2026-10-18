"""Shared-schema ownership and live projections for every private relation.

Historical ``user_id`` columns already identify athletes, not login accounts;
keeping their names preserves existing API and migration contracts. New tables
use ``athlete_id``. Both are filtered by the same connection-local identity.
"""

from __future__ import annotations

import re

import duckdb

from arete.dataio.automation_schema import TABLES as AUTOMATION_TABLES

ATHLETE_SQL = "getvariable('arete_athlete_id')"
LEGACY_OWNERS = frozenset(
    {
        "planned_sessions",
        "actual_sessions",
        "strength_sessions",
        "user_settings",
        "strava_tokens",
        "banister_coefficients",
        "daily_metrics",
        "coach_briefings",
        "plan_decisions",
        "goals",
        "athlete_facts",
        "weekly_reviews",
    }
)

PRIVATE_TABLES = (
    "coach_conversations",
    *AUTOMATION_TABLES,
    *sorted(LEGACY_OWNERS),
    "exercises",
    "session_exercises",
    "exercise_sets",
    "push_subscriptions",
    "activity_streams",
    "session_feedback",
    "activity_terrain",
    "activity_weather",
    "document_quota",
    "coach_documents",
    "coach_document_chunks",
    "coach_imports",
    "garmin_exports",
    "game_profile",
    "game_periods",
    "game_events",
    "game_weeks",
    "game_ledger",
    "game_owned",
    "game_commands",
    "athlete_fact_revisions",
    "calendar_connections",
    "calendar_actions",
    "files",
    "garmin_login_challenges",
    "garmin_sync_state",
    "coach_memory_files",
    "coach_memory_imports",
    "coach_followups",
    "daily_checkins",
    "coach_evening_messages",
)
# Natural keys must be unique within an athlete, not across the deployment.
SCOPED_KEYS = {
    "push_subscriptions": "endpoint",
    "document_quota": "id",
    "game_profile": "id",
    "game_periods": "started_at",
    "game_events": "source_key",
    "game_weeks": "week_start",
    "game_ledger": "id",
    "game_owned": "skin",
    "game_commands": "key",
    "files": "path",
    "garmin_login_challenges": "id",
}
PARENTS = {
    "session_exercises": ("session_id", "strength_sessions", "id"),
    "exercise_sets": ("session_exercise_id", "session_exercises", "id"),
    "activity_streams": ("actual_session_id", "actual_sessions", "id"),
    "session_feedback": ("actual_session_id", "actual_sessions", "id"),
    "activity_terrain": ("actual_session_id", "actual_sessions", "id"),
    "activity_weather": ("actual_session_id", "actual_sessions", "id"),
    "coach_document_chunks": ("document_id", "coach_documents", "id"),
    "athlete_fact_revisions": ("fact_id", "athlete_facts", "id"),
    "garmin_exports": ("session_id", "planned_sessions", "id"),
    "calendar_actions": ("connection_key", "calendar_connections", "connection_key"),
}


def owner_column(table: str) -> str:
    assert table in PRIVATE_TABLES, f"Unknown private table: {table}"
    return "user_id" if table in LEGACY_OWNERS else "athlete_id"


def migrate(con: duckdb.DuckDBPyConnection) -> None:
    """Rebuild atomically: DuckDB cannot add NOT NULL after updating indexed rows."""
    from arete.dataio.automation_schema import DDL as automation_ddl
    from arete.dataio.coaching_schema import DDL as coaching_ddl
    from arete.dataio.conversation_schema import DDL as conversation_ddl
    from arete.dataio.mirror import DDL as files_ddl
    from arete.garmin.auth_state import DDL as challenges_ddl

    con.execute("BEGIN TRANSACTION")
    try:
        con.execute(automation_ddl)
        con.execute(conversation_ddl)
        con.execute(coaching_ddl)
        con.execute(files_ddl)
        con.execute(challenges_ddl)
        for table in PRIVATE_TABLES:
            _rebuild(con, table)
        # Old nullable owners mean the original self-hosted athlete.
        for table in LEGACY_OWNERS:
            con.execute(
                f"INSERT INTO app.athletes(id) SELECT DISTINCT user_id FROM app.{table} "
                "ON CONFLICT DO NOTHING"
            )
        for table in PRIVATE_TABLES:
            _view(con, table)
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def _rebuild(con: duckdb.DuckDBPyConnection, table: str) -> None:
    # MotherDuck attaches every database of the account: read this one's DDL.
    row = con.execute(
        "SELECT sql FROM duckdb_tables() WHERE database_name=current_database() "
        "AND schema_name='app' AND table_name=?",
        [table],
    ).fetchone()
    assert row is not None, f"Missing private relation: {table}"
    columns = [r[0] for r in con.execute(f"DESCRIBE app.{table}").fetchall()]
    if "deleted_at" in columns:
        return  # A migration interrupted after COMMIT can safely be recorded again.
    owner = owner_column(table)
    sql = str(row[0])
    sql = re.sub(
        rf"CREATE TABLE (?:app\.)?{table}\(",
        f"CREATE TABLE app._tenant_{table}(",
        sql,
        count=1,
    )
    if owner in columns:
        # Existing owner columns may be nullable or have an unsafe DEFAULT 1.
        sql = re.sub(
            rf"\b{owner} INTEGER(?: DEFAULT\(1\))?(?: NOT NULL)?",
            f"{owner} INTEGER NOT NULL DEFAULT({ATHLETE_SQL})",
            sql,
            count=1,
        )
        projection = ", ".join(
            f"coalesce({owner},1)" if c == owner else f'"{c}"' for c in columns
        )
    else:
        sql = sql.rstrip().removesuffix(";").removesuffix(")")
        sql += f", {owner} INTEGER NOT NULL DEFAULT({ATHLETE_SQL}));"
        inherited_owner = "1"
        if table in PARENTS:
            column, parent, key = PARENTS[table]
            inherited_owner = (
                f"coalesce((SELECT p.{owner_column(parent)} FROM app.{parent} p "
                f"WHERE p.{key}=app.{table}.{column}),1)"
            )
        projection = ", ".join(f'"{c}"' for c in columns) + f", {inherited_owner}"
        columns.append(owner)
    if table in SCOPED_KEYS:
        sql = sql.replace(" PRIMARY KEY", "")
        sql = sql.rstrip().removesuffix(";").removesuffix(")")
        sql += f", PRIMARY KEY (athlete_id, {SCOPED_KEYS[table]}));"
    sql = sql.rstrip().removesuffix(";").removesuffix(")") + ", deleted_at TIMESTAMP);"
    con.execute(sql)
    column_list = ", ".join(f'"{c}"' for c in columns)
    con.execute(
        f"INSERT INTO app._tenant_{table} ({column_list}) SELECT {projection} FROM app.{table}"
    )
    con.execute(f"DROP TABLE app.{table}")
    con.execute(f"ALTER TABLE app._tenant_{table} RENAME TO {table}")


def _view(con: duckdb.DuckDBPyConnection, table: str) -> None:
    owner = owner_column(table)
    predicate = f"t.{owner} = {ATHLETE_SQL} AND t.deleted_at IS NULL"
    predicate += f" AND EXISTS (SELECT 1 FROM app.athletes a WHERE a.id=t.{owner} AND a.deleted_at IS NULL)"
    # Outbound Garmin removals must remain visible after deleting the plan:
    # their durable state reconciles an ambiguous provider write without replay.
    if table in PARENTS and table != "garmin_exports":
        column, parent, key = PARENTS[table]
        predicate += f" AND EXISTS (SELECT 1 FROM app.visible_{parent} p WHERE p.{key}=t.{column})"
    # Keep the column order of the existing API projections; callers that need
    # deletion metadata read the base table deliberately in lifecycle services.
    con.execute(
        f"CREATE OR REPLACE VIEW app.visible_{table} AS SELECT t.* FROM app.{table} t WHERE {predicate}"
    )
