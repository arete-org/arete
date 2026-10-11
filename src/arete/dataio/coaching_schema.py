"""Durable coaching records; all relations use the trusted athlete scope."""

DDL = """
CREATE TABLE IF NOT EXISTS app.coach_memory_files (
    athlete_id INTEGER NOT NULL DEFAULT(getvariable('arete_athlete_id')),
    path VARCHAR NOT NULL,
    content VARCHAR NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    forgotten BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP,
    PRIMARY KEY (athlete_id, path)
);
CREATE TABLE IF NOT EXISTS app.coach_memory_imports (
    athlete_id INTEGER NOT NULL DEFAULT(getvariable('arete_athlete_id')) PRIMARY KEY,
    imported_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);
CREATE SEQUENCE IF NOT EXISTS app.coach_followup_id START 1;
CREATE TABLE IF NOT EXISTS app.coach_followups (
    id INTEGER PRIMARY KEY DEFAULT nextval('app.coach_followup_id'),
    athlete_id INTEGER NOT NULL DEFAULT(getvariable('arete_athlete_id')),
    session_id INTEGER NOT NULL,
    decision_id INTEGER,
    requested_on DATE NOT NULL,
    question VARCHAR NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    state VARCHAR NOT NULL DEFAULT 'pending',
    snoozed_until DATE,
    rpe INTEGER,
    notes VARCHAR,
    revision INTEGER NOT NULL DEFAULT 1,
    answered_at TIMESTAMP,
    deleted_at TIMESTAMP,
    UNIQUE (athlete_id, session_id),
    UNIQUE (athlete_id, requested_on)
);
"""


def migrate(con) -> None:
    con.execute(DDL)
    for definition in (
        "state VARCHAR DEFAULT 'applied'",
        "revision INTEGER DEFAULT 1",
        "session_revision INTEGER",
        "readiness_measured_on DATE",
        "snoozed_until DATE",
    ):
        con.execute(
            f"ALTER TABLE app.plan_decisions ADD COLUMN IF NOT EXISTS {definition}"
        )
    con.execute(
        "UPDATE app.plan_decisions SET state='reverted' WHERE reverted_at IS NOT NULL"
    )
    # Existing automatic settings must not grant permission to new proposals.
    con.execute("UPDATE app.user_settings SET auto_adapt_enabled=false")
