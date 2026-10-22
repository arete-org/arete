"""When two stored sessions are one workout, whatever their sources.

One rule for the file import, which refuses such a twin (ARE-143), and for
the Garmin sync, which takes over a file-imported twin instead of adding a
second row (ARE-181). Starts are on the athlete's clock for every source.
"""

from __future__ import annotations

import re
from collections.abc import Collection
from datetime import datetime, timedelta

from arete.garmin.models import ActivitySource, ActualSession
from arete.garmin.repository import GarminRepository

#: Two starts closer than this are the same workout (two watches, a re-export).
DUPLICATE_START_SEC = 300
#: Without a start time: same sport and day, duration within max(2 min, 10 %).
DUPLICATE_DURATION_SEC = 120
DUPLICATE_DURATION_SHARE = 0.10
#: Different sports are one workout only when they share most of their time.
DUPLICATE_OVERLAP = 0.5


def find_duplicate(
    repo: GarminRepository,
    session: ActualSession,
    elapsed_sec: int,
    sources: Collection[ActivitySource] | None = None,
) -> ActualSession | None:
    """A stored session that is this workout, of any source or of ``sources``.

    Same workout: starts within ``DUPLICATE_START_SEC`` and the same sport
    or mostly the same time (two watches may name one session differently).
    """
    assert session.start_time is not None
    nearby = repo.list_actual_sessions(
        start_date=session.date - timedelta(days=1),
        end_date=session.date + timedelta(days=1),
        limit=200,
        include_blobs=False,
    )
    tolerance = max(
        DUPLICATE_DURATION_SEC, int(session.duration_sec * DUPLICATE_DURATION_SHARE)
    )
    start = session.start_time
    end = start + timedelta(seconds=elapsed_sec)
    for other in nearby:
        if sources is not None and other.source not in sources:
            continue
        if other.start_time is not None:
            if is_legacy_fit(other):
                # The old FIT route stored the local end (wall clock) as start.
                other_end = other.start_time
                other_start = other_end - timedelta(seconds=other.duration_sec)
                gap = abs((other_end - end).total_seconds())
            else:
                other_start = other.start_time
                other_end = other_start + timedelta(seconds=other.duration_sec)
                gap = abs((other_start - start).total_seconds())
            if gap <= DUPLICATE_START_SEC and (
                other.sport == session.sport
                or overlap(start, end, other_start, other_end) >= DUPLICATE_OVERLAP
            ):
                return other
        elif (
            other.date == session.date
            and other.sport == session.sport
            and abs(other.duration_sec - session.duration_sec) <= tolerance
        ):
            return other
    return None


def overlap(
    start: datetime, end: datetime, other_start: datetime, other_end: datetime
) -> float:
    """Shared time over the shorter of the two sessions, 0 to 1."""
    shorter = min(
        (end - start).total_seconds(), (other_end - other_start).total_seconds()
    )
    shared = (min(end, other_end) - max(start, other_start)).total_seconds()
    return max(0.0, shared) / shorter if shorter > 0 else 0.0


#: What the file import appends to a file name; the old FIT route did not.
IMPORT_SUFFIX = re.compile(r"@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")


def is_legacy_fit(session: ActualSession) -> bool:
    """A FIT upload of the old route: its name lacks the import's suffix."""
    return session.source == ActivitySource.FIT_FILE and not IMPORT_SUFFIX.search(
        session.source_file or ""
    )
