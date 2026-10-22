"""The data directory survives an instance through the database."""

from __future__ import annotations

from collections.abc import Callable

import duckdb
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arete.config import config
from arete.dataio import mirror


@pytest.fixture
def store(tmp_path, monkeypatch) -> Callable[[], duckdb.DuckDBPyConnection]:
    """A local DuckDB file stands in for MotherDuck."""
    path = str(tmp_path / "store.duckdb")
    from arete.dataio.db import configure_athlete
    from arete.dataio.init_duckdb import main as init_schema

    monkeypatch.setenv("ARETE_DB", path)
    init_schema()

    def local_connection():
        con = duckdb.connect(path)
        configure_athlete(con)
        return con

    monkeypatch.setattr(mirror, "connect", local_connection)
    mirror.reset()
    yield local_connection
    mirror.reset()


def _use_data_dir(monkeypatch, path):
    monkeypatch.setenv("ARETE_DATA_DIR", str(path))
    return path


def _stored(store) -> dict[str, bytes]:
    with store() as con:
        return dict(con.execute("SELECT path, content FROM app.files").fetchall())


def test_new_files_are_stored(store, tmp_path, monkeypatch):
    root = _use_data_dir(monkeypatch, tmp_path / "data")
    mirror.hydrate()
    (root / "garmin_tokens").mkdir(parents=True)
    (root / "garmin_tokens/profile.json").write_text("seuil 176")
    assert mirror.flush() == 1
    assert _stored(store) == {"garmin_tokens/profile.json": b"seuil 176"}


def test_a_fresh_instance_gets_the_stored_files(store, tmp_path, monkeypatch):
    first = _use_data_dir(monkeypatch, tmp_path / "first")
    mirror.hydrate()
    (first / "garmin_tokens").mkdir(parents=True)
    (first / "garmin_tokens/oauth.json").write_text("{}")
    mirror.flush()

    mirror.reset()
    second = _use_data_dir(monkeypatch, tmp_path / "second")
    assert mirror.hydrate() == 1
    assert (second / "garmin_tokens/oauth.json").read_text() == "{}"


def test_unchanged_files_are_not_written_again(store, tmp_path, monkeypatch):
    root = _use_data_dir(monkeypatch, tmp_path / "data")
    mirror.hydrate()
    root.mkdir()
    (root / "dictation_misses.jsonl").write_text("a\n")
    mirror.flush()
    assert mirror.flush() == 0


def test_stale_copy_does_not_overwrite_another_instance(store, tmp_path, monkeypatch):
    root = _use_data_dir(monkeypatch, tmp_path / "data")
    (root / "garmin_tokens").mkdir(parents=True)
    (root / "garmin_tokens/notes.json").write_text("v1")
    mirror.hydrate()
    mirror.flush()
    with store() as con:  # another instance stores v2 meanwhile
        con.execute(
            "UPDATE app.files SET content = 'v2' WHERE path = 'garmin_tokens/notes.json'"
        )
    assert mirror.flush() == 0
    assert _stored(store) == {"garmin_tokens/notes.json": b"v2"}


def test_deleted_files_are_removed(store, tmp_path, monkeypatch):
    root = _use_data_dir(monkeypatch, tmp_path / "data")
    root.mkdir()
    (root / "last_daily_sync.json").write_text("{}")
    mirror.hydrate()
    mirror.flush()
    (root / "last_daily_sync.json").unlink()
    assert mirror.flush() == 1
    assert _stored(store) == {}


def test_a_file_outside_the_list_is_neither_hashed_nor_stored(
    store, tmp_path, monkeypatch
):
    root = _use_data_dir(monkeypatch, tmp_path / "data")
    mirror.hydrate()
    config.fit_dir.mkdir(parents=True)
    (config.fit_dir / "1.fit").write_bytes(b"\x00")
    (root / "arete.duckdb").write_bytes(b"\x00")
    hashed: list[bytes] = []
    monkeypatch.setattr(mirror, "_digest", lambda data: hashed.append(data) or "")
    assert mirror.flush() == 0
    assert hashed == []
    assert _stored(store) == {}


def test_hydrate_leaves_foreign_rows_on_the_server(store, tmp_path, monkeypatch):
    root = _use_data_dir(monkeypatch, tmp_path / "data")
    with store() as con:
        con.execute(mirror.DDL)
        con.execute(
            "INSERT INTO app.files (path, content) VALUES "
            "('arete.duckdb', 'big'), ('garmin_tokens/garmin_tokens.json', '{}')"
        )
    assert mirror.hydrate() == 1
    assert not (root / "arete.duckdb").exists()
    mirror.flush()
    assert set(_stored(store)) == {"arete.duckdb", "garmin_tokens/garmin_tokens.json"}


def test_a_status_read_does_not_undo_another_instance_logout(
    store, tmp_path, monkeypatch
):
    """Instance A reads the tokens while instance B logs out: they stay out."""
    from arete.garmin import token_store

    root = _use_data_dir(monkeypatch, tmp_path / "data")
    mirror.hydrate()  # A started before any login
    with store() as con:  # B logs in
        con.execute(
            "INSERT INTO app.files (path, content) VALUES (?, '{\"t\": 1}'), (?, '{}')",
            [token_store.TOKEN_PATH, token_store.ACCOUNT_PATH],
        )
    # A's GET /garmin/status: has_tokens rewrites the local copies.
    assert token_store.hydrate(root / token_store.TOKEN_PATH)
    with store() as con:  # B logs out meanwhile
        con.execute("DELETE FROM app.files")
    assert mirror.flush() == 0  # A's request ends: nothing written back
    assert _stored(store) == {}


def test_tokens_kept_outside_the_data_directory_stay_out_of_the_flush(
    store, tmp_path, monkeypatch
):
    """``ARETE_GARMIN_TOKENS_DIR``: the mirror never walks those files."""
    from arete.garmin import token_store

    _use_data_dir(monkeypatch, tmp_path / "data")
    tokens = tmp_path / "elsewhere"
    monkeypatch.setenv("ARETE_GARMIN_TOKENS_DIR", str(tokens))
    mirror.hydrate()
    with store() as con:
        con.execute(
            "INSERT INTO app.files (path, content) VALUES (?, '{\"t\": 1}'), (?, '{}')",
            [token_store.TOKEN_PATH, token_store.ACCOUNT_PATH],
        )
    assert token_store.hydrate(tokens / token_store.TOKEN_FILE)
    # Recorded as mirrored, they would read as deleted: a logout everywhere.
    assert mirror.flush() == 0
    assert set(_stored(store)) == {token_store.TOKEN_PATH, token_store.ACCOUNT_PATH}


def test_middleware_is_inert_on_a_local_database(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(mirror, "hydrate", lambda: calls.append("hydrate"))
    monkeypatch.setattr(mirror, "flush", lambda: calls.append("flush"))
    app = FastAPI()
    app.add_middleware(mirror.MirrorMiddleware)
    app.get("/ping")(lambda: "pong")
    assert TestClient(app).get("/ping").status_code == 200
    assert calls == []


def test_middleware_hydrates_then_flushes_on_a_remote_database(monkeypatch):
    calls: list[str] = []
    monkeypatch.setenv("ARETE_DB", "md:arete_v2")
    monkeypatch.setattr(mirror, "hydrate", lambda: calls.append("hydrate"))
    monkeypatch.setattr(mirror, "flush", lambda: calls.append("flush"))
    app = FastAPI()
    app.add_middleware(mirror.MirrorMiddleware)
    app.post("/ping")(lambda: calls.append("handler") or "pong")
    assert TestClient(app).post("/ping").status_code == 200
    assert calls == ["hydrate", "handler", "flush"]


def test_a_read_only_request_skips_the_flush(monkeypatch):
    """The dashboard's GETs paid a walk and a hash of every mirrored file each."""
    calls: list[str] = []
    monkeypatch.setenv("ARETE_DB", "md:arete_v2")
    monkeypatch.setattr(mirror, "hydrate", lambda: calls.append("hydrate"))
    monkeypatch.setattr(mirror, "flush", lambda: calls.append("flush"))
    app = FastAPI()
    app.add_middleware(mirror.MirrorMiddleware)
    app.get("/ping")(lambda: calls.append("handler") or "pong")
    client = TestClient(app)
    assert client.get("/ping").status_code == 200
    assert client.head("/ping").status_code in (200, 405)
    assert calls == ["hydrate", "handler", "hydrate"]


def _remote_app(monkeypatch, path: str, handler) -> TestClient:
    """A remote database whose mirror writes to the local store fixture."""
    monkeypatch.setenv("ARETE_DB", "md:arete_v2")
    app = FastAPI()
    app.add_middleware(mirror.MirrorMiddleware)
    app.get(path)(handler)
    return TestClient(app)


def test_a_get_that_refreshes_garmin_tokens_stores_them(store, tmp_path, monkeypatch):
    """The SDK rewrites the token file when it refreshes, during any request.

    The handler is sync: it runs in a worker thread, in a copied context.
    """
    from arete.garmin.client import TOKEN_FILE, GarminClient

    _use_data_dir(monkeypatch, tmp_path / "data")

    def status() -> dict:
        client = GarminClient(config.garmin_tokens_dir)
        present = client.has_tokens()
        client.token_dir.mkdir(parents=True, exist_ok=True)
        client.token_file.write_text('{"refreshed": true}')  # the SDK's dump
        return {"present": present}

    client = _remote_app(monkeypatch, "/garmin/status", status)
    assert client.get("/garmin/status").status_code == 200
    assert _stored(store) == {f"garmin_tokens/{TOKEN_FILE}": b'{"refreshed": true}'}
