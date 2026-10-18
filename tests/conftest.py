"""Pytest configuration and fixtures for Arete tests."""

import os
import tempfile
import time
from collections.abc import Callable, Generator
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient


def _server_zone_on_another_day(athlete_zone: str) -> str:
    """A server timezone whose date is not the athlete's at this moment.

    Services date the athlete's day with ``athlete_today()``; a fixture dated
    with the server's ``date.today()`` only breaks while the two dates differ
    (22:00-24:00 UTC for Paris, ARE-109). UTC+14 is on another date than Paris
    from about noon to midnight, UTC-11 from midnight to about noon: every run
    exercises the divergent case, the server ahead or behind the athlete.
    """
    now = datetime.now(UTC)
    athlete_day = now.astimezone(ZoneInfo(athlete_zone)).date()
    for zone in ("Pacific/Kiritimati", "Pacific/Pago_Pago"):
        if now.astimezone(ZoneInfo(zone)).date() != athlete_day:
            return zone
    raise AssertionError(f"no candidate timezone is a day apart from {athlete_zone}")


# Before importing app modules: DuckDB reads TZ once, when it is imported.
# Europe/Paris is the default athlete timezone (services.settings.DEFAULT_TIMEZONE).
os.environ["TZ"] = _server_zone_on_another_day("Europe/Paris")
time.tzset()

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


@pytest.fixture(autouse=True)
def fresh_account_cache() -> Generator[None, None, None]:
    """Tests rewrite app.users directly: never serve a previous test's account."""
    from arete.api.auth import forget_accounts

    forget_accounts()
    yield
    forget_accounts()


@pytest.fixture
def give_consent() -> Callable[..., None]:
    """Record each athlete's consent to the current texts, as the gate would."""
    from arete.services import consent

    def give(*athlete_ids: int) -> None:
        for athlete_id in athlete_ids:
            consent.give(
                athlete_id,
                None,
                terms_version=consent.TERMS_VERSION,
                privacy_version=consent.PRIVACY_VERSION,
                terms_accepted=True,
                health_data=True,
            )

    return give


@pytest.fixture
def consented(monkeypatch) -> None:
    """Every athlete has consented: for sign-in tests about something else,
    whose accounts appear at their first request. The gate itself is tested
    in ``test_consent.py``."""
    from arete.services import consent

    monkeypatch.setattr(consent, "is_current", lambda athlete_id: True)


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


@pytest.fixture(autouse=True)
def isolated_coach_records():
    """Durable memory replaces per-test filesystem isolation."""
    from arete.dataio.db import db_connection

    with db_connection() as con:
        for table in ("coach_memory_files", "coach_memory_imports", "coach_followups"):
            con.execute(f"DELETE FROM app.{table}")


@pytest.fixture
def memory_tool():
    """Exercise the async native tool with server-owned invocation context."""
    import asyncio

    from langchain.tools import ToolRuntime

    from arete.agent.runtime.context import AgentContext
    from arete.agent.tools.fact_memory import remember_fact

    def invoke(args, *, message="Déclaration : je préfère le matin", context=None):
        context = context or AgentContext(thread_id="memory-test")
        context.memory_source_message = message
        runtime = ToolRuntime(
            state={},
            context=context,
            config={},
            stream_writer=lambda _: None,
            tool_call_id="memory",
            store=None,
        )
        return asyncio.run(remember_fact.ainvoke({**args, "runtime": runtime}))

    return invoke


@pytest.fixture
def jev_api(monkeypatch):
    """Mock only HTTP so routing tests exercise Jev parsing and real trace spans."""
    import json
    from types import SimpleNamespace
    from unittest.mock import Mock

    import httpx

    api = SimpleNamespace(
        payload={
            "model": "typesafe/jev-1.13-20260917",
            "answers": {
                "surface": {"type": "choice", "choice": "product"},
                "private_data": {"type": "choice", "choice": "no"},
                "outbound": {"type": "choice", "choice": "no"},
            },
            "usage": {"input_tokens": 476, "output_tokens": 70, "cost": 0.000019992},
        },
        requests=[],
        status=200,
        handler=None,
    )

    async def handle(request):
        api.requests.append(request)
        assert request.url == "https://openrouter.ai/api/alpha/decisions"
        assert json.loads(request.content)["model"] == "typesafe/jev-1.13"
        if api.handler is not None:
            return await api.handler(request)
        return httpx.Response(api.status, json=api.payload)

    api.transport = Mock(side_effect=lambda **kw: httpx.MockTransport(handle))
    monkeypatch.setattr(httpx, "AsyncHTTPTransport", api.transport)
    return api
