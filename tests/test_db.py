"""MotherDuck: one connection per process, a cursor per caller."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import duckdb
import pytest

from arete.config import config
from arete.dataio import db


@pytest.fixture
def remote(monkeypatch):
    monkeypatch.setenv("ARETE_DB", "md:arete")
    db.reset_remote()
    yield
    db.reset_remote()


@pytest.fixture
def opened(remote):
    """Each call to the patched ``_open_remote`` returns a new mock connection."""
    connections: list[MagicMock] = []

    def open_remote():
        con = MagicMock(name=f"connection{len(connections)}")
        connections.append(con)
        return con

    with patch.object(db, "_open_remote", side_effect=open_remote):
        yield connections


def test_md_target_is_remote(remote):
    assert config.is_remote_db is True
    assert db.remote_database() == "arete"


def test_file_target_is_local(monkeypatch, tmp_path):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "x.duckdb"))
    assert config.is_remote_db is False


def test_remote_connection_is_opened_once(opened):
    db.connect()
    db.connect()
    assert len(opened) == 1


def test_each_remote_caller_gets_a_cursor_on_the_database(opened):
    cursor = db.connect()
    raw = opened[0].cursor.return_value
    assert cursor._con is raw  # wrapped to count the request's statements
    raw.execute.assert_any_call("USE arete")
    raw.execute.assert_called_with("SET VARIABLE arete_athlete_id = ?", [1])


def test_a_dead_remote_connection_is_reopened(opened):
    db.connect()
    opened[0].cursor.side_effect = duckdb.ConnectionException("gone")
    cursor = db.connect()
    assert len(opened) == 2
    assert cursor._con is opened[1].cursor.return_value


def test_a_remote_that_stays_down_raises(opened):
    db.connect()
    opened[0].cursor.side_effect = duckdb.ConnectionException("gone")
    with (
        patch.object(db, "_open_remote", return_value=opened[0]),
        pytest.raises(duckdb.ConnectionException),
    ):
        db.connect()


def test_remote_data_dir_is_under_tmp(remote, monkeypatch):
    monkeypatch.delenv("ARETE_DATA_DIR", raising=False)
    assert str(config.data_dir).startswith("/tmp")


def test_local_data_dir_sits_beside_the_database(monkeypatch, tmp_path):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "x.duckdb"))
    monkeypatch.delenv("ARETE_DATA_DIR", raising=False)
    assert config.data_dir == tmp_path
    assert config.fit_dir == tmp_path / "fit_files"


def test_bundled_extensions_are_seeded_once(tmp_path, monkeypatch):
    bundled = tmp_path / "bundle"
    (bundled / "v1.4.2/linux_amd64").mkdir(parents=True)
    (bundled / "v1.4.2/linux_amd64/motherduck.duckdb_extension").write_bytes(b"x")
    monkeypatch.setattr(db, "BUNDLED_EXTENSIONS", bundled)
    monkeypatch.setattr(db, "REMOTE_HOME", tmp_path / "home")
    db._seed_extensions()
    seeded = tmp_path / "home/.duckdb/extensions/v1.4.2/linux_amd64"
    assert (seeded / "motherduck.duckdb_extension").read_bytes() == b"x"
    (seeded / "motherduck_impl.duckdb_extension").write_bytes(b"later")
    db._seed_extensions()  # an existing directory is left as it is
    assert (seeded / "motherduck_impl.duckdb_extension").exists()


def test_without_a_bundle_nothing_is_seeded(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "BUNDLED_EXTENSIONS", tmp_path / "missing")
    monkeypatch.setattr(db, "REMOTE_HOME", tmp_path / "home")
    db._seed_extensions()
    assert not (tmp_path / "home/.duckdb").exists()


def test_preview_cannot_open_production_motherduck(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("ARETE_DB", "md:arete")
    with patch.object(db, "_remote_cursor") as remote_cursor:
        with pytest.raises(RuntimeError, match="separate ARETE_DB"):
            db.connect()
        remote_cursor.assert_not_called()


def test_preview_can_open_a_separate_database(monkeypatch, opened):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("ARETE_DB", "md:arete_preview")
    db.connect()
    opened[0].cursor.return_value.execute.assert_any_call("USE arete_preview")
