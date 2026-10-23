"""Bounded UI projection of native events and confirmed domain receipts.

This recorder cannot influence execution or resume a graph. Middleware-owned
AgentState keys stay in LangGraph; per-invocation dependencies stay in context.
Only the allowlisted public projection is stored for read-only observers.
"""

from functools import partial
from time import monotonic

from anyio import to_thread

from arete.services import coaching_runs

FLUSH_SECONDS = 2.0
MAX_EVENTS = 12_000
MAX_TEXT = 64_000


class RunRecorder:
    def __init__(self, identifier: str, source_kind: str, source_id: str):
        self.identifier = identifier
        self.source_kind = source_kind
        self.source_id = source_id
        self.events: list[dict] = []
        self.sequence = 0
        self.last_flush = 0.0
        self.status = "running"

    async def restore(self):
        try:
            snapshot = await to_thread.run_sync(coaching_runs.activity, self.identifier)
        except LookupError:
            return
        self.events = snapshot["projection"]["events"]
        self.sequence = snapshot["projection"]["seq"]

    def _accumulate(self, event: dict):
        self.sequence += 1
        if self.sequence > MAX_EVENTS:
            raise ValueError("Le stream dépasse la limite d’événements.")
        event = {
            **event,
            "stream_version": 2,
            "run_id": self.identifier,
            "seq": self.sequence,
        }
        kind = event["type"]
        if kind in {"token", "message"}:
            existing = next(
                (
                    e
                    for e in self.events
                    if e["type"] == "message" and e["id"] == event["id"]
                ),
                None,
            )
            if existing is None:
                self.events.append({**event, "type": "message"})
            else:
                existing.update(
                    {
                        **event,
                        "type": "message",
                        "text": existing["text"] + event["text"]
                        if kind == "token"
                        else event["text"],
                    }
                )
        elif kind in {
            "values",
            "sync_status",
            "run_status",
            "activity",
            "tool_preparing",
        }:
            key = event.get("id")
            self.events = [
                e for e in self.events if not (e["type"] == kind and e.get("id") == key)
            ]
            self.events.append(event)
        else:
            self.events.append(event)
        if (
            sum(len(e.get("text", "")) for e in self.events if e["type"] == "message")
            > MAX_TEXT
        ):
            raise ValueError("La réponse dépasse la limite de taille du stream.")
        if kind == "done":
            self.status = "completed"
        elif kind == "error":
            self.status = "failed"
        elif kind == "run_status":
            self.status = event["state"]
        flush = monotonic() - self.last_flush >= FLUSH_SECONDS or kind in {
            "done",
            "error",
            "interrupt",
            "run_status",
        }
        return event, flush

    async def record(self, event: dict):
        event, flush = self._accumulate(event)
        if flush:
            await self.flush()
        return event

    def record_sync(self, event: dict):
        """Synchronous owners publish without crossing an event loop for SQL."""
        event, flush = self._accumulate(event)
        if flush:
            coaching_runs.publish(
                self.identifier,
                self.source_kind,
                self.source_id,
                {"events": self.events, "seq": self.sequence},
                self.status,
            )
            self.last_flush = monotonic()
        return event

    async def flush(self):
        await to_thread.run_sync(
            partial(
                coaching_runs.publish,
                self.identifier,
                self.source_kind,
                self.source_id,
                {"events": self.events, "seq": self.sequence},
                self.status,
            )
        )
        self.last_flush = monotonic()
