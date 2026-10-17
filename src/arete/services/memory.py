"""Transactional coaching ledger shared by tools, context, retrieval and exports.

Disk is a one-time migration source, never a cache: stale processes cannot
resurrect forgotten content. No failed or ambiguous write is replayed.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from itertools import islice
from pathlib import Path
from threading import RLock

import duckdb

from arete.config import config
from arete.dataio.db import db_connection, transaction
from arete.services.settings import athlete_today

MEMORY_DIR_NAME = "agent/memory"
SESSIONS_LEDGER = "sessions.md"
NOTES_LEDGER = "notes.md"
PROFILE_LEDGER = "profile.md"
MAX_PROFILE_CHARS = 8_000
MAX_SESSIONS_LEDGER_CHARS = 40_000
KEEP_SESSIONS_LEDGER_CHARS = 20_000
MAX_MEMORY_FILES = 1_000
MAX_MEMORY_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
LEDGER_LOCK_TIMEOUT_SECONDS = 10
_ledger_lock = RLock()
_OWNER = "athlete_id=getvariable('arete_athlete_id')"
_LIVE = (
    _OWNER
    + " AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes a WHERE a.id=athlete_id AND a.deleted_at IS NULL)"
)


class MemoryConflict(ValueError):
    """The caller must read the current file before deciding on another write."""


@dataclass(frozen=True)
class MemoryFile:
    name: str
    content: str
    revision: int
    forgotten: bool = False


@contextmanager
def ledger_lock() -> Iterator[None]:
    # Avoid needless local conflicts. Cross-process correctness is enforced by SQL.
    if not _ledger_lock.acquire(timeout=LEDGER_LOCK_TIMEOUT_SECONDS):
        raise TimeoutError("Timed out waiting for the journal write lock")
    try:
        yield
    finally:
        _ledger_lock.release()


def memory_root() -> Path:
    """Legacy migration location; not authoritative after import."""
    return config.data_dir / MEMORY_DIR_NAME


def _name(name: str, *, writable: bool = False) -> str:
    name = name.removeprefix("/")
    if not re.fullmatch(r"(?:profile|notes|sessions(?:-\d{4}-\d{2})?)\.md", name):
        raise PermissionError("permission denied: unknown journal path")
    if writable and name not in (PROFILE_LEDGER, NOTES_LEDGER, SESSIONS_LEDGER):
        raise PermissionError("permission denied: archives are read-only")
    return name


def ensure_imported() -> None:
    """Claim and import once, including an empty source; deletion never reimports."""
    with ledger_lock(), transaction() as con:
        if con.execute(
            f"SELECT 1 FROM app.visible_coach_memory_imports WHERE {_OWNER}"
        ).fetchone():
            return
        files: list[tuple[str, str]] = []
        if config.is_remote_db:
            rows = con.execute(
                "SELECT path,content FROM app.visible_files WHERE starts_with(path, 'agent/memory/') LIMIT ?",
                [MAX_MEMORY_FILES + 1],
            ).fetchall()
            if len(rows) > MAX_MEMORY_FILES:
                raise ValueError("Too many legacy journal files")
            for path, raw in rows:
                name = str(path).removeprefix("agent/memory/")
                if re.fullmatch(r"(?:notes|sessions(?:-\d{4}-\d{2})?)\.md", name):
                    files.append((name, bytes(raw).decode("utf-8")))
        else:
            paths = list(islice(memory_root().glob("*.md"), MAX_MEMORY_FILES + 1))
            if len(paths) > MAX_MEMORY_FILES:
                raise ValueError("Too many legacy journal files")
            for path in paths:
                if not re.fullmatch(
                    r"(?:notes|sessions(?:-\d{4}-\d{2})?)\.md", path.name
                ):
                    continue
                if path.is_symlink() or path.stat().st_size > MAX_FILE_BYTES:
                    raise ValueError("Invalid legacy journal file")
                files.append((path.name, path.read_text(encoding="utf-8")))
        _validate_files(files)
        con.execute(
            "INSERT INTO app.coach_memory_imports (athlete_id) VALUES (getvariable('arete_athlete_id'))"
        )
        if files:
            con.executemany(
                "INSERT INTO app.coach_memory_files (path,content) VALUES (?,?)", files
            )


def _validate_files(files: list[tuple[str, str]]) -> None:
    if (
        len(files) > MAX_MEMORY_FILES
        or sum(len(t.encode()) for _, t in files) > MAX_MEMORY_BYTES
    ):
        raise ValueError("Journal exceeds its file/byte budget")
    if any(len(t.encode()) > MAX_FILE_BYTES for _, t in files):
        raise ValueError("Journal file exceeds its byte budget")


def list_files() -> list[MemoryFile]:
    ensure_imported()
    with db_connection() as con:
        rows = con.execute(
            "SELECT path,content,revision FROM app.visible_coach_memory_files WHERE NOT forgotten ORDER BY path LIMIT ?",
            [MAX_MEMORY_FILES + 1],
        ).fetchall()
    _validate_files([(r[0], r[1]) for r in rows])
    return [MemoryFile(*r) for r in rows]


def _read(con, name: str) -> MemoryFile:
    row = con.execute(
        "SELECT path,content,revision,forgotten FROM app.visible_coach_memory_files WHERE path=?",
        [name],
    ).fetchone()
    return MemoryFile(*row) if row else MemoryFile(name, "", 0, True)


def read_file(name: str) -> MemoryFile:
    name = _name(name)
    ensure_imported()
    with db_connection() as con:
        return _read(con, name)


def _write(con, old: MemoryFile, content: str, *, forgotten: bool = False) -> None:
    # The whole profile is mandatory context; reject growth rather than clipping.
    if old.name == PROFILE_LEDGER and len(content) > MAX_PROFILE_CHARS:
        raise ValueError("Profil trop long : limite de 8 000 caractères.")
    if len(content.encode()) > MAX_FILE_BYTES:
        raise ValueError("Journal file exceeds its byte budget")
    if old.revision == 0:
        con.execute(
            "INSERT INTO app.coach_memory_files (path,content,forgotten) VALUES (?,?,?)",
            [old.name, content, forgotten],
        )
    else:
        row = con.execute(
            f"UPDATE app.coach_memory_files SET content=?, forgotten=?, revision=revision+1, updated_at=now() WHERE {_LIVE} AND path=? AND revision=? RETURNING revision",
            [content, forgotten, old.name, old.revision],
        ).fetchone()
        if row is None:
            raise MemoryConflict("Le journal a changé. Relis-le avant de le modifier.")


def replace_file(
    name: str, content: str, revision: int, *, forgotten: bool = False
) -> None:
    name = _name(name, writable=True)
    ensure_imported()
    try:
        with ledger_lock(), transaction() as con:
            old = _read(con, name)
            if old.revision != revision:
                raise MemoryConflict(
                    "Le journal a changé. Relis-le avant de le modifier."
                )
            _write(con, old, content, forgotten=forgotten)
    except (duckdb.TransactionException, duckdb.ConstraintException) as exc:
        raise MemoryConflict("Écriture concurrente du journal : relis-le.") from exc


def edit_file(
    name: str, old_string: str, new_string: str, replace_all: bool = False
) -> int:
    old = read_file(_name(name, writable=True))
    if old.forgotten or not old_string:
        raise ValueError("Fichier absent ou passage vide.")
    count = old.content.count(old_string)
    if count == 0 or (count > 1 and not replace_all):
        raise ValueError("Passage absent ou ambigu : relis le journal.")
    replace_file(
        old.name,
        old.content.replace(old_string, new_string, -1 if replace_all else 1),
        old.revision,
    )
    return count if replace_all else 1


def delete_file(name: str) -> None:
    old = read_file(_name(name, writable=True))
    replace_file(old.name, "", old.revision, forgotten=True)


def _rotate(con, now: date) -> str | None:
    old = _read(con, SESSIONS_LEDGER)
    if len(old.content) <= MAX_SESSIONS_LEDGER_CHARS:
        return None
    boundary = old.content.find("\n## ", len(old.content) - KEEP_SESSIONS_LEDGER_CHARS)
    if boundary < 0:
        boundary = old.content.rfind(
            "\n## ", 0, len(old.content) - KEEP_SESSIONS_LEDGER_CHARS
        )
    if boundary < 0:
        raise ValueError("Journal entry too large to archive without splitting")
    archive = _read(con, f"sessions-{now:%Y-%m}.md")
    _write(con, archive, archive.content + old.content[:boundary].rstrip() + "\n")
    _write(con, old, old.content[boundary + 1 :])
    return archive.name


def rotate_sessions_ledger(now: date | None = None) -> str | None:
    ensure_imported()
    with ledger_lock(), transaction() as con:
        return _rotate(con, now or athlete_today())


def append_entry(
    file: str,
    title: str,
    body: str,
    when: date | None = None,
    *,
    expected_revision: int | None = None,
) -> bool:
    name = _name(file, writable=True)
    day = when or athlete_today()
    title = " ".join(title.split())
    if not title or not body.strip() or len(title) > 120 or len(body) > 8_000:
        raise ValueError("Invalid or oversized journal entry")
    heading = (
        f"## {day.isoformat()} — {title}"
        if name != NOTES_LEDGER
        else f"- {day.isoformat()} — {title} :"
    )
    entry = (
        f"{heading}\n{body.strip()}\n"
        if name != NOTES_LEDGER
        else f"{heading} {' '.join(body.split())}\n"
    )
    ensure_imported()
    try:
        with ledger_lock(), transaction() as con:
            old = _read(con, name)
            if expected_revision is not None and old.revision != expected_revision:
                raise MemoryConflict(
                    "Le journal a changé. Relis-le avant de le modifier."
                )
            if any(
                line == heading if name != NOTES_LEDGER else line.startswith(heading)
                for line in old.content.splitlines()
            ):
                return False
            _write(
                con, old, old.content.rstrip() + ("\n\n" if old.content else "") + entry
            )
            if name == SESSIONS_LEDGER:
                _rotate(con, day)
    except (duckdb.TransactionException, duckdb.ConstraintException) as exc:
        raise MemoryConflict("Écriture concurrente du journal : relis-le.") from exc
    return True
