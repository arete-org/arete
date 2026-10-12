"""Calendar HTTP surface; mutations require same-origin application requests.

Each signed-in account has its own calendar: the service is built from the
verified identity, never from anything the browser sends.
"""

import asyncio
import logging
from contextlib import contextmanager
from typing import Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import ASGIApp, Receive, Scope, Send

from arete.api.auth import clerk_account
from arete.calendar import get_calendar_service, sync_training_plan
from arete.config import config
from arete.dataio import plan_changes
from arete.services.calendar_models import CalendarError, CalendarSelection
from arete.services.calendar_plan import AFTER_PLAN_WRITE, PlanSync

logger = logging.getLogger(__name__)


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(
    prefix="/google-calendar",
    tags=["google-calendar"],
    dependencies=[Depends(no_store)],
)


def same_origin(request: Request) -> None:
    # Custom headers cannot be sent by cross-site forms, and CORS is not enabled.
    if request.headers.get("x-arete-calendar") != "1":
        raise HTTPException(403, "Requête Calendar non autorisée.")
    origin = request.headers.get("origin")
    if origin and not _trusted_origin(request, origin):
        raise HTTPException(403, "Origine Calendar non autorisée.")


def _trusted_origin(request: Request, origin: str) -> bool:
    """The configured frontend, or the very host the request was sent to.

    A deployment answers on several hosts (preview URLs, aliases) behind one
    ``FRONTEND_URL``; a page served by the same host is same-origin by
    definition. The dev server proxies from another port and matches the first.
    """
    if origin.rstrip("/") == config.frontend_url.rstrip("/"):
        return True
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    return bool(host) and urlparse(origin).netloc == host


@contextmanager
def service(request: Request):
    try:
        yield get_calendar_service(clerk_account(request))
    except CalendarError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/status")
def status(request: Request):
    if not config.google_calendar_configured:
        return {
            "configured": False,
            "connected": False,
            "selection": {"readable": [], "writable": []},
        }
    with service(request) as calendar:
        return calendar.status()


@router.post("/connect", dependencies=[Depends(same_origin)])
def connect(request: Request):
    """After Google's consent in the browser: turn access on if it was granted."""
    with service(request) as calendar:
        return calendar.connect()


@router.post("/disconnect", dependencies=[Depends(same_origin)])
def disconnect(request: Request):
    with service(request) as calendar:
        return calendar.disconnect()


@router.get("/calendars")
def calendars(request: Request):
    with service(request) as calendar:
        return calendar.calendars()


@router.put("/selection", dependencies=[Depends(same_origin)])
def selection(request: Request, body: CalendarSelection):
    with service(request) as calendar:
        return calendar.select(body)


@router.get("/events")
def events(request: Request, start: str, end: str):
    with service(request) as calendar:
        return calendar.events(start, end)


@router.get("/availability")
def availability(request: Request, start: str, end: str):
    with service(request) as calendar:
        return calendar.availability(start, end)


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]


@router.get("/actions/{action_id}")
def action(request: Request, action_id: str):
    with service(request) as calendar:
        return calendar.repo.get(action_id)


@router.post("/actions/{action_id}/decision", dependencies=[Depends(same_origin)])
def decide(request: Request, action_id: str, body: Decision):
    with service(request) as calendar:
        return calendar.decide(action_id, body.decision)


@router.post("/actions/{action_id}/verify", dependencies=[Depends(same_origin)])
def verify(request: Request, action_id: str):
    with service(request) as calendar:
        return calendar.verify(action_id)


class PlanSyncBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    calendar_id: str | None = Field(default=None, min_length=1, max_length=1024)


@router.put("/plan-sync", dependencies=[Depends(same_origin)])
def plan_sync(request: Request, body: PlanSyncBody):
    """The standing authorization to follow the plan into one calendar."""
    with service(request) as calendar:
        return PlanSync(calendar).configure(body.enabled, body.calendar_id)


@router.post("/plan-sync/remove", dependencies=[Depends(same_origin)])
def remove_plan_events(request: Request):
    with service(request) as calendar:
        return PlanSync(calendar).remove()


class PlanSyncMiddleware:
    """Follow the plan into Google Calendar after a request that changed it.

    Pure ASGI, like the mirror: the run starts once the whole response has
    been sent, so neither a plan edit nor a coach's stream waits for Google.
    The run is bounded and best effort; the daily sync catches up the rest.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        with plan_changes.watch() as changed:
            await self.app(scope, receive, send)
        if changed:
            from arete.services.coach_today import prepare

            try:
                await asyncio.to_thread(prepare)
            except Exception:
                logger.exception("Coach proposals unavailable after plan change")
        if changed and config.google_calendar_configured:
            try:
                await asyncio.to_thread(sync_training_plan, AFTER_PLAN_WRITE)
            except Exception:
                logger.exception("Training plan calendar sync failed")
