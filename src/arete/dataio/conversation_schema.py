"""Browser conversation archives, independent of graph checkpoints."""

DDL = """
CREATE TABLE IF NOT EXISTS app.coach_conversations (
    id VARCHAR NOT NULL,
    athlete_id INTEGER NOT NULL DEFAULT getvariable('arete_athlete_id'),
    title VARCHAR NOT NULL, title_state VARCHAR NOT NULL DEFAULT 'provisional',
    revision INTEGER NOT NULL DEFAULT 0, write_id VARCHAR,
    payload VARCHAR NOT NULL DEFAULT '{}', search_text VARCHAR NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMP,
    PRIMARY KEY (athlete_id, id)
);
"""


def migrate(con) -> None:
    from arete.dataio.tenant_schema import _view

    con.execute(DDL)
    _view(con, "coach_conversations")
