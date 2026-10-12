"""Per-request timing: Server-Timing, statement counts and one log line."""

from __future__ import annotations

import asyncio
import logging
import re
import threading

import duckdb
import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from arete.dataio.db import db_connection
from arete.observability.http import RequestTimingMiddleware

DB_COUNT = re.compile(r'db;dur=[\d.]+;desc="(\d+) statements"')


def statements_in(response: httpx.Response) -> int:
    match = DB_COUNT.search(response.headers["server-timing"])
    assert match, response.headers["server-timing"]
    return int(match.group(1))


def request_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.getMessage().startswith("HTTP request:")
    ]


def test_json_response_counts_the_statements_it_ran(
    client: TestClient, statement_log, monkeypatch, caplog
):
    # Count independently, on the raw connections DuckDB hands out.
    real_connect = duckdb.connect
    monkeypatch.setattr(
        duckdb, "connect", lambda *a, **k: statement_log.wrap(real_connect(*a, **k))
    )
    caplog.set_level(logging.INFO, logger="arete.observability.http")

    response = client.get("/health")

    assert response.status_code == 200
    assert statement_log, "the endpoint should reach the database"
    assert statements_in(response) == len(statement_log)
    names = [
        part.split(";")[0] for part in response.headers["server-timing"].split(", ")
    ]
    assert names == ["auth", "hydrate", "db", "app", "total"]
    [line] = request_lines(caplog)
    assert "method=GET path=/health status=200" in line
    assert f"db_statements={len(statement_log)}" in line


def test_query_string_stays_out_of_the_log(client: TestClient, caplog):
    caplog.set_level(logging.INFO, logger="arete.observability.http")
    client.get("/health?athlete=secret")
    [line] = request_lines(caplog)
    assert "path=/health " in line
    assert "secret" not in line


def test_sse_streams_unchanged_and_logs_once_after_completion(caplog):
    """Each event reaches the client before the next one is produced."""
    events = [b"data: one\n\n", b"data: two\n\n", b"data: three\n\n"]
    delivered = asyncio.Event()
    order: list[tuple] = []

    async def stream():
        for event in events:
            delivered.clear()
            yield event
            # Not buffered: the middleware must pass this chunk on first.
            await asyncio.wait_for(delivered.wait(), timeout=2)

    inner = FastAPI()

    @inner.get("/stream")
    async def sse():
        return StreamingResponse(stream(), media_type="text/event-stream")

    app = RequestTimingMiddleware(inner)

    class Recorder(logging.Handler):
        def emit(self, record):
            if record.getMessage().startswith("HTTP request:"):
                order.append(("log", record.getMessage()))

    recorder = Recorder()
    logging.getLogger("arete.observability.http").addHandler(recorder)
    caplog.set_level(logging.INFO, logger="arete.observability.http")

    async def run():
        sent: list[dict] = []

        async def receive():
            await asyncio.sleep(10)  # no disconnect during the test
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)
            order.append(("send", message["type"]))
            if message["type"] == "http.response.body" and message.get("body"):
                delivered.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/stream",
            "raw_path": b"/stream",
            "root_path": "",
            "query_string": b"",
            "headers": [],
            "client": ("test", 1),
            "server": ("test", 80),
        }
        await app(scope, receive, send)
        return sent

    try:
        sent = asyncio.run(run())
    finally:
        logging.getLogger("arete.observability.http").removeHandler(recorder)

    start = sent[0]
    assert start["type"] == "http.response.start"
    assert b"server-timing" not in {name.lower() for name, _ in start["headers"]}
    chunks = [m["body"] for m in sent[1:] if m.get("body")]
    assert chunks == events
    logs = [entry for entry in order if entry[0] == "log"]
    assert len(logs) == 1
    assert order[-1][0] == "log", "the line is written after the last byte"
    assert "path=/stream status=200" in logs[0][1]


def test_concurrent_requests_keep_separate_counters():
    """Two requests overlap in AnyIO worker threads; neither sees the other's."""
    barrier = threading.Barrier(2, timeout=5)
    inner = FastAPI()

    @inner.get("/work/{n}")
    def work(n: int) -> dict:  # sync: runs in an AnyIO worker thread
        with db_connection() as con:
            if n:
                barrier.wait()  # both requests are now inside a statement loop
            for _ in range(n):
                con.execute("SELECT 1").fetchone()
        return {"n": n}

    app = RequestTimingMiddleware(inner)

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            baseline = statements_in(await c.get("/work/0"))
            few, many = await asyncio.gather(c.get("/work/2"), c.get("/work/7"))
            return baseline, statements_in(few), statements_in(many)

    baseline, few, many = asyncio.run(run())
    assert few == baseline + 2
    assert many == baseline + 7


def test_statements_from_parallel_threads_add_up_in_one_request():
    inner = FastAPI()

    def query(n: int) -> None:
        with db_connection() as con:
            for _ in range(n):
                con.execute("SELECT 1")

    @inner.get("/zero")
    def zero() -> dict:
        query(0)
        return {}

    @inner.get("/fanout")
    async def fanout() -> dict:
        await asyncio.gather(asyncio.to_thread(query, 3), asyncio.to_thread(query, 4))
        return {}

    client = TestClient(RequestTimingMiddleware(inner))
    baseline = statements_in(client.get("/zero"))
    assert statements_in(client.get("/fanout")) == 2 * baseline + 7


def test_first_request_of_the_process_is_cold(caplog):
    inner = FastAPI()

    @inner.get("/ping")
    def ping() -> dict:
        return {}

    caplog.set_level(logging.INFO, logger="arete.observability.http")
    client = TestClient(RequestTimingMiddleware(inner))
    client.get("/ping")
    client.get("/ping")
    first, second = request_lines(caplog)
    assert first.endswith("cold=True")
    assert second.endswith("cold=False")


def test_an_unhandled_error_is_logged_as_500(caplog):
    inner = FastAPI()

    @inner.get("/boom")
    def boom() -> dict:
        raise RuntimeError("boom")

    caplog.set_level(logging.INFO, logger="arete.observability.http")
    client = TestClient(RequestTimingMiddleware(inner), raise_server_exceptions=False)
    assert client.get("/boom").status_code == 500
    [line] = request_lines(caplog)
    assert "path=/boom status=500" in line
