"""When two stored sessions are one workout, whatever their sources.

The file import refuses such a twin (``find_duplicate``, ARE-143); the
Garmin sync takes over a file-imported one instead of adding a second row
(``find_takeover``, ARE-181), with the same tolerances and stricter guards.
Starts are on the athlete's clock for every source.
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
    repo: GarminRepository, session: ActualSession, elapsed_sec: int
) -> ActualSession | None:
    """A stored session that is this workout, whatever its source.

    Same workout: starts within ``DUPLICATE_START_SEC`` and the same sport
    or mostly the same time (two watches may name one session differently).
    """
    assert session.start_time is not None
    tolerance = max(
        DUPLICATE_DURATION_SEC, int(session.duration_sec * DUPLICATE_DURATION_SHARE)
    )
    start = session.start_time
    end = start + timedelta(seconds=elapsed_sec)
    for other in _nearby(repo, session):
        if other.start_time is not None:
            other_start, other_end, gap = _span(other, start, end)
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


def find_takeover(
    repo: GarminRepository,
    session: ActualSession,
    elapsed_sec: int,
    sources: Collection[ActivitySource],
) -> ActualSession | None:
    """The stored row of ``sources`` that this incoming workout replaces.

    Stricter than the import's refusal, since a takeover rewrites the row:
    the two must share time, another sport must share half of the longer
    one (a short run inside a long strength session stays apart), and of
    several candidates the closest start wins.
    """
    assert session.start_time is not None
    start = session.start_time
    end = start + timedelta(seconds=elapsed_sec)
    best: tuple[float, ActualSession] | None = None
    for other in _nearby(repo, session):
        if other.source not in sources or other.start_time is None:
            continue
        other_start, other_end, gap = _span(other, start, end)
        if (
            gap > DUPLICATE_START_SEC
            or overlap(start, end, other_start, other_end) <= 0
            or (
                other.sport != session.sport
                and overlap(start, end, other_start, other_end, of_longer=True)
                < DUPLICATE_OVERLAP
            )
        ):
            continue
        if best is None or gap < best[0]:
            best = (gap, other)
    return best[1] if best else None


def _nearby(repo: GarminRepository, session: ActualSession) -> list[ActualSession]:
    return repo.list_actual_sessions(
        start_date=session.date - timedelta(days=1),
        end_date=session.date + timedelta(days=1),
        limit=200,
        include_blobs=False,
    )


def _span(
    other: ActualSession, start: datetime, end: datetime
) -> tuple[datetime, datetime, float]:
    """(start, end) of a timed stored session, and its gap to this one in seconds."""
    assert other.start_time is not None
    if is_legacy_fit(other):
        # The old FIT route stored the local end (wall clock) as start.
        other_end = other.start_time
        other_start = other_end - timedelta(seconds=other.duration_sec)
        return other_start, other_end, abs((other_end - end).total_seconds())
    other_start = other.start_time
    other_end = other_start + timedelta(seconds=other.duration_sec)
    return other_start, other_end, abs((other_start - start).total_seconds())


def overlap(
    start: datetime,
    end: datetime,
    other_start: datetime,
    other_end: datetime,
    *,
    of_longer: bool = False,
) -> float:
    """Shared time over the shorter (or longer) of the two sessions, 0 to 1."""
    pick = max if of_longer else min
    basis = pick(
        (end - start).total_seconds(), (other_end - other_start).total_seconds()
    )
    shared = (min(end, other_end) - max(start, other_start)).total_seconds()
    return max(0.0, shared) / basis if basis > 0 else 0.0


#: What the file import appends to a file name; the old FIT route did not.
IMPORT_SUFFIX = re.compile(r"@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")


def is_legacy_fit(session: ActualSession) -> bool:
    """A FIT upload of the old route: its name lacks the import's suffix."""
    return session.source == ActivitySource.FIT_FILE and not IMPORT_SUFFIX.search(
        session.source_file or ""
    )
