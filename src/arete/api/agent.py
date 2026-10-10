"""Coaching agent REST surface: POST /agent/chat.

The only writer of ``panel_context``. Stateless v1: the client sends the full message
history each call; persistence lands later if needed.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import TYPE_CHECKING, Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from arete.agent.runtime.context import (
    MAX_PANEL_CONTEXT_CHARS,
    PANEL_CONTEXT_KEY,
    PANEL_PAGES,
    AgentContext,
)
from arete.api.agent_feedback import TraceReceipt, chat_trace
from arete.api.agent_feedback import router as feedback_router
from arete.api.auth import clerk_account
from arete.services.memory import NOTES_LEDGER, SESSIONS_LEDGER, memory_root

if TYPE_CHECKING:
    from langchain_core.messages import BaseMessage as LangchainMessage

# The agent stack (LangChain, LangGraph, Deep Agents, LangSmith: about 1.4 s of
# imports) loads on the first coach request, not when the app boots: on a
# cold serverless instance every route used to pay for it, /health included.


def get_agent():
    from arete.coaching import get_agent as build

    return build()


async def invoke_agent(graph: Any, state: dict, *, context: AgentContext) -> dict:
    from arete.agent.runtime.execution import invoke_agent as run

    return await run(graph, state, context=context)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])
router.include_router(feedback_router)


class SystemSkillOut(BaseModel):
    name: str
    description: str
    path: str


@router.get("/skills", response_model=list[SystemSkillOut])
def list_system_skills() -> list[dict]:
    from arete.coaching import system_skill_catalog

    return system_skill_catalog()


#: Hard bound on history size per request (bounds the envelope; a normal turn
#: is 2-20 messages). Over it → 413, never silent truncation.
MAX_MESSAGES = 60
MAX_MESSAGE_CHARS = 16_000


class ChatMessageIn(BaseModel):
    """One client-side message. Role is client-asserted but role-flipped to
    'user' server-side for anything that is not 'assistant'."""

    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)


class ChatRequest(BaseModel):
    """Body of POST /agent/chat."""

    messages: list[ChatMessageIn] = Field(..., min_length=1, max_length=MAX_MESSAGES)
    document_ids: list[UUID] | None = Field(default=None, max_length=20)
    thread_id: UUID | None = Field(default=None, description="Stable chat thread ID")
    page: str | None = Field(
        default=None, description="Frontend page currently open (panel context)"
    )
    panel_context: dict | None = Field(
        default=None,
        description=(
            "Free-form page context stamped at the request tail every turn. "
            "Merged over the derived page name when provided."
        ),
    )


class ChatMessageOut(BaseModel):
    role: str
    content: str


class ChatResponse(BaseModel):
    message: ChatMessageOut
    trace: TraceReceipt | None = None


def _to_langchain(role: str, content: str) -> LangchainMessage:
    from langchain_core.messages import AIMessage, HumanMessage

    if role == "assistant":
        return AIMessage(content=content)
    return HumanMessage(content=content)


def _panel_context_source(request: ChatRequest) -> dict[str, str]:
    """Serialize the open-page payload. Single writer of PANEL_CONTEXT_KEY."""
    payload: dict = {}
    if request.page is not None:
        if request.page not in PANEL_PAGES:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown page '{request.page}'. Valid: {sorted(PANEL_PAGES)}",
            )
        payload["page"] = request.page
    if request.panel_context is not None:
        payload.update(request.panel_context)
    if not payload:
        return {}
    raw = json.dumps(payload, ensure_ascii=False, default=str)
    if len(raw) > MAX_PANEL_CONTEXT_CHARS:
        # Reject, never truncate: half a payload parses as a
        # different page.
        raise HTTPException(
            status_code=413,
            detail=f"panel_context over budget ({len(raw)} > {MAX_PANEL_CONTEXT_CHARS} chars)",
        )
    return {PANEL_CONTEXT_KEY: raw}


def _to_agent_context(
    source: dict[str, str],
    thread_id: UUID | None = None,
    *,
    account_id: str = "",
) -> AgentContext:
    """Coerce the raw source dict into the declared context schema.

    ``create_agent(context_schema=AgentContext)`` does NOT coerce a plain dict
    passed at invoke time (verified: ``request.runtime.context`` arrives as
    ``None``), so the router builds the dataclass itself.
    """
    return AgentContext(
        source=source,
        thread_id=str(thread_id) if thread_id else None,
        account_id=account_id,
    )


def _document_state(context: AgentContext) -> dict:
    """Rehydrate per invocation, never on a shared compiled graph."""
    from arete.agent.backends.attachments import attachment_files
    from arete.services import documents

    if not context.thread_id:
        if context.document_ids:
            raise documents.DocumentError(
                "Un fil est requis pour lire les pièces jointes."
            )
        return {}
    files = documents.filesystem(context.thread_id, context.document_ids)
    context.attachment_paths = tuple(files)
    return {"files": attachment_files(files)}


@router.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, request: Request) -> ChatResponse:
    """Run the coaching agent over the client-provided history."""
    from arete.agent.context.builder import ContextBudgetExceeded
    from arete.agent.context.skills import SkillSelectionError
    from arete.agent.runtime.execution import (
        LIMIT_MESSAGE,
        RUN_LIMIT_ERRORS,
        TIMEOUT_MESSAGE,
    )
    from arete.services.documents import DocumentError

    history = [_to_langchain(m.role, m.content) for m in body.messages]
    source = _panel_context_source(body)
    from anyio import to_thread

    context = _to_agent_context(
        source,
        body.thread_id,
        account_id=clerk_account(request),
    )
    context.document_ids = (
        tuple(str(i) for i in body.document_ids)
        if body.document_ids is not None
        else None
    )
    try:
        document_state = await to_thread.run_sync(_document_state, context)
        graph = get_agent()
        result = await invoke_agent(
            graph,
            {"messages": history, **document_state},
            context=context,
        )
    except DocumentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except SkillSelectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except ContextBudgetExceeded as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from None
    except TimeoutError:
        raise HTTPException(status_code=504, detail=TIMEOUT_MESSAGE) from None
    except RUN_LIMIT_ERRORS:
        raise HTTPException(status_code=502, detail=LIMIT_MESSAGE) from None
    except ValueError as exc:
        # Model misconfiguration (missing key, unknown provider).
        raise HTTPException(status_code=500, detail=str(exc)) from None
    except Exception as exc:
        # The details stay in the logs: provider errors may quote requests.
        logger.exception("Agent run failed")
        raise HTTPException(status_code=502, detail="Agent run failed") from exc

    messages = result.get("messages", [])
    if not messages:
        raise HTTPException(status_code=502, detail="Agent returned no messages")
    final = messages[-1]
    return ChatResponse(
        trace=chat_trace(context.run_id, context.thread_id, context.account_id),
        message=ChatMessageOut(
            role="assistant",
            content=final.text() if hasattr(final, "text") else str(final.content),
        ),
    )


class StreamRequest(ChatRequest):
    """Body of POST /agent/chat/stream — same contract, SSE response."""

    # Cached clients reject unknown SSE events; only spend a model call when
    # the caller can consume the optional draft.


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def _sse_stream(body: StreamRequest, account_id: str) -> AsyncIterator[str]:
    """Messages, tool activity and failures are separate UI events."""
    from arete.agent.runtime.execution import (
        LIMIT_MESSAGE,
        RUN_LIMIT_ERRORS,
        TIMEOUT_MESSAGE,
        stream_agent,
    )
    from arete.api.agent_streaming import MAX_STREAM_EVENTS, StreamProjection

    projection = StreamProjection()
    from anyio import to_thread

    try:
        history = [_to_langchain(m.role, m.content) for m in body.messages]
        context = _to_agent_context(
            _panel_context_source(body),
            body.thread_id,
            account_id=account_id,
        )
        context.document_ids = (
            tuple(str(i) for i in body.document_ids)
            if body.document_ids is not None
            else None
        )
        document_state = await to_thread.run_sync(_document_state, context)
        graph = get_agent()
        event_count = 0
        async with aclosing(
            stream_agent(
                graph, {"messages": history, **document_state}, context=context
            )
        ) as stream:
            async for part in stream:
                event_count += 1
                if event_count > MAX_STREAM_EVENTS:
                    raise ValueError("Le stream dépasse la limite d'événements.")
                for event in projection.events(part):
                    yield _sse(event)
        done = projection.done()
        trace = chat_trace(context.run_id, context.thread_id, context.account_id)
        if trace is not None:
            done["trace"] = trace.model_dump(mode="json")
        yield _sse(done)
    except TimeoutError:
        yield _sse(
            {
                "type": "error",
                "detail": TIMEOUT_MESSAGE,
            }
        )
    except RUN_LIMIT_ERRORS:
        yield _sse({"type": "error", "detail": LIMIT_MESSAGE})
    except ValueError as exc:
        yield _sse({"type": "error", "detail": str(exc)})
    except Exception:
        logger.exception("Agent stream failed")
        yield _sse({"type": "error", "detail": "Agent run failed"})


@router.post("/chat/stream")
async def chat_stream(body: StreamRequest, request: Request) -> StreamingResponse:
    """Stream a run; validate page context before sending HTTP 200."""
    _panel_context_source(body)
    return StreamingResponse(
        _sse_stream(body, clerk_account(request)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Memory ledger viewer (Settings page)
# ---------------------------------------------------------------------------


class LedgerFile(BaseModel):
    """One memory-ledger file: name + markdown content."""

    name: str
    content: str


class LedgerResponse(BaseModel):
    files: list[LedgerFile]


_LEDGER_FILES = (NOTES_LEDGER, SESSIONS_LEDGER)


@router.get("/memory", response_model=LedgerResponse)
def get_memory() -> LedgerResponse:
    """Read the agent's memory ledger (bounded files, 64k chars each)."""
    root = memory_root().resolve()
    files: list[LedgerFile] = []
    for name in _LEDGER_FILES:
        path = (root / name).resolve()
        # Defense in depth: the frontend only ever asks for the two known
        # names, but assert the path stays inside the memory root anyway.
        assert path.parent == root, f"ledger path escaped memory root: {name}"
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        if len(content) > MAX_PANEL_CONTEXT_CHARS:
            content = (
                content[:MAX_PANEL_CONTEXT_CHARS] + "\n\n… (tronqué à l'affichage)"
            )
        files.append(LedgerFile(name=name, content=content))
    return LedgerResponse(files=files)
