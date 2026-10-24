"""Observation and explicit decisions for owned coaching executions."""

import asyncio
import json
from functools import partial
from time import monotonic
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from jsonschema import ValidationError
from pydantic import BaseModel, Field

from arete.api.auth import clerk_account
from arete.services import coaching_runs as runs
from arete.services.automations import Conflict

router = APIRouter()
MAX_OBSERVATIONS = 150
OBSERVE_SECONDS = 2
MAX_OBSERVERS_PER_WORKER = 16
_observation_slots = asyncio.Semaphore(MAX_OBSERVERS_PER_WORKER)


async def _bounded_observation(events):
    if _observation_slots.locked():
        yield 'data: {"type":"error","detail":"Trop de suivis ouverts ; ferme une autre vue."}\n\n'
        return
    async with _observation_slots:
        async for frame in events:
            yield frame


def _read(action):
    try:
        return action()
    except LookupError as exc:
        raise HTTPException(404, detail=str(exc)) from None
    except Conflict as exc:
        raise HTTPException(409, detail=str(exc)) from None
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, detail=str(exc)) from None


@router.get("/runs/{identifier}")
def read_run(identifier: UUID):
    runs.cleanup()
    result = _read(partial(runs.get, str(identifier)))
    try:
        result["activity"] = runs.activity(str(identifier))
    except LookupError:
        result["activity"] = None
    return result


class Decision(BaseModel):
    revision: int = Field(ge=1)
    decision: dict


@router.post("/runs/{identifier}/interrupts/{interrupt_id}")
def decide(identifier: UUID, interrupt_id: str, body: Decision):
    _read(
        partial(
            runs.decide, str(identifier), interrupt_id, body.revision, body.decision
        )
    )
    return runs.get(str(identifier))


@router.post("/runs/{identifier}/cancel")
def cancel(identifier: UUID):
    _read(partial(runs.cancel, str(identifier)))
    return runs.get(str(identifier))


@router.get("/activity")
def latest_activity(source_kind: str, source_id: str):
    return runs.latest(source_kind, source_id)


@router.get("/runs/{identifier}/events")
async def observe(identifier: UUID, request: Request):
    from anyio import to_thread

    first = await to_thread.run_sync(
        lambda: _read(partial(runs.activity, str(identifier)))
    )

    async def events():
        snapshot = first
        revision = -1
        sent_bytes = 0
        for _ in range(MAX_OBSERVATIONS):
            if await request.is_disconnected():
                return
            if snapshot["revision"] != revision:
                revision = snapshot["revision"]
                frame = (
                    "data: "
                    + json.dumps({"type": "snapshot", **snapshot}, ensure_ascii=False)
                    + "\n\n"
                )
                sent_bytes += len(frame.encode())
                if sent_bytes > runs.MAX_PROJECTION_BYTES:
                    yield 'data: {"type":"error","detail":"Limite du suivi atteinte ; actualise la vue."}\n\n'
                    return
                yield frame
            if snapshot["state"] in runs.TERMINAL or snapshot["state"] in {
                "waiting",
                "ready",
            }:
                return
            await asyncio.sleep(OBSERVE_SECONDS)
            try:
                snapshot = await to_thread.run_sync(runs.activity, str(identifier))
            except LookupError:
                yield 'data: {"type":"error","detail":"Activité expirée."}\n\n'
                return
        yield 'data: {"type":"observation_closed"}\n\n'

    return StreamingResponse(
        _bounded_observation(events()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/runs/{identifier}/resume")
async def resume(identifier: UUID, request: Request):
    from anyio import to_thread
    from langgraph.types import Command

    from arete.agent.runtime.context import AgentContext, read_athlete_clock
    from arete.agent.runtime.execution import run_config
    from arete.api.agent import (
        ChatMessageIn,
        StreamRequest,
        _document_state,
        _interactive_graph,
        _PreparedRun,
        _sse_stream,
    )

    saved = await to_thread.run_sync(
        lambda: _read(partial(runs.get, str(identifier), internal=True))
    )
    source = json.loads(saved["context_json"])
    context = AgentContext(
        source=source.get("source", {}),
        thread_id=saved["thread_id"],
        execution_id=str(identifier),
        account_id=clerk_account(request),
        document_ids=tuple(source["document_ids"])
        if source.get("document_ids")
        else None,
        current_datetime=await read_athlete_clock(),
    )
    # Recheck access to attachments and the route before claiming execution.
    await to_thread.run_sync(_document_state, context)
    graph = await to_thread.run_sync(
        lambda: _read(partial(_interactive_graph, context))
    )
    snapshot = await graph.aget_state(run_config(context=context, graph=graph))
    pending = {item.id for item in snapshot.interrupts}
    answers = {
        i["id"]: i["decision"]
        for i in saved["interrupts"]
        if i["id"] in pending and i["decision"] is not None
    }
    if not answers:
        raise HTTPException(409, detail="Aucune nouvelle réponse à reprendre.")
    claimed = await to_thread.run_sync(
        lambda: _read(partial(runs.claim, str(identifier)))
    )
    context.deadline = monotonic() + runs.MAX_ACTIVE_SECONDS - claimed["active_seconds"]
    body = StreamRequest(
        messages=[ChatMessageIn(role="user", content="Reprise")],
        thread_id=saved["thread_id"],
        stream_version=2,
        supports_chart_cards=True,
    )
    return StreamingResponse(
        _sse_stream(
            body, _PreparedRun(context, graph=graph), resume=Command(resume=answers)
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/activity/events")
async def observe_generation(request: Request, source_kind: str, source_id: str):
    """Wait for the already-owned producer, including its preparation interval."""
    from anyio import to_thread

    if len(source_kind) > 40 or len(source_id) > 100:
        raise HTTPException(422, detail="Référence d’activité trop longue.")

    async def events():
        previous = None
        first_run = None
        saw_running = False
        sent_bytes = 0
        for _ in range(MAX_OBSERVATIONS):
            if await request.is_disconnected():
                return
            snapshot = await to_thread.run_sync(runs.latest, source_kind, source_id)
            if snapshot and (snapshot["id"], snapshot["revision"]) != previous:
                first_run = first_run or snapshot["id"]
                saw_running = saw_running or snapshot["state"] == "running"
                previous = (snapshot["id"], snapshot["revision"])
                frame = (
                    "data: "
                    + json.dumps({"type": "snapshot", **snapshot}, ensure_ascii=False)
                    + "\n\n"
                )
                sent_bytes += len(frame.encode())
                if sent_bytes > runs.MAX_PROJECTION_BYTES:
                    yield 'data: {"type":"error","detail":"Limite du suivi atteinte ; actualise la vue."}\n\n'
                    return
                yield frame
                if snapshot["state"] in runs.TERMINAL and (
                    source_id != "current" or saw_running or snapshot["id"] != first_run
                ):
                    return
            await asyncio.sleep(OBSERVE_SECONDS)
        yield 'data: {"type":"observation_closed"}\n\n'

    return StreamingResponse(
        _bounded_observation(events()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
