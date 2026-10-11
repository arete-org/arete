"""Pytest configuration and fixtures for Arete tests."""

import os
import tempfile
from collections.abc import Callable, Generator
from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

# Set test database path before importing app modules
_test_db_dir = tempfile.mkdtemp()
os.environ["ARETE_DB"] = str(Path(_test_db_dir) / "test_arete.duckdb")
# A developer's .env may enable tracing; normal tests must remain offline.
# Dedicated tracing tests opt in with an in-memory transport.
os.environ["LANGSMITH_TRACING"] = "false"


@pytest.fixture(scope="session")
def test_db_path() -> Path:
    """Return the path to the test database."""
    return Path(os.environ["ARETE_DB"])


@pytest.fixture(scope="session", autouse=True)
def setup_test_db() -> Generator[None, None, None]:
    """Initialize the test database before running tests."""
    from arete.dataio.init_duckdb import main as init_db

    init_db()
    yield
    # Cleanup after all tests
    db_path = Path(os.environ["ARETE_DB"])
    if db_path.exists():
        db_path.unlink()


@pytest.fixture(autouse=True)
def no_inherited_clerk_jwt_key(monkeypatch) -> None:
    """A developer's .env may hold the real Clerk key: tests set their own."""
    monkeypatch.delenv("CLERK_JWT_KEY", raising=False)


@pytest.fixture(autouse=True)
def offline_weather(monkeypatch) -> None:
    """Sync and upload paths enrich sessions: Open-Meteo is never called.

    Tests of the client itself give ``fetch_weather`` a mock transport.
    """
    monkeypatch.setattr(
        "arete.services.session_conditions.fetch_weather",
        lambda *args, **kwargs: None,
    )


class _CountingConnection:
    """A DuckDB connection that records every statement it runs."""

    def __init__(self, con, log: list[str]):
        self._con = con
        self._log = log

    def execute(self, sql, *args):
        self._log.append(sql)
        return self._con.execute(sql, *args)

    def __getattr__(self, name):
        return getattr(self._con, name)


class StatementLog(list):
    """Statements run through the connections it wrapped."""

    def wrap(self, con):
        return _CountingConnection(con, self)


@pytest.fixture
def statement_log() -> StatementLog:
    """Count round trips: wrap the connections a code path opens."""
    return StatementLog()


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    """Create a test client for the FastAPI app."""
    from arete.api.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def router_client() -> Callable[[APIRouter], TestClient]:
    """Build a TestClient around a single router (no lifespan, no other routes)."""

    def make(router: APIRouter) -> TestClient:
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    return make
