"""Self-service erasure (ARE-128): every row and file of one athlete, nobody else's."""

from __future__ import annotations

from datetime import UTC, date, datetime
from hashlib import sha256
from uuid import uuid4

import pytest

from arete.api import auth
from arete.config import config
from arete.dataio.db import connect
from arete.dataio.init_duckdb import main as init_schema
from arete.dataio.tenant_schema import PRIVATE_TABLES, SCOPED_KEYS, owner_column
from arete.services.athlete_scope import athlete_scope

OWNER, ANA, BOB = "user_owner", "user_ana", "user_bob"
PROFILES = {
    OWNER: ("owner@example.com", "Greg", True),
    ANA: ("ana@example.com", "Ana", True),
    BOB: ("bob@example.com", "Bob", True),
    "user_owner_again": ("owner@example.com", "Greg", True),
}
TOKENS = {f"{subject}-token": subject for subject in PROFILES}
#: Tables outside ``tenant_schema`` that hold an athlete's or a login's data,
#: erased with the account. Every other table must hold neither.
ACCOUNT_TABLES = {
    "athletes": "id",
    "users": "athlete_id",
    "slack_athletes": "athlete_id",
    "slack_identities": "athlete_id",
}
LOGIN_TABLES = ("slack_identities", "slack_private_threads", "slack_operations")
PERSONAL_COLUMNS = {"athlete_id", "user_id", "account_id", "clerk_user_id", "email"}


def _bearer(subject: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {subject}-token"}


@pytest.fixture
def accounts(client, tmp_path, monkeypatch) -> dict[str, int]:
    """A private database in Clerk mode: owner (athlete 1), Ana and Bob."""
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "erasure.duckdb"))
    monkeypatch.setenv("ARETE_DATA_DIR", str(tmp_path / "files"))
    monkeypatch.setenv("ARETE_AUTH", "clerk")
    monkeypatch.setenv("CLERK_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("CLERK_PUBLISHABLE_KEY", "pk_test_fake")
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "owner@example.com")
    monkeypatch.delenv("ARETE_API_KEY", raising=False)
    monkeypatch.delenv("ARETE_GARMIN_TOKENS_DIR", raising=False)
    init_schema()

    def verify(token: str):
        if token in TOKENS:
            return {"sub": TOKENS[token]}
        raise auth.AuthError(401, "Session invalide ou expirée.")

    monkeypatch.setattr(auth, "_verify_session_token", verify)
    monkeypatch.setattr(auth, "_fetch_clerk_profile", lambda subject: PROFILES[subject])
    return {
        subject: client.get("/auth/me", headers=_bearer(subject)).json()["athlete_id"]
        for subject in (OWNER, ANA, BOB)
    }


@pytest.fixture
def clerk(monkeypatch) -> list[str]:
    """The Clerk users the endpoint deleted, in order; each call succeeds."""
    deleted: list[str] = []

    def delete(subject: str) -> bool:
        deleted.append(subject)
        return True

    monkeypatch.setattr(auth, "_delete_clerk_user", delete)
    return deleted


def _value(table: str, column: str, kind: str, athlete_id: int):
    """A valid cell for a generated row: unique per athlete where keys are global."""
    if column == owner_column(table):
        return athlete_id
    kind = kind.upper()
    if kind.endswith("[]"):
        return []
    if kind in ("INTEGER", "BIGINT", "SMALLINT", "HUGEINT"):
        return 1 if table in SCOPED_KEYS else athlete_id
    if kind in ("DOUBLE", "FLOAT", "DECIMAL"):
        return 1.0
    if kind == "BOOLEAN":
        return False
    if kind == "DATE":
        return date(2026, 10, 1)
    if kind.startswith("TIMESTAMP"):
        return datetime(2026, 10, 1, tzinfo=UTC)
    if kind == "BLOB":
        return b"private"
    if kind == "JSON":
        return '{"private": true}'
    return f"private-{athlete_id}-{column}"


def _fill_every_private_table(athlete_id: int) -> None:
    """One row per private relation, through the base tables."""
    con = connect()
    try:
        for table in PRIVATE_TABLES:
            columns = [
                (name, kind)
                for name, kind, *_ in con.execute(f"DESCRIBE app.{table}").fetchall()
                if name != "deleted_at"
            ]
            values = [_value(table, n, k, athlete_id) for n, k in columns]
            names = ", ".join(f'"{n}"' for n, _ in columns)
            marks = ", ".join("?" * len(columns))
            con.execute(
                f"INSERT INTO app.{table} ({names}) VALUES ({marks}) "
                "ON CONFLICT DO NOTHING",
                values,
            )
    finally:
        con.close()


def _fill_through_services(athlete_id: int, subject: str) -> None:
    """The real writers: journal, document chunks, push, files, Slack links."""
    from arete.services import documents, memory, notifications

    with athlete_scope(athlete_id):
        memory.append_entry("notes.md", "Genou", "Gêne au genou gauche.")
        raw = b"private document"
        thread = str(uuid4())
        doc = documents.begin_upload(
            thread, "bilan.txt", len(raw), sha256(raw).hexdigest()
        )
        documents.put_chunk(thread, doc["id"], 0, raw)
        notifications.subscribe(f"https://push.test/{subject}", "key", "auth")
        for relative in ("garmin_tokens/garmin_tokens.json", "fit_files/1.fit"):
            path = config.data_dir / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"private")
    con = connect()
    try:
        con.execute(
            "INSERT INTO app.slack_identities "
            "(team_id, slack_user_id, email, account_id, athlete_id, timezone) "
            "VALUES ('T1', ?, 'x@example.com', ?, ?, 'Europe/Paris')",
            [f"U-{subject}", subject, athlete_id],
        )
        con.execute(
            "INSERT INTO app.slack_private_threads (thread_id, account_id) VALUES (?, ?)",
            [f"thread-{subject}", subject],
        )
        con.execute(
            "INSERT INTO app.slack_operations (operation_id, event_key, account_id, "
            "team_id, action, target_id, channel_id, body, status) "
            "VALUES (?, 'e', ?, 'T1', 'schedule', 't', 'c', 'message privé', 'sent')",
            [f"op-{subject}", subject],
        )
        con.execute(
            "INSERT INTO app.slack_athletes (athlete_id) VALUES (?)", [athlete_id]
        )
    finally:
        con.close()


def _counts(athlete_id: int, subject: str) -> dict[str, int]:
    """Rows of each private and account table held by the athlete or its login."""
    con = connect()
    try:
        counts = {
            table: con.execute(
                f"SELECT count(*) FROM app.{table} WHERE {owner_column(table)}=?",
                [athlete_id],
            ).fetchone()[0]
            for table in PRIVATE_TABLES
        }
        for table, column in ACCOUNT_TABLES.items():
            counts[table] = con.execute(
                f"SELECT count(*) FROM app.{table} WHERE {column}=?", [athlete_id]
            ).fetchone()[0]
        counts["users.clerk_user_id"] = con.execute(
            "SELECT count(*) FROM app.users WHERE clerk_user_id=?", [subject]
        ).fetchone()[0]
        for table in LOGIN_TABLES:
            counts[f"{table}.account_id"] = con.execute(
                f"SELECT count(*) FROM app.{table} WHERE account_id=?", [subject]
            ).fetchone()[0]
    finally:
        con.close()
    return counts


def _data_dir(athlete_id: int):
    with athlete_scope(athlete_id):
        return config.data_dir


def test_deletion_erases_every_row_and_file_of_one_athlete_only(
    client, accounts, clerk
):
    ana, bob = accounts[ANA], accounts[BOB]
    for athlete_id, subject in ((ana, ANA), (bob, BOB)):
        _fill_every_private_table(athlete_id)
        _fill_through_services(athlete_id, subject)
    before = _counts(ana, ANA)
    assert all(before.values()), [t for t, n in before.items() if not n]
    bob_before = _counts(bob, BOB)

    refused = client.post(
        "/auth/me/delete", json={"confirmation": "supprimer"}, headers=_bearer(ANA)
    )
    assert refused.status_code == 422
    assert "SUPPRIMER" in refused.json()["detail"]
    assert _counts(ana, ANA) == before

    response = client.post(
        "/auth/me/delete", json={"confirmation": "SUPPRIMER"}, headers=_bearer(ANA)
    )
    assert response.status_code == 204
    assert clerk == [ANA]
    left = {table: n for table, n in _counts(ana, ANA).items() if n}
    assert left == {}
    assert _counts(bob, BOB) == bob_before
    assert not _data_dir(ana).exists()
    assert (_data_dir(bob) / "fit_files/1.fit").exists()

    con = connect()
    log = con.execute("SELECT * FROM app.account_deletions").fetchall()
    con.close()
    # The day and a one-way hash, nothing that names the account.
    assert log == [(sha256(ANA.encode()).hexdigest(), date.today())]

    # A session token outlives the account by a minute: no fresh athlete.
    again = client.get("/auth/me", headers=_bearer(ANA))
    assert again.status_code == 403
    assert again.json()["detail"] == "Ce compte a été supprimé."
    assert _counts(ana, ANA)["users.clerk_user_id"] == 0
    assert client.get("/auth/me", headers=_bearer(BOB)).status_code == 200


def test_the_last_administrator_cannot_delete_their_account(client, accounts, clerk):
    owner = accounts[OWNER]
    _fill_every_private_table(owner)
    before = _counts(owner, OWNER)
    refused = client.post(
        "/auth/me/delete", json={"confirmation": "SUPPRIMER"}, headers=_bearer(OWNER)
    )
    assert refused.status_code == 409
    assert "seul administrateur" in refused.json()["detail"]
    assert _counts(owner, OWNER) == before
    assert clerk == []

    # Once Bob administers too, the owner may leave; their address claims an
    # empty athlete 1 again with a new login.
    con = connect()
    con.execute("UPDATE app.users SET role='admin' WHERE clerk_user_id=?", [BOB])
    con.close()
    auth.forget_accounts()
    deleted = client.post(
        "/auth/me/delete", json={"confirmation": "SUPPRIMER"}, headers=_bearer(OWNER)
    )
    assert deleted.status_code == 204
    assert clerk == [OWNER]
    assert not any(_counts(owner, OWNER).values())
    back = client.get("/auth/me", headers=_bearer("user_owner_again"))
    assert back.status_code == 200
    assert (back.json()["athlete_id"], back.json()["is_owner"]) == (1, True)
    assert client.get("/goals", headers=_bearer("user_owner_again")).json() == []


def test_a_clerk_failure_is_reported_once_the_data_is_gone(
    client, accounts, monkeypatch
):
    ana = accounts[ANA]
    _fill_every_private_table(ana)
    calls: list[str] = []

    def fail(subject: str) -> bool:
        calls.append(subject)
        return False

    monkeypatch.setattr(auth, "_delete_clerk_user", fail)
    response = client.post(
        "/auth/me/delete", json={"confirmation": "SUPPRIMER"}, headers=_bearer(ANA)
    )
    assert response.status_code == 502
    assert "données sont effacées" in response.json()["detail"]
    assert calls == [ANA]  # one request, never retried
    assert not any(_counts(ana, ANA).values())
    # The surviving Clerk login opens nothing any more.
    assert client.get("/auth/me", headers=_bearer(ANA)).status_code == 403


def test_the_clerk_call_is_one_request_without_retries(monkeypatch):
    """The SDK retries a 5XX for up to an hour by default."""
    import clerk_backend_api

    seen: dict = {}

    class Users:
        def delete(self, **kwargs):
            seen.update(kwargs)
            raise ConnectionError("Clerk unreachable")

    class FakeClerk:
        def __init__(self, **kwargs):
            seen["timeout_ms"] = kwargs["timeout_ms"]
            self.users = Users()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(clerk_backend_api, "Clerk", FakeClerk)
    assert auth._delete_clerk_user("user_x") is False
    assert seen == {"user_id": "user_x", "retries": None, "timeout_ms": 10_000}


def test_only_a_signed_in_login_deletes_itself(client, monkeypatch):
    monkeypatch.delenv("ARETE_AUTH", raising=False)
    response = client.post("/auth/me/delete", json={"confirmation": "SUPPRIMER"})
    assert response.status_code == 403


def test_every_table_with_personal_data_is_erased(accounts):
    """A new table holding an athlete or a login must join the erasure."""
    con = connect()
    tables = con.execute(
        "SELECT table_name, list(column_name) FROM duckdb_columns() "
        "WHERE database_name=current_database() AND schema_name='app' "
        "AND table_name IN (SELECT table_name FROM duckdb_tables() "
        "WHERE database_name=current_database() AND schema_name='app') "
        "GROUP BY table_name"
    ).fetchall()
    con.close()
    personal = {
        table
        for table, columns in tables
        if table not in PRIVATE_TABLES and PERSONAL_COLUMNS & set(columns)
    }
    # ``app.athletes`` is the athlete itself: its key is ``id``.
    assert personal == (set(ACCOUNT_TABLES) | set(LOGIN_TABLES)) - {"athletes"}
