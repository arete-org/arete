"""Readers must coexist with writers during concurrent dashboard requests."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier, Event

import duckdb
import pytest

from arete.dataio.db import connect, db_connection, reuse_connections
from arete.dataio.init_duckdb import main as init_schema
from arete.dataio.settings import get_user_settings
from arete.features.banister import load_coefficients
from arete.services.metrics import get_player_stats


def test_local_opens_are_serialized_but_queries_can_overlap(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "concurrent.duckdb"))
    original_connect = duckdb.connect
    opening, release, second_started, overlapping = (Event() for _ in range(4))
    querying = Barrier(2, timeout=5)

    def paused_connect(*args, **kwargs):
        if opening.is_set():
            overlapping.set()
        else:
            opening.set()
            assert release.wait(timeout=5)
        return original_connect(*args, **kwargs)

    def read(second=False):
        if second:
            second_started.set()
        with closing(connect()) as con:
            # Holding the lock for the connection's lifetime would deadlock here.
            querying.wait()
            return con.execute("SELECT 1").fetchone()

    monkeypatch.setattr(duckdb, "connect", paused_connect)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(read)
        try:
            assert opening.wait(timeout=5)
            second = pool.submit(read, True)
            assert second_started.wait(timeout=5)
            assert not overlapping.wait(timeout=0.1)
        finally:
            release.set()
        assert first.result(timeout=5) == (1,)
        assert second.result(timeout=5) == (1,)


def test_failed_local_open_is_not_retried_and_releases_lock(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "failed.duckdb"))
    original_connect = duckdb.connect
    attempts = 0

    def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise duckdb.IOException("cannot open database")
        return original_connect(*args, **kwargs)

    monkeypatch.setattr(duckdb, "connect", fail_once)
    with pytest.raises(duckdb.IOException, match="cannot open database"):
        connect()
    assert attempts == 1
    with closing(connect()) as con:
        assert con.execute("SELECT 1").fetchone() == (1,)
    assert attempts == 2


def test_dashboard_readers_coexist_with_writer(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "connections.duckdb"))
    init_schema()
    # Keep the writer open: sequential requests hide DuckDB's mode conflict.
    with closing(connect()) as writer:
        with db_connection() as reader:
            assert reader.execute("SELECT 1").fetchone() == (1,)
        assert get_player_stats().level == 0
        assert load_coefficients() is None
        get_user_settings(user_id=1)
        assert writer.execute("SELECT 1").fetchone() == (1,)


def _opened(monkeypatch) -> list:
    """The raw connections DuckDB opens from now on."""
    opened = []
    original_connect = duckdb.connect

    def recording(*args, **kwargs):
        opened.append(original_connect(*args, **kwargs))
        return opened[-1]

    monkeypatch.setattr(duckdb, "connect", recording)
    return opened


def test_a_run_reuses_the_connections_its_calls_close(monkeypatch):
    opened = _opened(monkeypatch)
    with reuse_connections():
        for _ in range(3):
            with db_connection() as con:
                assert con.execute("SELECT 1").fetchone() == (1,)
        # Held at once, two calls never share one.
        with db_connection() as outer, db_connection() as inner:
            outer.execute("BEGIN TRANSACTION")
            inner.execute("SELECT 1")
            outer.execute("ROLLBACK")
    assert len(opened) == 2
    with db_connection():
        pass
    assert len(opened) == 3


def test_an_unfinished_or_failed_connection_is_not_reused(monkeypatch):
    opened = _opened(monkeypatch)
    with reuse_connections():
        con = connect()
        con.execute("BEGIN TRANSACTION")
        con.close()  # rolls back
        idle, failing = connect(), connect()
        idle.close()
        with pytest.raises(duckdb.Error):
            failing.execute("SELECT * FROM app.no_such_table")
        failing.close()  # and the idle one with it: the connection may be lost
        with db_connection():
            pass
        assert len(opened) == 4
        # Closed twice, a connection is handed back once.
        first = connect()
        first.close()
        first.close()
        second, third = connect(), connect()
        assert len(opened) == 5
        second.close()
        third.close()
        with pytest.raises(duckdb.ConnectionException):
            third.fetchall()


SESSION = "SELECT current_database(), current_schema(), current_setting('search_path')"


def test_a_reused_connection_has_a_new_ones_session(monkeypatch):
    opened = _opened(monkeypatch)
    with reuse_connections():
        with db_connection() as con:
            fresh = con.execute(SESSION).fetchone()
            con.execute("SET search_path = 'app'")
            assert con.execute(SESSION).fetchone() != fresh
        with db_connection() as con:
            assert con.execute(SESSION).fetchone() == fresh
            con.execute("SET threads = 2")
        with db_connection():
            pass
    # The repositories' search path is undone; any other setting closes it.
    assert len(opened) == 2


def test_a_connection_idle_too_long_is_not_reused(monkeypatch):
    from arete.dataio import db

    opened = _opened(monkeypatch)
    with reuse_connections():
        db_connection().__enter__().close()
        monkeypatch.setattr(db, "MAX_IDLE_SECONDS", 0.0)
        with db_connection():
            pass
    assert len(opened) == 2


def test_a_failed_fetch_is_not_reused():
    from unittest.mock import MagicMock

    from arete.dataio.db import _Idle, _Lease

    con, idle, owner = MagicMock(), _Idle(), (1, None)
    con.fetchone.side_effect = duckdb.ConnectionException("lost")
    lease = _Lease(con, idle, owner)
    with pytest.raises(duckdb.ConnectionException):
        lease.fetchone()
    lease.close()
    con.close.assert_called_once()
    assert idle.take(owner) is None


def test_a_connection_serves_only_its_athlete(monkeypatch):
    from arete.services.athlete_scope import athlete_scope

    opened = _opened(monkeypatch)
    with reuse_connections():
        with athlete_scope(1), db_connection():
            pass
        with athlete_scope(2), db_connection() as con:
            assert (
                con.execute("SELECT getvariable('arete_athlete_id')").fetchone()[0] == 2
            )
    assert len(opened) == 2
