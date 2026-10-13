"""Read remote Garmin credentials from their source of truth on each request.

The general file mirror caches a worker's local files. Credentials need stronger
freshness: another worker may have disconnected or reconnected this athlete.
"""

from __future__ import annotations

import json
from pathlib import Path

from arete.config import config
from arete.dataio.db import db_connection

TOKEN_PATH = "garmin_tokens/garmin_tokens.json"
#: Whose Garmin account the tokens open, recorded at login (no Garmin request
#: needed to show it).
ACCOUNT_PATH = "garmin_tokens/account.json"
TOKEN_FILE = Path(TOKEN_PATH).name
ACCOUNT_FILE = Path(ACCOUNT_PATH).name
MAX_TOKEN_BYTES = 64 * 1024


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(0o600)


def hydrate(path: Path) -> bool:
    with db_connection() as con:
        rows = dict(
            con.execute(
                "SELECT path, content FROM app.visible_files WHERE path IN (?, ?)",
                [TOKEN_PATH, ACCOUNT_PATH],
            ).fetchall()
        )
    account = path.with_name(ACCOUNT_FILE)
    if TOKEN_PATH not in rows:
        path.unlink(missing_ok=True)
        account.unlink(missing_ok=True)
        return False
    data = bytes(rows[TOKEN_PATH])
    assert len(data) <= MAX_TOKEN_BYTES
    _write(path, data)
    if ACCOUNT_PATH in rows:
        _write(account, bytes(rows[ACCOUNT_PATH]))
    else:
        account.unlink(missing_ok=True)
    return True


def _account(data: bytes | None) -> str | None:
    if not data:
        return None
    try:
        name = json.loads(data).get("account")
    except (ValueError, AttributeError):
        return None
    return name if isinstance(name, str) and name else None


def session_status() -> tuple[bool, str | None]:
    """Whether this athlete holds Garmin session tokens, and whose account.

    Local state only: no Garmin request, no ``garminconnect`` import, nothing
    restored. Tokens Garmin has since expired or revoked are reported by the
    next real sync, which fails with an authentication error.
    """
    if config.is_remote_db:
        with db_connection() as con:
            rows = dict(
                con.execute(
                    "SELECT path, content FROM app.visible_files WHERE path IN (?, ?)",
                    [TOKEN_PATH, ACCOUNT_PATH],
                ).fetchall()
            )
        if TOKEN_PATH not in rows:
            return False, None
        return True, _account(
            bytes(rows[ACCOUNT_PATH]) if ACCOUNT_PATH in rows else None
        )
    token = config.garmin_tokens_dir / TOKEN_FILE
    if not token.exists():
        return False, None
    account = token.with_name(ACCOUNT_FILE)
    return True, _account(account.read_bytes() if account.exists() else None)


def save_account(token_file: Path, name: str | None, *, remote: bool) -> None:
    """Record whose account ``token_file`` opens, next to it (and remotely)."""
    data = json.dumps({"account": name}).encode()
    _write(token_file.with_name(ACCOUNT_FILE), data)
    if remote:
        with db_connection() as con:
            con.execute(
                "INSERT OR REPLACE INTO app.files(path,content,updated_at) VALUES(?,?,now())",
                [ACCOUNT_PATH, data],
            )


def save(path: Path) -> None:
    data = path.read_bytes()
    assert len(data) <= MAX_TOKEN_BYTES
    with db_connection() as con:
        con.execute(
            "INSERT OR REPLACE INTO app.files(path,content,updated_at) VALUES(?,?,now())",
            [TOKEN_PATH, data],
        )


def delete() -> None:
    with db_connection() as con:
        con.execute(
            "DELETE FROM app.files WHERE athlete_id=getvariable('arete_athlete_id') AND path IN (?, ?)",
            [TOKEN_PATH, ACCOUNT_PATH],
        )
