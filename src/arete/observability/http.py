"""Per-request timing: one log line per request and a ``Server-Timing`` header.

Pure ASGI, like the other middlewares: the body is passed through message by
message, so a stream (the coach's SSE) is never buffered, and the log line is
written once the last byte has been sent and the mirror has flushed.

Phases come from ``PhaseMark`` layers registered between the middlewares
(``api/main.py``): auth runs until the first mark, the mirror hydrates until
the second, the handler runs inside it, and the mirror flushes after it.
"""

from __future__ import annotations

import logging
import time

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from arete.observability.requests import RequestTiming, current_request

logger = logging.getLogger(__name__)

#: Mark names, in request order.
AUTHORIZED = "authorized"
HANDLER = "handler"
HANDLER_END = "handler_end"
MIRROR_END = "mirror_end"


def server_timing(timing: RequestTiming, now: float) -> str:
    """The header for a response whose body is complete when it starts."""
    db_ms = timing.db_seconds * 1000
    return ", ".join(
        [
            f"auth;dur={timing.span_ms('start', AUTHORIZED, now):.1f}",
            f"hydrate;dur={timing.span_ms(AUTHORIZED, HANDLER, now):.1f}",
            f'db;dur={db_ms:.1f};desc="{timing.db_statements} statements"',
            f"app;dur={timing.span_ms(HANDLER, HANDLER_END, now):.1f}",
            f"total;dur={timing.span_ms('start', 'end', now):.1f}",
        ]
    )


class PhaseMark:
    """Record when a request enters and leaves the layer below this one."""

    def __init__(self, app: ASGIApp, enter: str, leave: str) -> None:
        self.app = app
        self.enter = enter
        self.leave = leave

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        timing = current_request.get()
        if timing is None:
            await self.app(scope, receive, send)
            return
        timing.mark(self.enter)
        try:
            await self.app(scope, receive, send)
        finally:
            timing.mark(self.leave)


class RequestTimingMiddleware:
    """Outermost: time the whole request, count its statements, log once."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.cold = True

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        cold, self.cold = self.cold, False
        timing = RequestTiming()
        token = current_request.set(timing)
        status: int | None = None

        async def send_timed(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = MutableHeaders(scope=message)
                # A known length means the body is already computed; a stream's
                # header would only time its start, so it is logged instead.
                if "content-length" in headers:
                    headers.append(
                        "Server-Timing", server_timing(timing, time.perf_counter())
                    )
            await send(message)

        try:
            await self.app(scope, receive, send_timed)
        finally:
            current_request.reset(token)
            timing.mark("end")
            _log(scope, timing, status, cold)


def _log(scope: Scope, timing: RequestTiming, status: int | None, cold: bool) -> None:
    """Path only: a query string may carry athlete data."""
    end = timing.marks["end"]
    logger.info(
        "HTTP request: method=%s path=%s status=%s total_ms=%d db_ms=%d "
        "db_statements=%d auth_ms=%d hydrate_ms=%d handler_ms=%d flush_ms=%d "
        "cold=%s",
        scope["method"],
        scope["path"],
        status if status is not None else 500,
        timing.span_ms("start", "end", end),
        timing.db_seconds * 1000,
        timing.db_statements,
        timing.span_ms("start", AUTHORIZED, end),
        timing.span_ms(AUTHORIZED, HANDLER, end),
        timing.span_ms(HANDLER, HANDLER_END, end),
        timing.span_ms(HANDLER_END, MIRROR_END, end),
        cold,
    )
