"""Durable missions, approvals and notification references, isolated per athlete."""

TABLES = (
    "automations",
    "automation_runs",
    "automation_interrupts",
    "automation_effects",
    "automation_calls",
    "automation_checkpoints",
    "automation_checkpoint_writes",
    "notifications",
)

DDL = """
CREATE TABLE IF NOT EXISTS app.automation_worker_slots (
    id INTEGER PRIMARY KEY, run_id VARCHAR, lease_until TIMESTAMPTZ
);
INSERT INTO app.automation_worker_slots (id) VALUES (1),(2) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS app.automations (
    id VARCHAR PRIMARY KEY,
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    title VARCHAR NOT NULL, mission VARCHAR NOT NULL, trigger_json VARCHAR NOT NULL,
    timezone VARCHAR NOT NULL, state VARCHAR NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL, activated_at TIMESTAMPTZ,
    next_due_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app.automation_runs (
    id VARCHAR PRIMARY KEY,
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    automation_id VARCHAR NOT NULL, occurrence_key VARCHAR NOT NULL,
    definition_json VARCHAR NOT NULL, session_key VARCHAR,
    due_at TIMESTAMPTZ NOT NULL, state VARCHAR NOT NULL DEFAULT 'queued',
    revision INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, lease_until TIMESTAMPTZ,
    expires_at TIMESTAMPTZ, result VARCHAR, error VARCHAR,
    model_turns INTEGER NOT NULL DEFAULT 0, model_requests INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0, resumes INTEGER NOT NULL DEFAULT 0,
    active_seconds DOUBLE NOT NULL DEFAULT 0, model_policy VARCHAR,
    deleted_at TIMESTAMP,
    UNIQUE(athlete_id, automation_id, occurrence_key)
);
CREATE TABLE IF NOT EXISTS app.automation_interrupts (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    run_id VARCHAR NOT NULL, id VARCHAR NOT NULL, tool_call_id VARCHAR NOT NULL,
    payload_json VARCHAR NOT NULL, schema_json VARCHAR NOT NULL,
    decision_json VARCHAR, revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMP, PRIMARY KEY(athlete_id,run_id,id)
);
CREATE TABLE IF NOT EXISTS app.automation_calls (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    run_id VARCHAR NOT NULL, tool_call_id VARCHAR NOT NULL, name VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMP,
    PRIMARY KEY(athlete_id,run_id,tool_call_id)
);
CREATE TABLE IF NOT EXISTS app.automation_effects (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    run_id VARCHAR NOT NULL, tool_call_id VARCHAR NOT NULL,
    arguments_json VARCHAR NOT NULL, result_json VARCHAR,
    state VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMP, PRIMARY KEY(athlete_id,run_id,tool_call_id)
);
CREATE TABLE IF NOT EXISTS app.automation_checkpoints (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    thread_id VARCHAR NOT NULL, namespace VARCHAR NOT NULL, id VARCHAR NOT NULL,
    parent_id VARCHAR, checkpoint_type VARCHAR NOT NULL, checkpoint BLOB NOT NULL,
    metadata_type VARCHAR NOT NULL, metadata BLOB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMP,
    PRIMARY KEY(athlete_id,thread_id,namespace,id)
);
CREATE TABLE IF NOT EXISTS app.automation_checkpoint_writes (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    thread_id VARCHAR NOT NULL, namespace VARCHAR NOT NULL, checkpoint_id VARCHAR NOT NULL,
    task_id VARCHAR NOT NULL, position INTEGER NOT NULL, channel VARCHAR NOT NULL,
    value_type VARCHAR NOT NULL, value BLOB NOT NULL, task_path VARCHAR NOT NULL,
    deleted_at TIMESTAMP,
    PRIMARY KEY(athlete_id,thread_id,namespace,checkpoint_id,task_id,position)
);
CREATE TABLE IF NOT EXISTS app.notifications (
    id VARCHAR PRIMARY KEY,
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    event_key VARCHAR NOT NULL, kind VARCHAR NOT NULL, title VARCHAR NOT NULL,
    body VARCHAR NOT NULL, url VARCHAR NOT NULL, reference_json VARCHAR,
    created_at TIMESTAMPTZ NOT NULL, read_at TIMESTAMPTZ, archived_at TIMESTAMPTZ,
    push_json VARCHAR, deleted_at TIMESTAMP,
    UNIQUE(athlete_id,event_key)
);
"""


def migrate(con) -> None:
    from arete.dataio.tenant_schema import _view

    con.execute(DDL)
    for table in TABLES:
        _view(con, table)
