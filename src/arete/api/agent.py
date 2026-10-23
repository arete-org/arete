"""Coaching agent REST surface: POST /agent/chat.

The only writer of ``panel_context``. The client supplies each invocation's history;
the conversation API archives settled snapshots independently of graph execution.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass, field
from functools import partial
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import AwareDatetime, BaseModel, Field

from arete.agent.runtime.context import (
    MAX_PANEL_CONTEXT_CHARS,
    MESSAGE_SENT_AT_KEY,
    PANEL_CONTEXT_KEY,
    PANEL_PAGES,
    AgentContext,
)
from arete.api.agent_feedback import TraceReceipt, chat_trace
from arete.api.agent_feedback import router as feedback_router
from arete.api.agent_runs import router as runs_router
from arete.api.auth import clerk_account
from arete.api.conversations import router as conversations_router
from arete.services.memory import NOTES_LEDGER, SESSIONS_LEDGER, read_file

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

router.include_router(conversations_router)

router.include_router(runs_router)


class SystemSkillOut(BaseModel):
    name: str
    display_name: str = Field(min_length=1, max_length=80)
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
    sent_at: AwareDatetime | None = None


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
    sent_at: str
    trace: TraceReceipt | None = None
    cards: list[dict] = Field(default_factory=list)
    charts: list[dict] = Field(default_factory=list)


def _to_langchain(
    role: str, content: str, sent_at: str | None = None
) -> LangchainMessage:
    from langchain_core.messages import AIMessage, HumanMessage

    if role == "assistant":
        return AIMessage(content=content)
    return HumanMessage(
        content=content,
        additional_kwargs={MESSAGE_SENT_AT_KEY: sent_at} if sent_at else {},
    )


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


@dataclass
class _PreparedRun:
    context: AgentContext
    document_state: dict = field(default_factory=dict)
    graph: Any = None
    # Raised where the route reports run failures (HTTP status or SSE error event).
    error: Exception | None = None


def _prepare_run(
    body: ChatRequest, source: dict[str, str], account_id: str
) -> _PreparedRun:
    """Everything blocking before a run, in one AnyIO worker hop.

    The athlete clock (``AgentContext``'s default) and attachments are database
    reads; the cached graph reads the rollout flag and may wait for a compile
    under a thread lock. None of them may run on the event loop.

    ``create_agent(context_schema=AgentContext)`` does NOT coerce a plain dict
    passed at invoke time (verified: ``request.runtime.context`` arrives as
    ``None``), so the router builds the dataclass itself.
    """
    context = AgentContext(
        source=source,
        thread_id=str(body.thread_id) if body.thread_id else None,
        account_id=account_id,
        document_ids=(
            tuple(str(i) for i in body.document_ids)
            if body.document_ids is not None
            else None
        ),
    )
    try:
        document_state = _document_state(context)
        # Attachments are checked before any agent is composed.
        if getattr(body, "stream_version", 1) == 2:
            from arete.services import coaching_runs

            if not context.thread_id:
                raise ValueError("Un fil est requis pour une exécution reprenable.")
            context.execution_id = coaching_runs.create(
                context.thread_id,
                {
                    "source": source,
                    "document_ids": context.document_ids,
                },
            )
            return _PreparedRun(context, document_state)
        return _PreparedRun(context, document_state, get_agent())
    except Exception as exc:
        return _PreparedRun(context, error=exc)


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
    from anyio import to_thread

    from arete.agent.context.builder import ContextBudgetExceeded
    from arete.agent.context.skills import SkillSelectionError
    from arete.agent.runtime.execution import (
        LIMIT_MESSAGE,
        RUN_LIMIT_ERRORS,
        TIMEOUT_MESSAGE,
    )
    from arete.services.documents import DocumentError

    source = _panel_context_source(body)
    prepared = await to_thread.run_sync(
        _prepare_run, body, source, clerk_account(request)
    )
    context = prepared.context
    history = [
        _to_langchain(
            m.role,
            m.content,
            m.sent_at.isoformat(timespec="seconds") if m.sent_at else None,
        )
        for m in body.messages
    ]
    try:
        if prepared.error is not None:
            raise prepared.error
        result = await invoke_agent(
            prepared.graph,
            {"messages": history, **prepared.document_state},
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
    from arete.agent.runtime.events import coach_card

    final = messages[-1]
    return ChatResponse(
        sent_at=context.current_datetime.isoformat(timespec="seconds"),
        cards=[card for message in messages if (card := coach_card(message))],
        charts=[card.model_dump() for card in context.chart_cards.values()],
        trace=chat_trace(context.run_id, context.thread_id, context.account_id),
        message=ChatMessageOut(
            role="assistant",
            content=final.text if hasattr(final, "text") else str(final.content),
        ),
    )


class StreamRequest(ChatRequest):
    """Body of POST /agent/chat/stream — same contract, SSE response."""

    supports_chart_cards: bool = Field(default=False, strict=True)
    stream_version: Literal[1, 2] = 1


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def _sse_events(
    body: StreamRequest, prepared: _PreparedRun, *, resume=None
) -> AsyncIterator[dict]:
    """Messages, tool activity and failures are separate UI events."""
    from arete.agent.runtime.execution import (
        LIMIT_MESSAGE,
        RUN_LIMIT_ERRORS,
        TIMEOUT_MESSAGE,
        stream_agent,
    )
    from arete.agent.runtime.streaming import MAX_STREAM_EVENTS, StreamProjection

    projection = StreamProjection(supports_chart_cards=body.supports_chart_cards)
    context = prepared.context
    try:
        if prepared.error is not None:
            raise prepared.error
        if prepared.graph is None:
            from anyio import to_thread

            yield {
                "type": "activity",
                "id": "composition",
                "label": "Préparation du coach",
                "state": "running",
            }
            prepared.graph = await to_thread.run_sync(_interactive_graph, context)
            yield {
                "type": "activity",
                "id": "composition",
                "label": "Coach prêt",
                "state": "done",
            }
        history = [
            _to_langchain(
                m.role,
                m.content,
                m.sent_at.isoformat(timespec="seconds") if m.sent_at else None,
            )
            for m in body.messages
        ]
        event_count = 0
        async with aclosing(
            stream_agent(
                prepared.graph,
                resume
                if resume is not None
                else {"messages": history, **prepared.document_state},
                context=context,
            )
        ) as stream:
            async for part in stream:
                event_count += 1
                if event_count > MAX_STREAM_EVENTS:
                    raise ValueError("Le stream dépasse la limite d'événements.")
                for event in projection.events(part):
                    yield event
        if context.interruptions:
            return
        done = projection.done()
        trace = chat_trace(context.run_id, context.thread_id, context.account_id)
        if trace is not None:
            done["trace"] = trace.model_dump(mode="json")
        yield done
    except TimeoutError:
        yield {
            "type": "error",
            "detail": TIMEOUT_MESSAGE,
        }
    except RUN_LIMIT_ERRORS:
        yield {"type": "error", "detail": LIMIT_MESSAGE}
    except ValueError as exc:
        yield {"type": "error", "detail": str(exc)}
    except Exception:
        logger.exception("Agent stream failed")
        yield {"type": "error", "detail": "Agent run failed"}


def _interactive_graph(context):
    from arete.coaching import get_interactive_agent
    from arete.services import coaching_runs

    graph = get_interactive_agent()
    policy = json.dumps(graph.config.get("metadata", {}), sort_keys=True, default=str)
    coaching_runs.bind_policy(context.execution_id, policy)
    return graph


async def _sse_stream(body, prepared, *, resume=None):
    from time import monotonic

    from anyio import to_thread

    from arete.agent.runtime.activity import RunRecorder
    from arete.services import coaching_runs

    context = prepared.context
    recorder = (
        RunRecorder(context.execution_id, "chat", context.thread_id)
        if context.execution_id
        else None
    )
    started = monotonic()
    finished = False
    failed = False
    sent_bytes = 0

    async def emit(event):
        nonlocal sent_bytes
        if recorder:
            from arete.api.agent_protocol import EVENT

            event = await recorder.record(event)
            EVENT.validate_python(event)
        frame = _sse(event)
        sent_bytes += len(frame.encode())
        if sent_bytes > 2_000_000:
            raise ValueError("Le flux dépasse la limite de 2 Mo.")
        return frame

    try:
        if recorder:
            if resume is not None:
                await recorder.restore()
            yield await emit({"type": "run_status", "state": "running"})
        async with aclosing(_sse_events(body, prepared, resume=resume)) as events:
            async for event in events:
                if not recorder and event["type"] in {
                    "activity",
                    "interrupt",
                    "run_status",
                    "memory_receipt",
                }:
                    continue
                if (
                    not recorder
                    and event["type"] == "context_compaction"
                    and event["phase"] == "error"
                ):
                    continue
                failed = failed or event["type"] == "error"
                if recorder and event["type"] in {"done", "error"}:
                    state = await to_thread.run_sync(
                        partial(
                            coaching_runs.finish,
                            context.execution_id,
                            monotonic() - started,
                            failed=failed,
                        )
                    )
                    finished = True
                    if state != "completed" and event["type"] == "done":
                        event = {
                            "type": "error",
                            "detail": "Exécution arrêtée ; vérifie les actions déjà effectuées.",
                        }
                yield await emit(event)
        if recorder and context.interruptions and not finished:
            state = await to_thread.run_sync(
                coaching_runs.finish,
                context.execution_id,
                monotonic() - started,
                context.interruptions,
            )
            finished = True
            run = await to_thread.run_sync(coaching_runs.get, context.execution_id)
            for item in run["interrupts"]:
                if item["decision"] is None:
                    yield await emit({"type": "interrupt", "interrupt": item})
            yield await emit({"type": "run_status", "state": state})
    finally:
        if recorder and not finished:
            # Closing a transport never replays a write. Persist the uncertain
            # outcome even when cancellation closes the streaming task.
            import anyio

            with anyio.CancelScope(shield=True):
                state = await to_thread.run_sync(
                    partial(
                        coaching_runs.finish,
                        context.execution_id,
                        monotonic() - started,
                        failed=True,
                    )
                )

                recorder.status = state
                await recorder.flush()


@router.post("/chat/stream")
async def chat_stream(body: StreamRequest, request: Request) -> StreamingResponse:
    """Stream a run; validate page context before sending HTTP 200."""
    from anyio import to_thread

    source = _panel_context_source(body)
    prepared = await to_thread.run_sync(
        _prepare_run, body, source, clerk_account(request)
    )
    return StreamingResponse(
        _sse_stream(body, prepared),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Arete-Sent-At": prepared.context.current_datetime.isoformat(
                timespec="seconds"
            ),
        },
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
    files: list[LedgerFile] = []
    for name in _LEDGER_FILES:
        content = read_file(name).content
        if len(content) > MAX_PANEL_CONTEXT_CHARS:
            content = (
                content[:MAX_PANEL_CONTEXT_CHARS] + "\n\n… (tronqué à l'affichage)"
            )
        files.append(LedgerFile(name=name, content=content))
    return LedgerResponse(files=files)
