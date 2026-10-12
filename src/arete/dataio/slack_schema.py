"""Global Slack identities and external-operation receipts, never coaching history."""

DDL = """
CREATE TABLE IF NOT EXISTS app.slack_identities (
    team_id VARCHAR NOT NULL,
    slack_user_id VARCHAR NOT NULL,
    email VARCHAR NOT NULL,
    account_id VARCHAR NOT NULL,
    athlete_id INTEGER NOT NULL,
    timezone VARCHAR NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (team_id, slack_user_id)
);
CREATE TABLE IF NOT EXISTS app.slack_private_threads (
    thread_id VARCHAR PRIMARY KEY,
    account_id VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS app.slack_operations (
    operation_id VARCHAR PRIMARY KEY,
    event_key VARCHAR NOT NULL,
    account_id VARCHAR NOT NULL,
    team_id VARCHAR NOT NULL,
    action VARCHAR NOT NULL,
    target_id VARCHAR NOT NULL,
    channel_id VARCHAR NOT NULL,
    thread_ts VARCHAR,
    body VARCHAR NOT NULL,
    post_at BIGINT,
    slack_id VARCHAR,
    status VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
"""


def migrate(con) -> None:
    con.execute(DDL)
