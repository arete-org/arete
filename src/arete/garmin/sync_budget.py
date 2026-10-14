"""An invocation's hard HTTP envelope, shared by activity and health reads."""

from dataclasses import dataclass, field
from time import monotonic, sleep

MAX_REQUESTS = 50
REQUEST_TIMEOUT = 15.0
REQUEST_INTERVAL = 3.0


class SyncStopped(RuntimeError):
    """The import cannot continue safely within its envelope."""


class SyncRateLimited(SyncStopped):
    """A provider cooldown, never a reason to sleep or replay a request."""


@dataclass
class SyncBudget:
    deadline: float
    max_requests: int = MAX_REQUESTS
    calls: int = 0
    last_request: float = 0.0
    stopped: str | None = None
    errors: list[str] = field(default_factory=list)
    rate_limited: bool = False

    def check(self) -> None:
        if self.stopped:
            raise SyncStopped(self.stopped)
        if monotonic() >= self.deadline:
            self.stopped = "Délai de synchronisation atteint ; import incomplet."
            raise SyncStopped(self.stopped)

    def before_request(self) -> float:
        self.check()
        if self.calls >= self.max_requests:
            self.stopped = "Limite de requêtes Garmin atteinte ; import incomplet."
            raise SyncStopped(self.stopped)
        delay = max(0.0, self.last_request + REQUEST_INTERVAL - monotonic())
        if monotonic() + delay >= self.deadline:
            self.stopped = "Délai de synchronisation atteint ; import incomplet."
            raise SyncStopped(self.stopped)
        sleep(delay)
        self.check()
        self.calls += 1
        self.last_request = monotonic()
        return min(REQUEST_TIMEOUT, self.deadline - self.last_request)
