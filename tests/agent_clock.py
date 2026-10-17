"""A fixed athlete-local instant for contexts built inside async test code.

``AgentContext``'s default reads the athlete's settings and refuses to run on
an event loop (ARE-84), so a context built there carries its clock.
"""

from datetime import UTC, datetime

CLOCK = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)
