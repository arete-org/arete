"""MotherDuck: one connection per process, a cursor per caller."""

from __future__ import annotations

import os
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import duckdb
import pytest
import yaml

from arete.config import config
from arete.dataio import db


@pytest.fixture
def remote(monkeypatch):
    monkeypatch.setenv("ARETE_DB", "md:arete_v2")
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
    assert db.remote_database() == "arete_v2"


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
    raw.execute.assert_any_call("USE arete_v2")
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


@pytest.mark.parametrize("home", [None, "", "/home/vercel-missing"])
def test_motherduck_gets_a_home_that_exists(tmp_path, monkeypatch, home):
    monkeypatch.setattr(db, "REMOTE_HOME", tmp_path / "home")
    monkeypatch.setattr(db, "BUNDLED_EXTENSIONS", tmp_path / "missing")
    if home is None:
        monkeypatch.delenv("HOME", raising=False)
    else:
        monkeypatch.setenv("HOME", home)
    with patch.object(db.duckdb, "connect"):
        db._open_remote()
    assert os.environ["HOME"] == str(tmp_path / "home")


def test_a_read_only_home_is_replaced(tmp_path, monkeypatch):
    read_only = tmp_path / "ro"
    read_only.mkdir(mode=0o500)
    monkeypatch.setattr(db, "REMOTE_HOME", tmp_path / "home")
    monkeypatch.setattr(db, "BUNDLED_EXTENSIONS", tmp_path / "missing")
    monkeypatch.setenv("HOME", str(read_only))
    with patch.object(db.duckdb, "connect"):
        db._open_remote()
    assert os.environ["HOME"] == str(tmp_path / "home")


def test_an_existing_home_is_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "REMOTE_HOME", tmp_path / "home")
    monkeypatch.setattr(db, "BUNDLED_EXTENSIONS", tmp_path / "missing")
    monkeypatch.setenv("HOME", str(tmp_path))
    with patch.object(db.duckdb, "connect"):
        db._open_remote()
    assert os.environ["HOME"] == str(tmp_path)


@pytest.mark.parametrize("target", ["md:arete_v2", "md:"])
def test_preview_cannot_open_production_motherduck(monkeypatch, target):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("ARETE_DB", target)
    with patch.object(db, "_remote_cursor") as remote_cursor:
        with pytest.raises(RuntimeError, match="separate ARETE_DB"):
            db.connect()
        remote_cursor.assert_not_called()


def test_preview_can_open_a_separate_database(monkeypatch, opened):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("ARETE_DB", "md:arete_preview_v2")
    db.connect()
    opened[0].cursor.return_value.execute.assert_any_call("USE arete_preview_v2")


def test_a_preview_name_is_matched_whatever_its_case(monkeypatch, opened):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("ARETE_DB", "md:Arete_Preview_v2")
    db.connect()
    assert len(opened) == 1


@pytest.mark.parametrize("vercel", [None, "preview", "production"])
@pytest.mark.parametrize("target", ["md:arete", "md:ARETE_PREVIEW"])
def test_the_retired_trial_databases_are_refused_everywhere(
    monkeypatch, vercel, target
):
    # A stack left on them would migrate nothing and double the automations.
    if vercel:
        monkeypatch.setenv("VERCEL_ENV", vercel)
    else:
        monkeypatch.delenv("VERCEL_ENV", raising=False)
    monkeypatch.setenv("ARETE_DB", target)
    with patch.object(db, "_remote_cursor") as remote_cursor:
        with pytest.raises(RuntimeError, match="retired"):
            db.connect()
        remote_cursor.assert_not_called()


def test_a_refusal_names_the_database_without_its_options(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("ARETE_DB", "md:arete_v2?motherduck_token=secret")
    with pytest.raises(RuntimeError) as refused:
        db.connect()
    assert "arete_v2" in str(refused.value)
    assert "secret" not in str(refused.value)


def compose_database_default() -> str:
    compose = yaml.safe_load(
        (Path(__file__).parents[1] / "docker-compose.yml").read_text()
    )
    entries = compose["services"]["backend"]["environment"]
    (entry,) = [e for e in entries if e.startswith("ARETE_DB=")]
    match = re.fullmatch(r"ARETE_DB=\$\{ARETE_DB:-(.+)\}", entry)
    assert match, f"the shell or .env must still override it: {entry}"
    return match.group(1)


def test_the_env_example_leaves_the_compose_default_in_place():
    # Compose interpolation reads .env, which `make docker` copies from here.
    lines = (Path(__file__).parents[1] / ".env.example").read_text().splitlines()
    assert not [line for line in lines if line.startswith("ARETE_DB=")]


def test_the_docker_stack_defaults_to_the_preview_database(monkeypatch, caplog):
    default = compose_database_default()
    assert default != "md:arete_v2"
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("ARETE_DB", default)
    db.warn_production_database()
    assert config.is_remote_db is True
    assert caplog.records == []


def test_production_outside_vercel_logs_a_warning(monkeypatch, caplog):
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("ARETE_DB", "md:arete_v2?motherduck_token=secret")
    db.warn_production_database()
    (record,) = caplog.records
    assert record.levelname == "WARNING"
    assert "arete_v2" in record.getMessage()
    assert "secret" not in record.getMessage()


@pytest.mark.parametrize(
    ("vercel", "target"),
    [
        ("1", "md:arete_v2"),
        (None, "md:Arete_Preview_v2"),
        (None, "data/arete.duckdb"),
    ],
)
def test_no_production_warning_elsewhere(monkeypatch, caplog, vercel, target):
    if vercel:
        monkeypatch.setenv("VERCEL", vercel)
    else:
        monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("ARETE_DB", target)
    db.warn_production_database()
    assert caplog.records == []
