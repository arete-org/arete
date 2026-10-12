"""Signed Slack Events API ingress; acknowledge before importing the coach."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time

import httpx
from anyio import to_thread
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel

from arete.config import config
from arete.services.slack import SLACK_HTTP_TIMEOUT_SECONDS, SlackClient, SlackMessage

router = APIRouter(prefix="/slack", tags=["slack"])
logger = logging.getLogger(__name__)
MAX_BODY_BYTES = 256_000
MAX_BODY_CHUNKS = 256
MAX_BODY_SECONDS = 2
MAX_SIGNATURE_AGE_SECONDS = 300
SLACK_TIMESTAMP = re.compile(r"[0-9]{1,16}\.[0-9]{6}")


async def process_message(message: SlackMessage, token: str) -> None:
    # Work stays attached to the ASGI response lifecycle, never create_task().
    # Slack's receipt must not wait on MotherDuck or the model stack.
    from arete.coaching import dispatch_slack_message
    from arete.dataio import mirror
    from arete.services.athlete_scope import athlete_scope
    from arete.services.slack import resolve

    try:
        async with httpx.AsyncClient(
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(SLACK_HTTP_TIMEOUT_SECONDS),
            follow_redirects=False,
        ) as http:
            client = SlackClient(http)
            athlete_id = await resolve(message, client=client)
            if athlete_id is None:
                return
            # The author's verified address chose this athlete, never the
            # message body. AnyIO workers inherit the scope.
            with athlete_scope(athlete_id):
                if config.is_remote_db:
                    await to_thread.run_sync(mirror.hydrate)
                try:
                    await dispatch_slack_message(message, client=client)
                finally:
                    if config.is_remote_db:
                        await to_thread.run_sync(mirror.flush)
    except Exception:
        # The receipt is already sent, so HTTP cannot report this failure.
        logger.exception("Slack background processing failed: %s", message.key)


def _bot_user(payload: dict) -> str:
    """This app's bot user, from the signed envelope; empty when absent."""
    for grant in payload.get("authorizations") or ():
        if isinstance(grant, dict) and grant.get("is_bot"):
            value = grant.get("user_id")
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9]{1,64}", value):
                return value
    return ""


def _identifier(payload: dict, name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9]{1,64}", value):
        raise HTTPException(400, f"Invalid Slack {name}")
    return value


@router.post("/events")
async def events(request: Request, background: BackgroundTasks) -> dict:
    secret = config.slack_signing_secret
    if not secret:
        raise HTTPException(503, "Slack n’est pas configuré")
    raw = bytearray()
    chunks = 0
    try:
        async with asyncio.timeout(MAX_BODY_SECONDS):
            async for chunk in request.stream():
                chunks += 1
                raw.extend(chunk)
                if len(raw) > MAX_BODY_BYTES or chunks > MAX_BODY_CHUNKS:
                    raise HTTPException(413, "Slack payload too large")
    except TimeoutError:
        raise HTTPException(408, "Slack payload timed out") from None
    timestamp = request.headers.get("x-slack-request-timestamp", "")
    if not re.fullmatch(r"[0-9]{1,12}", timestamp):
        raise HTTPException(401, "Invalid Slack timestamp")
    if abs(time.time() - int(timestamp)) > MAX_SIGNATURE_AGE_SECONDS:
        raise HTTPException(401, "Expired Slack signature")
    expected = (
        "v0="
        + hmac.new(
            secret.encode(), b"v0:" + timestamp.encode() + b":" + raw, hashlib.sha256
        ).hexdigest()
    )
    signature = request.headers.get("x-slack-signature", "")
    if not hmac.compare_digest(expected.encode(), signature.encode()):
        raise HTTPException(401, "Invalid Slack signature")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "Invalid Slack JSON") from None
    if not isinstance(payload, dict):
        raise HTTPException(400, "Invalid Slack envelope")
    if payload.get("type") == "url_verification":
        challenge = payload.get("challenge")
        if not isinstance(challenge, str) or not 1 <= len(challenge) <= 256:
            raise HTTPException(400, "Invalid Slack challenge")
        return {"challenge": challenge}
    if payload.get("type") != "event_callback":
        return {"ok": True}
    if not all((config.slack_bot_token, config.slack_team_id)):
        raise HTTPException(503, "Slack n’est pas configuré")
    event = payload.get("event")
    if not isinstance(event, dict):
        raise HTTPException(400, "Invalid Slack event")
    # Plain text from a person, in a direct message or a channel Arete was
    # invited to (Slack only sends those). Who the author is gets resolved
    # after the receipt, from their profile.
    in_channel = event.get("channel_type") in ("channel", "group")
    if (
        payload.get("team_id") != config.slack_team_id
        or event.get("type") != "message"
        or not (event.get("channel_type") == "im" or in_channel)
        or event.get("bot_id")
        or event.get("subtype")
        or event.get("files")
        or payload.get("is_ext_shared_channel")
    ):
        return {"ok": True}
    bot_user = _bot_user(payload)
    ts = event.get("ts", "")
    thread_ts = event.get("thread_ts", ts)
    if (
        not isinstance(ts, str)
        or not isinstance(thread_ts, str)
        or not SLACK_TIMESTAMP.fullmatch(ts)
        or not SLACK_TIMESTAMP.fullmatch(thread_ts)
    ):
        raise HTTPException(400, "Invalid Slack timestamp")
    text = event.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "Invalid Slack text")
    message = SlackMessage(
        team=config.slack_team_id,
        user=_identifier(event, "user"),
        event_id=_identifier(payload, "event_id"),
        app_id=_identifier(payload, "api_app_id"),
        channel=_identifier(event, "channel"),
        ts=ts,
        thread_ts=thread_ts,
        text=text,
        in_channel=in_channel,
        mentioned=bool(bot_user) and f"<@{bot_user}>" in text,
        bot_user=bot_user,
    )
    background.add_task(process_message, message, config.slack_bot_token)
    return {"ok": True}


class SlackPreferences(BaseModel):
    public_replies: bool


def _preferences(public_replies: bool) -> dict:
    return {
        "available": bool(
            config.slack_signing_secret
            and config.slack_bot_token
            and config.slack_team_id
        ),
        "public_replies": public_replies,
    }


@router.get("/preferences")
def get_preferences() -> dict:
    """The signed-in athlete's Slack consent; nobody else's."""
    from arete.services import slack_athletes

    return _preferences(slack_athletes.public_replies())


@router.put("/preferences")
def put_preferences(body: SlackPreferences) -> dict:
    from arete.services import slack_athletes

    return _preferences(slack_athletes.set_public_replies(body.public_replies))
