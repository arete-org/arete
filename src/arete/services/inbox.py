"""The inbox stores delivery references; business objects remain authoritative."""

import json
from uuid import uuid4

from arete.dataio.db import db_connection, transaction
from arete.services.automations import OWNER, public, rows
from arete.services.settings import utc_now


def record(key, kind, title, body, url, reference=None):
    identifier = str(uuid4())
    with transaction() as con:
        created = con.execute(
            "INSERT INTO app.notifications (id,event_key,kind,title,body,url,reference_json,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id",
            [
                identifier,
                key,
                kind,
                title,
                body,
                url,
                json.dumps(reference) if reference else None,
                utc_now(),
            ],
        ).fetchone()
    return identifier if created else None


def delivered(identifier, result):
    with db_connection() as con:
        con.execute(
            f"UPDATE app.notifications SET push_json=? WHERE {OWNER} AND id=?",
            [json.dumps(result), identifier],
        )


def publish(key, kind, title, body, url, reference=None):
    from arete.services.notifications import notify

    identifier = record(key, kind, title, body, url, reference)
    if identifier:
        result = notify(title, body, url, kind=kind, persist=False)
        delivered(identifier, result.to_dict())
    return identifier


def listing(filter="todo", offset=0):
    if filter not in {"todo", "all", "archives"} or not 0 <= offset <= 10000:
        raise ValueError("Filtre invalide")
    where = "archived_at IS NOT NULL" if filter == "archives" else "archived_at IS NULL"
    if filter == "todo":
        where += " AND (read_at IS NULL OR EXISTS (SELECT 1 FROM app.visible_automation_runs r WHERE r.id=json_extract_string(reference_json,'$.id') AND r.state IN ('waiting','ready','queued')))"
    with db_connection() as con:
        found = rows(
            con.execute(
                f"SELECT * FROM app.visible_notifications WHERE {where} ORDER BY created_at DESC,id LIMIT 51 OFFSET ?",
                [offset],
            )
        )
        count = con.execute(
            "SELECT count(*) FROM app.visible_notifications WHERE archived_at IS NULL AND read_at IS NULL"
        ).fetchone()[0]
    return {
        "items": [public(r) for r in found[:50]],
        "unread": count,
        "next_offset": offset + 50 if len(found) > 50 else None,
    }


def mark(identifier, *, read=None, archived=None):
    assert read is not None or archived is not None
    assignments, values = [], []
    for column, value in (("read_at", read), ("archived_at", archived)):
        if value is not None:
            assignments.append(f"{column}=?")
            values.append(utc_now() if value else None)
    with db_connection() as con:
        result = con.execute(
            f"UPDATE app.notifications SET {','.join(assignments)} WHERE {OWNER} AND id=? RETURNING id",
            [*values, identifier],
        ).fetchone()
        if not result:
            raise LookupError("Notification introuvable")
    return {"id": identifier}
