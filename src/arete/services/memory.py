"""Coaching ledger paths, bounded rotation and filesystem I/O.

Agent permissions belong to the Deep Agents backend adapter. This service
has no dependency on the agent framework and preserves the existing data paths.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from threading import RLock

from arete.config import config
from arete.dataio import mirror

logger = logging.getLogger(__name__)


MEMORY_DIR_NAME = "agent/memory"
SESSIONS_LEDGER = "sessions.md"
NOTES_LEDGER = "notes.md"
# Keep the journal affordable to read while archiving whole entries.
MAX_SESSIONS_LEDGER_CHARS = 40_000
KEEP_SESSIONS_LEDGER_CHARS = 20_000
LEDGER_LOCK_TIMEOUT_SECONDS = 10
_ledger_lock = RLock()


@contextmanager
def ledger_lock() -> Iterator[None]:
    """Protect local read/modify/write operations, including nested rotation.

    Every ledger write holds it, so it also has the request flush the mirror.
    """
    if not _ledger_lock.acquire(timeout=LEDGER_LOCK_TIMEOUT_SECONDS):
        raise TimeoutError("Timed out waiting for the journal write lock")
    mirror.mark_dirty()
    try:
        yield
    finally:
        _ledger_lock.release()


def memory_root() -> Path:
    """Absolute path of the memory directory, created on demand."""
    root = config.data_dir / MEMORY_DIR_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def archive_path(root: Path, when: date) -> Path:
    """Where a rotated ledger lands: one archive per month."""
    return root / f"sessions-{when:%Y-%m}.md"


@ledger_lock()
def rotate_sessions_ledger(now: date | None = None) -> Path | None:
    """Archive the old half of ``sessions.md`` when it outgrows its budget.

    Splits on an entry heading (``## ``), never mid-entry: half a session
    reads as a different session. The archive stays inside the memory root, so
    the agent can still open it deliberately; it just stops paying for it on
    every turn. Returns the archive written, or None when nothing was due.
    """
    root = memory_root()
    path = root / SESSIONS_LEDGER
    if not path.exists():
        return None
    content = path.read_text(encoding="utf-8")
    if len(content) <= MAX_SESSIONS_LEDGER_CHARS:
        return None

    cut = len(content) - KEEP_SESSIONS_LEDGER_CHARS
    boundary = content.find("\n## ", cut)
    if boundary == -1:
        # No heading after the cut: keep the whole tail rather than split an
        # entry. The next write will push it over again, and that is fine.
        boundary = content.rfind("\n## ", 0, cut)
        if boundary == -1:
            return None
    head, tail = content[:boundary], content[boundary + 1 :]

    archive = archive_path(root, now or date.today())
    with archive.open("a", encoding="utf-8") as fh:
        fh.write(head.rstrip() + "\n")
    path.write_text(tail, encoding="utf-8")
    logger.info(
        "Rotated %s: %d chars archived to %s", SESSIONS_LEDGER, len(head), archive.name
    )
    return archive


@ledger_lock()
def append_entry(file: str, title: str, body: str, when: date | None = None) -> bool:
    """Append one dated entry to a ledger; False when it is already there.

    The server writes the heading, so the date is never the model's guess and
    the format never drifts. ``sessions.md`` takes ``## YYYY-MM-DD — title``
    and a body; ``notes.md`` takes one ``- YYYY-MM-DD — title : body`` line.
    Rotation follows every write, so the ledger stays bounded whoever writes.
    """
    if file not in (SESSIONS_LEDGER, NOTES_LEDGER):
        raise ValueError(f"Unknown ledger: {file}")
    day = (when or date.today()).isoformat()
    title = " ".join(title.split())
    path = memory_root() / file
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if file == SESSIONS_LEDGER:
        heading = f"## {day} — {title}"
        if heading in existing.splitlines():
            return False
        entry = f"{heading}\n{body.strip()}\n"
    else:
        heading = f"- {day} — {title} :"
        if any(line.startswith(heading) for line in existing.splitlines()):
            return False
        entry = f"{heading} {' '.join(body.split())}\n"
    separator = (
        ""
        if not existing or existing.endswith("\n\n")
        else ("\n" if existing.endswith("\n") else "\n\n")
    )
    with path.open("a", encoding="utf-8") as fh:
        fh.write(separator + entry)
    if file == SESSIONS_LEDGER:
        rotate_sessions_ledger()
    return True
