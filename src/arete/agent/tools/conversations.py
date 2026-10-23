"""Read-only conversation retrieval; authorization comes from the capability."""

import json
from typing import Annotated
from uuid import UUID

from pydantic import Field

from arete.agent.tools.validation import typed_tool
from arete.services import conversations


@typed_tool
def search_conversations(
    query: Annotated[str, Field(min_length=1, max_length=200)],
    offset: Annotated[int, Field(ge=0, le=100_000)] = 0,
) -> str:
    """Search this athlete's saved conversations. Return dated excerpts and source links."""
    return json.dumps(
        conversations.search(query, offset=offset, limit=5), ensure_ascii=False
    )


@typed_tool
def read_conversation(
    thread_id: UUID,
    offset: Annotated[int, Field(ge=0, le=1000)] = 0,
    limit: Annotated[int, Field(ge=1, le=5)] = 3,
) -> str:
    """Read complete messages from a saved conversation. Paginate explicitly."""
    try:
        archive = conversations.read(str(thread_id))
    except conversations.ConversationError as exc:
        return json.dumps({"error": str(exc)})
    messages = archive.get("messages", [])
    selected = [
        {
            "role": m["role"],
            "content": m["content"],
            "sent_at": m.get("sentAt"),
            "incomplete": bool(
                m.get("error") or m.get("interrupted") or m.get("pending")
            ),
        }
        for m in messages[offset : offset + limit]
    ]
    result = json.dumps(
        {
            "thread_id": str(thread_id),
            "title": archive["title"],
            "messages": selected,
            "next_offset": offset + limit if offset + limit < len(messages) else None,
        },
        ensure_ascii=False,
    )
    if len(result) > 20_000:
        return json.dumps(
            {
                "error": "Lecture trop volumineuse. Réduis limit ; un message dépassant 20 000 caractères doit être consulté dans l’interface."
            }
        )
    return result


CONVERSATION_TOOLS = [search_conversations, read_conversation]
