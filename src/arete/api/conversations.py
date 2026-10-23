"""Archive transport; importing this module never loads the model stack."""

from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from arete.services import conversations

router = APIRouter(prefix="/conversations", tags=["agent"])


@router.get("")
def list_conversations(
    q: str = Query(default="", max_length=200),
    offset: int = Query(default=0, ge=0, le=conversations.MAX_OFFSET),
):
    return conversations.search(q, offset=offset)


@router.get("/{thread_id}")
def read_conversation(thread_id: UUID):
    try:
        return conversations.read(str(thread_id))
    except conversations.ConversationError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.put("/{thread_id}")
def save_conversation(thread_id: UUID, body: conversations.Snapshot):
    try:
        return conversations.save(str(thread_id), body)
    except conversations.ConversationConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except conversations.ConversationError as exc:
        raise HTTPException(422, str(exc)) from exc


class Title(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)


@router.patch("/{thread_id}")
def rename_conversation(thread_id: UUID, body: Title):
    try:
        saved = conversations.set_title(str(thread_id), body.title, manual=True)
    except conversations.ConversationError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not saved:
        raise HTTPException(404, "Conversation introuvable.")
    return {"title": body.title.strip()}


@router.delete("/{thread_id}")
def delete_conversation(thread_id: UUID):
    try:
        conversations.delete(str(thread_id))
    except conversations.ConversationConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"deleted": True}
