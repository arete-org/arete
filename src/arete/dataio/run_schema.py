"""Short-lived execution state, separate from browser conversation archives."""

from arete.dataio.automation_schema import DDL as AUTOMATION_DDL

TABLES = (
    "chat_runs",
    "chat_interrupts",
    "chat_effects",
    "chat_checkpoints",
    "chat_checkpoint_writes",
    "coaching_run_activity",
)
DDL = """
CREATE TABLE IF NOT EXISTS app.chat_runs (
    id VARCHAR PRIMARY KEY,
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    thread_id VARCHAR NOT NULL, state VARCHAR NOT NULL,
    active_thread VARCHAR, slot INTEGER,
    UNIQUE(athlete_id,active_thread), UNIQUE(athlete_id,slot),
    context_json VARCHAR NOT NULL, policy VARCHAR,
    model_turns INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
    resumes INTEGER NOT NULL DEFAULT 0, active_seconds DOUBLE NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1, lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.chat_interrupts (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    run_id VARCHAR NOT NULL, id VARCHAR NOT NULL, tool_call_id VARCHAR NOT NULL,
    payload_json VARCHAR NOT NULL, schema_json VARCHAR NOT NULL, decision_json VARCHAR,
    revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMP,
    PRIMARY KEY(athlete_id,run_id,id)
);
CREATE TABLE IF NOT EXISTS app.chat_effects (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    run_id VARCHAR NOT NULL, tool_call_id VARCHAR NOT NULL,
    arguments_json VARCHAR NOT NULL, result_json VARCHAR,
    state VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMP,
    PRIMARY KEY(athlete_id,run_id,tool_call_id)
);
CREATE TABLE IF NOT EXISTS app.coaching_run_activity (
    id VARCHAR PRIMARY KEY,
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    source_kind VARCHAR NOT NULL, source_id VARCHAR NOT NULL,
    state VARCHAR NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    projection_json VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMP
);
"""
# Keep the same public checkpoint format for both owners, without moving old runs.
for table in ("automation_checkpoints", "automation_checkpoint_writes"):
    statement = next(s for s in AUTOMATION_DDL.split(";") if f"app.{table} (" in s)
    DDL += statement.replace(table, table.replace("automation_", "chat_")) + ";"


def migrate(con):
    from arete.dataio.tenant_schema import _view

    con.execute(DDL)
    for table in TABLES:
        _view(con, table)
