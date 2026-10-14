"""HTTP contract for Web Push subscriptions; services own the sending."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from arete.services import notifications as service

router = APIRouter(prefix="/notifications", tags=["notifications"])


class SubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class Subscription(BaseModel):
    endpoint: str
    keys: SubscriptionKeys


class Unsubscription(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
def vapid_public_key() -> dict[str, Any]:
    """The key the browser subscribes with; null when the server has none."""
    return {"key": service.public_key()}


@router.post("/subscription", status_code=204)
def subscribe(body: Subscription, request: Request) -> Response:
    service.subscribe(
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        request.headers.get("user-agent"),
    )
    return Response(status_code=204)


@router.delete("/subscription", status_code=204)
def unsubscribe(body: Unsubscription) -> Response:
    service.unsubscribe(body.endpoint)
    return Response(status_code=204)


@router.post("/test")
def send_test() -> dict[str, Any]:
    """One test notification to every subscribed browser."""
    return service.notify(
        "Arete",
        "Les notifications du coach arrivent bien ici.",
        "/settings?tab=coach",
        kind=None,  # asked for now: no per-kind choice or quiet hours
    ).to_dict()
