"""Revision-checked private archives. Browser drafts never enter search."""

from __future__ import annotations

import json
from contextlib import contextmanager
from uuid import UUID

import duckdb
from pydantic import BaseModel, ConfigDict, Field

from arete.dataio.db import db_connection, transaction

MAX_ARCHIVE_BYTES = 2_000_000
MAX_ARCHIVE_MESSAGES = 1_000
PAGE_SIZE = 30
MAX_OFFSET = 100_000
SCOPE = "athlete_id=getvariable('arete_athlete_id') AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM app.athletes a WHERE a.id=athlete_id AND a.deleted_at IS NULL)"


class ConversationError(ValueError):
    pass


class ConversationConflict(ConversationError):
    pass


@contextmanager
def _transaction():
    try:
        with transaction() as con:
            yield con
    except duckdb.TransactionException as exc:
        raise ConversationConflict(
            "Conversation modifiée simultanément. Relis le fil ; aucun rejeu automatique."
        ) from exc


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    write_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    title: str = Field(min_length=1, max_length=120)
    messages: list[dict] = Field(max_length=MAX_ARCHIVE_MESSAGES)
    reference: dict | None = None
    context_window_usage: dict | None = None
    created_at: int = Field(ge=0, le=253402300799000)
    updated_at: int = Field(ge=0, le=253402300799000)


def _id(value: str) -> str:
    return str(UUID(value))


def _row(con, thread_id: str):
    row = con.execute(
        "SELECT title, revision, payload, title_state, write_id FROM app.visible_coach_conversations WHERE id=?",
        [_id(thread_id)],
    ).fetchone()
    if row is None:
        raise ConversationError("Conversation introuvable.")
    return row


def read(thread_id: str) -> dict:
    with db_connection() as con:
        title, revision, payload, title_state, _ = _row(con, thread_id)
    return {
        "id": thread_id,
        **json.loads(payload),
        "title": title,
        "revision": revision,
        "title_state": title_state,
    }


def save(thread_id: str, snapshot: Snapshot) -> dict:
    thread_id = _id(thread_id)
    payload = snapshot.model_dump(exclude={"revision", "write_id", "title"})
    try:
        raw = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise ConversationError("Contenu de conversation invalide.") from exc
    if len(raw.encode()) > MAX_ARCHIVE_BYTES:
        raise ConversationError("Conversation trop volumineuse (2 Mo maximum).")
    text = []
    for message in snapshot.messages:
        if message.get("role") not in {"user", "assistant"} or not isinstance(
            message.get("content"), str
        ):
            raise ConversationError("Message de conversation invalide.")
        if len(message["content"]) > 64_000:
            raise ConversationError("Message trop volumineux.")
        if (
            not message.get("error")
            and not message.get("interrupted")
            and not message.get("pending")
        ):
            text.append(message["content"])
    with _transaction() as con:
        # A tombstone deliberately conflicts: stale tabs cannot resurrect a deletion.
        con.execute(
            "INSERT INTO app.coach_conversations (id,title) VALUES (?,?) ON CONFLICT DO NOTHING",
            [thread_id, snapshot.title],
        )
        try:
            title, revision, stored_payload, title_state, write_id = _row(
                con, thread_id
            )
        except ConversationError as exc:
            raise ConversationConflict(
                "Cette conversation a été supprimée. La copie locale est conservée."
            ) from exc
        if write_id == str(snapshot.write_id):
            if stored_payload != raw:
                raise ConversationConflict(
                    "Identifiant de sauvegarde réutilisé avec un contenu différent."
                )
            return {"revision": revision, "title": title}
        if revision != snapshot.revision:
            raise ConversationConflict(
                "Conversation modifiée ailleurs. La copie locale est conservée ; recharge le fil avant de poursuivre."
            )
        title = snapshot.title if title_state == "provisional" else title
        result = con.execute(
            f"UPDATE app.coach_conversations SET payload=?,search_text=?,title=?,revision=revision+1,write_id=?,created_at=to_timestamp(? / 1000.0),updated_at=to_timestamp(? / 1000.0) WHERE {SCOPE} AND id=? AND revision=? RETURNING revision",
            [
                raw,
                "\n".join(text),
                title,
                str(snapshot.write_id),
                snapshot.created_at,
                snapshot.updated_at,
                thread_id,
                revision,
            ],
        ).fetchone()
        if result is None:
            raise ConversationConflict("Conversation modifiée ailleurs.")
    return {"revision": result[0], "title": title}


def search(query: str = "", *, offset: int = 0, limit: int = PAGE_SIZE) -> dict:
    query = query.strip()
    if len(query) > 200 or not 0 <= offset <= MAX_OFFSET or not 1 <= limit <= PAGE_SIZE:
        raise ConversationError("Recherche hors limites.")
    with db_connection() as con:
        rows = con.execute(
            "SELECT id,title,updated_at,revision,search_text FROM app.visible_coach_conversations "
            "WHERE revision>0 AND (?='' OR contains(lower(title),lower(?)) OR contains(lower(search_text),lower(?))) "
            "ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
            [query, query, query, limit + 1, offset],
        ).fetchall()
    items = []
    for ident, title, updated, revision, text in rows[:limit]:
        start = max(0, text.lower().find(query.lower()) - 80) if query else 0
        items.append(
            {
                "id": ident,
                "title": title,
                "updated_at": updated.isoformat(),
                "revision": revision,
                "excerpt": text[start : start + 320],
                "excerpt_truncated": start > 0 or len(text) > start + 320,
                "url": f"/follow-up?tab=conversations&thread={ident}",
            }
        )
    return {
        "items": items,
        "next_offset": offset + limit if len(rows) > limit else None,
    }


def delete(thread_id: str) -> None:
    from arete.services.documents import delete_documents

    # Retire the archive first so a late title/save cannot expose it again.
    with _transaction() as con:
        con.execute(
            "INSERT INTO app.coach_conversations (id,title,deleted_at) VALUES (?,'',now()) ON CONFLICT DO NOTHING",
            [_id(thread_id)],
        )
        con.execute(
            f"UPDATE app.coach_conversations SET deleted_at=now(),payload='{{}}',search_text='',title='' WHERE {SCOPE} AND id=? RETURNING id",
            [_id(thread_id)],
        )
    delete_documents(thread_id)


def claim_title(thread_id: str, provisional: str) -> bool:
    with _transaction() as con:
        con.execute(
            "INSERT INTO app.coach_conversations (id,title) VALUES (?,?) ON CONFLICT DO NOTHING",
            [_id(thread_id), provisional[:64] or "Nouvelle conversation"],
        )
        return (
            con.execute(
                f"UPDATE app.coach_conversations SET title_state='attempted' WHERE {SCOPE} AND id=? AND title_state='provisional' RETURNING id",
                [thread_id],
            ).fetchone()
            is not None
        )


def set_title(thread_id: str, title: str, *, manual: bool = False) -> bool:
    title = " ".join(title.split())
    if not 1 <= len(title) <= 120:
        raise ConversationError("Le titre doit contenir entre 1 et 120 caractères.")
    with _transaction() as con:
        return (
            con.execute(
                f"UPDATE app.coach_conversations SET title=?,title_state=? WHERE {SCOPE} AND id=?"
                + ("" if manual else " AND title_state='attempted'")
                + " RETURNING id",
                [title, "manual" if manual else "generated", _id(thread_id)],
            ).fetchone()
            is not None
        )
