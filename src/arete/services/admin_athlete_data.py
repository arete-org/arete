"""Audited administrator reads; only this boundary can select another athlete."""

import json
import logging
from dataclasses import asdict
from datetime import date, timedelta
from typing import Literal

from arete.dataio.db import db_connection
from arete.services import slack_identity, users
from arete.services.athlete_scope import athlete_scope

logger = logging.getLogger(__name__)
Section = Literal[
    "sessions",
    "session",
    "planning",
    "health",
    "facts",
    "memory",
    "documents",
    "document",
    "strength",
    "strength_session",
    "settings",
]
MAX_READ_CHARS = 24_000
MAX_OFFSET = 20 * 1024 * 1024


def accounts(team: str, slack_user: str, account_id: str) -> list[dict]:
    slack_identity.require_admin(team, slack_user, account_id)
    rows = users.list_accounts()
    if len(rows) > 200:
        raise ValueError("Plus de 200 comptes : résultat trop volumineux.")
    logger.info("Admin data read: actor=%s section=accounts", account_id)
    return [a.to_dict() for a in rows if a.deactivated_at is None]


def read(
    team: str,
    slack_user: str,
    account_id: str,
    athlete_id: int,
    section: Section,
    *,
    days: int = 30,
    offset: int = 0,
    resource: str = "",
    thread_id: str = "",
    start_date: str = "",
) -> object:
    slack_identity.require_admin(team, slack_user, account_id)
    if not users.athlete_is_active(athlete_id):
        raise PermissionError("Athlète introuvable ou désactivé.")
    if not 1 <= days <= 120 or not 0 <= offset <= MAX_OFFSET:
        raise ValueError("Lecture limitée à 120 jours et un offset de 0 à 20 Mio.")
    logger.info(
        "Admin data read: actor=%s target=%s section=%s",
        account_id,
        athlete_id,
        section,
    )
    # The authenticated actor stays separate from the read target. ContextVar
    # restoration isolates concurrent worker reads and all following operations.
    with athlete_scope(athlete_id):
        return _read(section, days, offset, resource, thread_id, start_date)


def _read(
    section: Section,
    days: int,
    offset: int,
    resource: str,
    thread_id: str,
    start_date: str,
) -> object:
    from arete.services import analytics, athlete_facts, documents, memory, planning

    start = (
        date.fromisoformat(start_date)
        if start_date
        else date.today() - timedelta(days=days - 1)
    )
    if section == "settings":
        from arete.dataio.settings import get_user_settings

        return get_user_settings()
    if section in ("strength", "strength_session"):
        from arete.strength.repository import StrengthRepository

        repo = StrengthRepository()
        if section == "strength_session":
            session = repo.get_session(int(resource))
            return asdict(session) if session else None
        sessions = repo.list_sessions(
            start_date=start, end_date=start + timedelta(days=days - 1), limit=51
        )
        if len(sessions) > 50:
            raise ValueError("Plus de 50 séances de musculation : réduis la période.")
        return [asdict(session) for session in sessions]
    if section == "sessions":
        return analytics.list_sessions(limit=50, offset=offset, for_model=True)
    if section == "session":
        return analytics.get_session(int(resource))
    if section == "planning":
        today = date.fromisoformat(start_date) if start_date else date.today()
        return planning.list_planned(
            today.isoformat(), (today + timedelta(days=days)).isoformat()
        )
    if section == "health":
        from arete.dataio.queries import daily_metrics_range

        with db_connection() as con:
            return daily_metrics_range(con, start, start + timedelta(days=days - 1))
    if section == "facts":
        facts = athlete_facts.list_facts()
        return {
            "facts": [asdict(f) for f in facts[offset : offset + 50]],
            "total": len(facts),
            "offset": offset,
        }
    if section == "memory":
        if not resource:
            return [
                {"name": f.name, "chars": len(f.content)} for f in memory.list_files()
            ]
        item = memory.read_file(resource)
        return {
            "name": item.name,
            "forgotten": item.forgotten,
            "offset": offset,
            "total_chars": len(item.content),
            "content": item.content[offset : offset + MAX_READ_CHARS],
        }
    if section == "documents":
        with db_connection() as con:
            rows = con.execute(
                "SELECT id,thread_id,name,status FROM app.visible_coach_documents ORDER BY created_at,id LIMIT 51 OFFSET ?",
                [offset],
            ).fetchall()
        return {
            "documents": [
                dict(zip(("id", "thread_id", "name", "status"), r, strict=True))
                for r in rows[:50]
            ],
            "has_more": len(rows) > 50,
            "offset": offset,
        }
    if section == "document":
        extracted = documents.extraction_for(thread_id, resource)
        content = "\n".join(
            json.dumps(b.model_dump(), ensure_ascii=False) for b in extracted.blocks
        )
        return {
            "content": content[offset : offset + MAX_READ_CHARS],
            "total_chars": len(content),
            "offset": offset,
            "warnings": extracted.warnings,
        }

    raise ValueError("Lecture administrateur inconnue.")
