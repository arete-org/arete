"""Per-step duration and database cost of one athlete's scheduled run.

The cron's one request (or Docker's tick, which has none) runs several
athletes, each through a dozen steps: the request's totals cannot say which
step is slow. ``measure_steps`` reads the current request's counter (a fresh
one outside a request) for one athlete's run, and ``step_done`` charges what
ran since the previous mark to a named step. Outside ``measure_steps`` a mark
does nothing. Only durations and counts: never data.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from arete.observability.requests import RequestTiming, current_request


class StepTimings:
    """Milliseconds, statements and database milliseconds per named step."""

    def __init__(self, timing: RequestTiming) -> None:
        self._timing = timing
        self._started = self._last = self._now()
        self.steps: dict[str, list[float]] = {}

    def _now(self) -> tuple[float, int, float]:
        timing = self._timing
        return time.perf_counter(), timing.db_statements, timing.db_seconds

    def done(self, name: str) -> None:
        """Charge what ran since the previous mark to ``name`` (summed if repeated)."""
        now = self._now()
        spent = [(now[i] - self._last[i]) for i in range(3)]
        total = self.steps.setdefault(name, [0.0, 0, 0.0])
        for i in range(3):
            total[i] += spent[i]
        self._last = now

    def statements(self, name: str) -> int:
        return int(self.steps.get(name, [0, 0, 0])[1])

    def line(self) -> str:
        """``total=…`` then each step as ``name=<ms>ms/<statements>st/<db ms>dbms``."""
        now = self._now()
        parts = [("total", [now[i] - self._started[i] for i in range(3)])]
        parts += list(self.steps.items())
        return " ".join(
            f"{name}={seconds * 1000:.0f}ms/{statements:.0f}st/{db * 1000:.0f}dbms"
            for name, (seconds, statements, db) in parts
        )


_current: ContextVar[StepTimings | None] = ContextVar("arete_steps", default=None)


@contextmanager
def measure_steps() -> Iterator[StepTimings]:
    """Measure one run's steps, on the request's counter when there is one."""
    timing = current_request.get()
    token = None
    if timing is None:
        timing = RequestTiming()
        token = current_request.set(timing)
    steps = StepTimings(timing)
    steps_token = _current.set(steps)
    try:
        yield steps
    finally:
        _current.reset(steps_token)
        if token is not None:
            current_request.reset(token)


def step_done(name: str) -> None:
    """End step ``name`` of the run being measured; nothing outside one."""
    steps = _current.get()
    if steps is not None:
        steps.done(name)
