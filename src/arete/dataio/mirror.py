"""Keep the data directory in the database when the database is remote.

On Vercel only ``/tmp`` is writable and it dies with the instance, yet the
Garmin tokens, the coach's memory, the dictation misses and the daily sync
marker must outlive it. Code keeps writing plain files under
``config.data_dir``; this module copies them into ``app.files`` after each
request and back onto disk the first time an instance serves one.

An instance only writes back the files it changed itself (compared with what
it last read or wrote), so two instances do not overwrite each other's work
with stale copies. Only the paths listed below are mirrored: anything else in
the data directory (FIT files, a local database file, plans) is neither read
nor hashed, and foreign rows already in ``app.files`` stay on the server.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

from starlette.types import ASGIApp, Receive, Scope, Send

from arete.config import config
from arete.dataio.db import connect
from arete.services.athlete_scope import current_athlete_id, database_athlete_id

logger = logging.getLogger(__name__)

MIRRORED_DIRS = ("garmin_tokens",)
MIRRORED_FILES = ("dictation_misses.jsonl", "last_daily_sync.json")

_MIRRORED_PREDICATE = " OR ".join(
    [f"starts_with(path, '{directory}/')" for directory in MIRRORED_DIRS]
    + [f"path IN ({', '.join(repr(name) for name in MIRRORED_FILES)})"]
)

DDL = """
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.files (
    path        VARCHAR PRIMARY KEY,
    content     BLOB NOT NULL,
    updated_at  TIMESTAMP DEFAULT now()
);
"""

#: Digest of each file as last read from or written to the database.
MAX_MIRRORED_ATHLETES = 256
_known: dict[int, dict[str, str]] = {}
_hydrated: set[int] = set()
_lock = threading.Lock()


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _local_files(root: Path) -> Iterator[tuple[str, Path]]:
    for name in MIRRORED_FILES:
        if (root / name).is_file():
            yield name, root / name
    for directory in MIRRORED_DIRS:
        for path in (root / directory).rglob("*"):
            if path.is_file():
                yield path.relative_to(root).as_posix(), path


def hydrate() -> int:
    """Write the stored files onto disk, once per process. Returns the count."""
    with _lock:
        athlete_id = current_athlete_id()
        if athlete_id in _hydrated:
            return 0
        athlete_id = current_athlete_id()
        if athlete_id not in _known and len(_known) >= MAX_MIRRORED_ATHLETES:
            raise RuntimeError("Mirror athlete capacity exceeded")
        known = _known.setdefault(athlete_id, {})
        root = config.data_dir
        with closing(connect()) as con:
            con.execute(DDL)
            rows = con.execute(
                f"SELECT path, content FROM app.visible_files WHERE {_MIRRORED_PREDICATE}"
            ).fetchall()
        for relative, content in rows:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            known[relative] = _digest(content)
        _hydrated.add(athlete_id)
        logger.info("Hydrated %d files from the database", len(rows))
        return len(rows)


def flush() -> int:
    """Store the files this process created, changed or deleted. Returns the count."""
    with _lock:
        athlete_id = current_athlete_id()
        if athlete_id not in _known and len(_known) >= MAX_MIRRORED_ATHLETES:
            raise RuntimeError("Mirror athlete capacity exceeded")
        known = _known.setdefault(athlete_id, {})
        root = config.data_dir
        changed: list[tuple[str, bytes]] = []
        present: set[str] = set()
        for relative, path in _local_files(root):
            present.add(relative)
            data = path.read_bytes()
            if known.get(relative) != _digest(data):
                changed.append((relative, data))
        deleted = [relative for relative in known if relative not in present]
        if not changed and not deleted:
            return 0
        with closing(connect()) as con:
            con.execute(DDL)
            for relative, data in changed:
                con.execute(
                    "INSERT OR REPLACE INTO app.files (path, content, updated_at) "
                    "VALUES (?, ?, now())",
                    [relative, data],
                )
            for relative in deleted:
                con.execute(
                    "DELETE FROM app.files WHERE athlete_id = getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes scope_owner WHERE scope_owner.id=athlete_id AND scope_owner.deleted_at IS NULL) AND (path = ?) ",
                    [relative],
                )
        for relative, data in changed:
            known[relative] = _digest(data)
        for relative in deleted:
            del known[relative]
        return len(changed) + len(deleted)


def reset() -> None:
    """Forget what this process knows (tests)."""
    with _lock:
        _known.clear()
        _hydrated.clear()


class MirrorMiddleware:
    """Hydrate before the first request, flush after each one.

    Pure ASGI rather than ``BaseHTTPMiddleware`` so the flush runs once the
    whole body has been sent: the coach writes its memory while it streams.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Slack has a three-second receipt deadline. Its attached background task
        # owns hydrate/flush so database latency cannot delay that receipt.
        if scope.get("path") == "/slack/events":
            await self.app(scope, receive, send)
            return
        if (
            scope["type"] != "http"
            or not config.is_remote_db
            or database_athlete_id() is None
        ):
            await self.app(scope, receive, send)
            return
        try:
            await asyncio.to_thread(hydrate)
        except Exception:
            logger.exception("Could not restore the data directory")
            raise
        try:
            await self.app(scope, receive, send)
        finally:
            try:
                await asyncio.to_thread(flush)
            except Exception:
                logger.exception("Could not store the data directory")
