"""Tests for the API endpoints."""

from fastapi.testclient import TestClient


class TestHealth:
    """Tests for /health endpoint."""

    def test_health_returns_ok(self, client: TestClient):
        """Health endpoint should return status ok with database info."""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "database" in data

    def test_health_reports_the_schema_version(self, client: TestClient):
        from arete.dataio.init_duckdb import MIGRATIONS

        data = client.get("/health").json()
        assert data["database"] == "connected"
        assert data["schema_version"] == MIGRATIONS[-1][0]
        assert data["pending_migrations"] == []
        assert data["initialization"] == {"status": "ready"}

    def test_failed_boot_is_diagnosable_without_exposing_the_error(
        self, monkeypatch, caplog
    ):
        from arete.api import main as api_main
        from arete.dataio.init_duckdb import SchemaInitializationError

        attempts = []
        private_error = "SQL failed with private-value and token=secret"

        def fail_schema():
            attempts.append(True)
            raise SchemaInitializationError("migration:50", RuntimeError(private_error))

        with monkeypatch.context() as patch:
            patch.setattr(api_main, "init_schema", fail_schema)
            patch.setattr(api_main, "pending_migrations", lambda con: [50])
            patch.setattr(api_main.scheduler, "start", lambda: None)
            with TestClient(api_main.app) as client:
                caplog.clear()  # Startup logs alone cannot diagnose a warm instance.
                for _ in range(2):
                    response = client.get("/health")
                    assert response.status_code == 503
                    assert response.json()["initialization"] == {
                        "status": "failed",
                        "stage": "migration:50",
                        "error_type": "RuntimeError",
                    }
                    assert "private-value" not in response.text
                    assert "secret" not in response.text
                assert len(attempts) == 1  # Probes never replay a failed write.
                assert private_error in caplog.text

        # A fresh lifespan must not keep an earlier boot's failure in memory.
        with TestClient(api_main.app) as client:
            response = client.get("/health")
            assert response.status_code == 200
            assert response.json()["initialization"] == {"status": "ready"}
            assert api_main.app.state.schema_initialization_error is None

    def test_health_distinguishes_an_unstarted_lifespan(self):
        from fastapi import FastAPI

        from arete.api.main import health

        app = FastAPI()
        app.add_api_route("/health", health)
        # A bare ASGI client does not run startup, even when the DB is current.
        client = TestClient(app)
        assert client.get("/health").json()["initialization"] == {
            "status": "not_started"
        }

    def test_health_is_degraded_while_a_migration_is_pending(
        self, client: TestClient, monkeypatch
    ):
        # The boot swallows a failed migration; the probe must not hide it.
        from arete.api import main as api_main

        monkeypatch.setattr(api_main, "pending_migrations", lambda con: [99])
        response = client.get("/health")
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert data["pending_migrations"] == [99]


class TestCronDailySync:
    """Vercel Cron triggers the daily sync through /cron/daily-sync."""

    def test_closed_without_a_configured_secret(self, client: TestClient, monkeypatch):
        monkeypatch.delenv("CRON_SECRET", raising=False)
        assert client.get("/cron/daily-sync").status_code == 401

    def test_rejects_a_wrong_secret(self, client: TestClient, monkeypatch):
        monkeypatch.setenv("CRON_SECRET", "right")
        response = client.get(
            "/cron/daily-sync", headers={"Authorization": "Bearer wrong"}
        )
        assert response.status_code == 401

    def test_runs_the_sync_with_the_right_secret(self, client: TestClient, monkeypatch):
        from arete import scheduler

        monkeypatch.setenv("CRON_SECRET", "right")
        expected = {"athletes": {"1": {"sync": "ok"}}, "deferred": False}
        monkeypatch.setattr(scheduler, "run_scheduled_batch", lambda: expected)
        response = client.get(
            "/cron/daily-sync", headers={"Authorization": "Bearer right"}
        )
        assert response.status_code == 200
        assert response.json() == expected

    def test_every_cron_window_runs_the_sync_once_a_day(self):
        """Hobby refuses a deployment with a cron more frequent than daily.

        Several daily entries on the same path are its way to dispatch the
        sync more than once a day; each dispatch skips what is already done.
        The morning check-in's push has its own windows, before the sync's.
        """
        import json
        import re
        from pathlib import Path

        crons = json.loads((Path(__file__).parents[1] / "vercel.json").read_text())[
            "crons"
        ]
        schedules = [cron["schedule"] for cron in crons]
        paths = {"/api/cron/daily-sync", "/api/cron/checkin", "/api/cron/automations"}
        assert {cron["path"] for cron in crons} == paths
        assert len({(c["path"], c["schedule"]) for c in crons}) == len(crons) > 1
        assert all(re.fullmatch(r"0 \d{1,2} \* \* \*", s) for s in schedules)
        hours = {
            path: [int(c["schedule"].split()[1]) for c in crons if c["path"] == path]
            for path in paths
        }
        assert sorted(hours["/api/cron/automations"]) == list(range(24))
        assert max(hours["/api/cron/checkin"]) < min(hours["/api/cron/daily-sync"])


def test_the_backend_bundle_ships_its_dependencies():
    """Without a custom install command, Vercel's Python builder defers a
    bundle over 225 MB with a ``uv.lock`` to a ``uv sync`` on every cold start
    (3.5 s plus 13 wheel downloads). The command must install the lock as is.
    """
    import json
    from pathlib import Path

    backend = json.loads((Path(__file__).parents[1] / "vercel.json").read_text())[
        "services"
    ]["backend"]
    command = backend["installCommand"].split()
    assert command[:2] == ["uv", "sync"]
    assert {"--frozen", "--no-dev"} <= set(command)


def test_booting_the_app_leaves_the_heavy_stacks_out(tmp_path):
    """A cold serverless instance imports the app before its first request.

    The agent stack (LangChain, LangGraph, Deep Agents, LangSmith) took 1.4 s
    of the 1.5 s, and every route paid for it, /health included. It loads on
    the first coach request; Garmin's client and the workout grammars on
    their own routes. numpy and httpx (0.2 s together) load with the
    analytics and the outbound HTTP calls that use them.
    """
    import os
    import subprocess
    import sys

    heavy = [
        "pypdfium2",
        "tesserocr",
        "deepagents",
        "langchain",
        "langchain_core",
        "langgraph",
        "langsmith",
        "anthropic",
        "openai",
        "garminconnect",
        "curl_cffi",
        "lark",
        "rapidfuzz",
        "pywebpush",
        "aiohttp",
        "clerk_backend_api",
        "jwt",
        "numpy",
        "httpx",
    ]
    code = (
        "import sys, arete.api.main; "
        f"print(sorted({{m.split('.')[0] for m in sys.modules}} & {set(heavy)!r}))"
    )
    env = {**os.environ, "ARETE_DB": str(tmp_path / "boot.duckdb")}
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]"
