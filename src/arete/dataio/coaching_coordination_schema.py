"""Athlete-scoped coordination receipts, not another conversation store."""

TABLES = ("coach_attention_claims", "coach_attention_days", "plan_change_sets")
DDL = """
CREATE TABLE IF NOT EXISTS app.coach_attention_claims (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    subject_key VARCHAR NOT NULL, source_ref VARCHAR NOT NULL,
    source_revision VARCHAR NOT NULL, kind VARCHAR NOT NULL,
    state VARCHAR NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ, question_call_id VARCHAR, created_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMP, PRIMARY KEY (athlete_id, subject_key)
);
CREATE TABLE IF NOT EXISTS app.coach_attention_days (
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    local_date DATE NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMP,
    PRIMARY KEY (athlete_id, local_date), CHECK (attempts BETWEEN 0 AND 3)
);
CREATE TABLE IF NOT EXISTS app.plan_change_sets (
    id VARCHAR PRIMARY KEY,
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    revision INTEGER NOT NULL DEFAULT 1,
    items_json VARCHAR NOT NULL, before_json VARCHAR NOT NULL,
    after_json VARCHAR NOT NULL, digest VARCHAR NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    state VARCHAR NOT NULL DEFAULT 'pending',
    operation_id VARCHAR, receipt_json VARCHAR, deleted_at TIMESTAMP
);
"""


def migrate(con) -> None:
    from arete.dataio.tenant_schema import _view

    con.execute("BEGIN TRANSACTION")
    try:
        con.execute(DDL)
        for table in TABLES:
            _view(con, table)
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
