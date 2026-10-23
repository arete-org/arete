"""Request-local measurements shared by the HTTP middleware and the DB helpers.

The HTTP middleware puts a ``RequestTiming`` in a ContextVar for the duration
of a request. AnyIO and ``asyncio.to_thread`` copy the context into worker
threads, so a statement run from a sync endpoint, a threadpool dependency or
a streamed generator lands in its own request's counter, and two concurrent
requests never share one. Outside a request (scheduler, scripts) the variable
is unset and nothing is recorded.

Only counts and durations are kept: never the statement text or parameters.
"""

from __future__ import annotations

import threading
import time
from contextvars import ContextVar
from typing import Any, cast

import duckdb


class RequestTiming:
    """Monotonic marks and the database cost of one HTTP request."""

    def __init__(self) -> None:
        self.marks: dict[str, float] = {"start": time.perf_counter()}
        self.db_statements = 0
        self.db_seconds = 0.0
        # One request may run statements from several worker threads at once.
        self._lock = threading.Lock()

    def mark(self, name: str) -> None:
        self.marks[name] = time.perf_counter()

    def span_ms(self, first: str, last: str, now: float) -> float:
        """Milliseconds from ``first`` to ``last`` (or ``now`` if not reached
        yet); 0 when the request never reached ``first``."""
        if first not in self.marks:
            return 0.0
        return (self.marks.get(last, now) - self.marks[first]) * 1000

    def record_statement(self, seconds: float) -> None:
        with self._lock:
            self.db_statements += 1
            self.db_seconds += seconds


current_request: ContextVar[RequestTiming | None] = ContextVar(
    "arete_request_timing", default=None
)


class _CountedConnection:
    """Delegates to a DuckDB connection, timing ``execute``/``executemany``.

    DuckDB's own ``execute`` returns the connection; returning the wrapper
    instead keeps chained statements counted and ``fetch*`` delegated.
    """

    __slots__ = ("_con",)

    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self._con = con

    def _timed(self, method: str, args: Any, kwargs: Any) -> _CountedConnection:
        timing = current_request.get()
        if timing is None:
            getattr(self._con, method)(*args, **kwargs)
            return self
        start = time.perf_counter()
        try:
            getattr(self._con, method)(*args, **kwargs)
        finally:
            timing.record_statement(time.perf_counter() - start)
        return self

    def execute(self, *args: Any, **kwargs: Any) -> _CountedConnection:
        return self._timed("execute", args, kwargs)

    def executemany(self, *args: Any, **kwargs: Any) -> _CountedConnection:
        return self._timed("executemany", args, kwargs)

    def __enter__(self) -> _CountedConnection:
        self._con.__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._con.__exit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._con, name)


def counted(con: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
    """The connection, with each statement counted in the current request."""
    return cast(duckdb.DuckDBPyConnection, _CountedConnection(con))
