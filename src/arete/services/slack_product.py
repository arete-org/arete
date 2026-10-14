"""Administrator Slack operations with durable receipts before external writes."""

from __future__ import annotations

import asyncio
import hashlib
import html
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from anyio import to_thread

from arete.dataio.db import db_connection, transaction
from arete.services import slack_identity
from arete.services.slack import SlackClient, SlackError, SlackMessage

MAX_PAGES = 10
PAGE_SIZE = 200
MAX_ACTIONS = 5
MAX_TEXT = 2000
MAX_OPERATIONS = 100_000
MAX_SCHEDULE_DAYS = 120
CANCEL_GUARD_SECONDS = 60
USER_ID = re.compile(r"[UW][A-Z0-9]+")
DM_REQUEST = re.compile(r"\b(?:dm|priv[ée]\w*|message direct)\b", re.IGNORECASE)


def schedule_time(value: str, zone: str, *, now: datetime | None = None) -> int:
    if "T" not in value or not re.search(r"T\d{2}:\d{2}", value):
        raise ValueError("Précise une date et une heure pour le rappel.")
    parsed = datetime.fromisoformat(value)
    tz = ZoneInfo(zone)
    if parsed.tzinfo is None:
        early, late = (
            parsed.replace(tzinfo=tz, fold=0),
            parsed.replace(tzinfo=tz, fold=1),
        )
        if early.utcoffset() != late.utcoffset():
            raise ValueError("Heure ambiguë ou inexistante : précise le décalage UTC.")
        parsed = early
    local = parsed.astimezone(tz)
    if local.replace(tzinfo=None) != parsed.replace(tzinfo=None):
        raise ValueError(
            "L'heure et son décalage ne correspondent pas au fuseau annoncé."
        )
    now = now or datetime.now(UTC)
    delay = (parsed - now).total_seconds()
    if not 0 < delay <= MAX_SCHEDULE_DAYS * 86400:
        raise ValueError("Le rappel doit être dans le futur, à 120 jours maximum.")
    return int(parsed.timestamp())


def valid_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        return "Europe/Paris"
    return value


def _operation(operation_id: str) -> dict | None:
    with db_connection() as con:
        row = con.execute(
            "SELECT operation_id,action,target_id,channel_id,thread_ts,post_at,slack_id,status "
            "FROM app.slack_operations WHERE operation_id=?",
            [operation_id],
        ).fetchone()
    return (
        dict(
            zip(
                (
                    "id",
                    "action",
                    "target",
                    "channel",
                    "thread",
                    "post_at",
                    "slack_id",
                    "status",
                ),
                row,
                strict=True,
            )
        )
        if row
        else None
    )


@dataclass
class SlackProduct:
    """One invocation's trusted dependencies, never model conversation state."""

    client: SlackClient
    message: SlackMessage
    account_id: str
    timezone: str
    private: bool = False
    actions: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def authorize(self) -> None:
        await to_thread.run_sync(
            slack_identity.require_admin,
            self.message.team,
            self.message.user,
            self.account_id,
        )

    async def _pages(self, method: str, key: str, args: dict) -> list:
        rows: list = []
        cursor = ""
        for _ in range(MAX_PAGES):
            result = await self.client.call(
                method, {**args, "limit": PAGE_SIZE, "cursor": cursor}
            )
            page = result.get(key)
            if not isinstance(page, list) or len(page) > PAGE_SIZE:
                raise SlackError("Page Slack invalide.")
            rows.extend(page)
            cursor = result.get("response_metadata", {}).get("next_cursor", "")
            if not cursor:
                return rows
        raise SlackError(
            "Annuaire trop volumineux : aucune liste partielle n'est utilisée."
        )

    async def member(self, user_id: str) -> dict:
        if not USER_ID.fullmatch(user_id):
            raise ValueError("Identifiant Slack invalide.")
        result = await self.client.call("users.info", {"user": user_id})
        user = result.get("user")
        if (
            not isinstance(user, dict)
            or user.get("id") != user_id
            or user.get("team_id") != self.message.team
            or user.get("deleted")
            or user.get("is_bot")
            or user.get("is_app_user")
        ):
            raise ValueError("Destinataire humain actif introuvable dans ce workspace.")
        return user

    async def search(self, query: str) -> dict:
        await self.authorize()
        query = query.strip()
        if not 1 <= len(query) <= 200:
            raise ValueError("Recherche attendue : 1 à 200 caractères.")
        explicit = query.removeprefix("<@").removesuffix(">")
        members = (
            [await self.member(explicit)]
            if USER_ID.fullmatch(explicit)
            else await self._pages("users.list", "members", {})
        )
        matches = []
        for user in members:
            profile = user.get("profile") or {}
            name = (
                profile.get("display_name")
                or user.get("real_name")
                or user.get("name")
                or ""
            )
            names = " ".join(
                str(x or "") for x in (name, user.get("real_name"), user.get("name"))
            )
            if (
                user.get("team_id") == self.message.team
                and not user.get("deleted")
                and not user.get("is_bot")
                and not user.get("is_app_user")
                and (user.get("id") == explicit or query.casefold() in names.casefold())
            ):
                matches.append({"slack_user_id": user["id"], "name": name})
        return {"members": matches, "ambiguous": len(matches) > 1}

    async def send(
        self, target: str, text: str, *, at: str | None = None, dm: bool = False
    ) -> dict:
        async with self.lock:
            await self.authorize()
            if self.private:
                raise PermissionError(
                    "Ce fil contient des données privées ; ouvre un nouveau fil pour contacter un tiers."
                )
            if not text.strip() or len(text) > MAX_TEXT:
                raise ValueError("Le message doit contenir de 1 à 2 000 caractères.")
            await self.member(target)
            if dm and not DM_REQUEST.search(self.message.text):
                raise ValueError(
                    "Demande explicitement un DM avant de changer de destination."
                )
            channel = self.message.channel
            thread: str | None = self.message.thread_ts
            if not dm:
                if self.message.in_channel:
                    members = await self._pages(
                        "conversations.members", "members", {"channel": channel}
                    )
                    if target not in members:
                        raise ValueError(
                            "Cette personne n'est pas dans ce canal. Souhaites-tu un DM ?"
                        )
                elif target != self.message.user:
                    raise ValueError(
                        "Cette personne ne voit pas ce fil privé. Demande explicitement un DM."
                    )
            post_at = schedule_time(at, self.timezone) if at else None
            # Only the validated ID becomes executable Slack markup. Other
            # mentions (including @channel / subteams) remain literal text.
            body = (
                f"<@{target}> — À la demande de {self.message.user} : "
                + html.escape(text, quote=False)
            )
            action = "schedule" if at else "ping"
            fingerprint = json.dumps(
                [self.message.key, action, target, text, post_at, dm],
                ensure_ascii=False,
            )
            op_id = hashlib.sha256(fingerprint.encode()).hexdigest()
            existing = await to_thread.run_sync(_operation, op_id)
            if existing:
                return existing
            if self.actions >= MAX_ACTIONS:
                raise ValueError(
                    "Limite de cinq actions Slack atteinte pour cette demande."
                )
            self.actions += 1
            # Opening a DM cannot send message content; the receipt still
            # precedes every message creation or scheduling request.
            if dm:
                channel, thread = await self.client.open_dm(target), None
            await to_thread.run_sync(
                self._reserve, op_id, action, target, channel, thread, body, post_at
            )
            payload = {
                "channel": channel,
                "text": body,
                "parse": "none",
                "link_names": False,
                "unfurl_links": False,
                "unfurl_media": False,
            }
            if thread:
                payload["thread_ts"] = thread
            if post_at:
                payload["post_at"] = post_at
            result = await self.client.call(
                "chat.scheduleMessage" if at else "chat.postMessage", payload
            )
            slack_id = result.get("scheduled_message_id" if at else "ts")
            if not isinstance(slack_id, str) or not slack_id:
                raise SlackError("Slack n'a pas confirmé l'identifiant de l'opération.")
            await to_thread.run_sync(
                self._complete, op_id, slack_id, "scheduled" if at else "sent"
            )
            return {
                "id": op_id,
                "status": "scheduled" if at else "sent",
                "target": target,
                "channel": channel,
                "thread": thread,
                "post_at": post_at,
                "timezone": self.timezone,
            }

    def _reserve(self, op_id, action, target, channel, thread, body, post_at) -> None:
        with transaction() as con:
            count = con.execute("SELECT count(*) FROM app.slack_operations").fetchone()
            assert count is not None
            if count[0] >= MAX_OPERATIONS:
                raise ValueError("Journal Slack plein ; intervention requise.")
            con.execute(
                "INSERT INTO app.slack_operations (operation_id,event_key,account_id,team_id,action,target_id,channel_id,thread_ts,body,post_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,'uncertain')",
                [
                    op_id,
                    self.message.key,
                    self.account_id,
                    self.message.team,
                    action,
                    target,
                    channel,
                    thread,
                    body,
                    post_at,
                ],
            )

    @staticmethod
    def _complete(op_id: str, slack_id: str, status: str) -> None:
        with transaction() as con:
            con.execute(
                "UPDATE app.slack_operations SET slack_id=?,status=? WHERE operation_id=?",
                [slack_id, status, op_id],
            )

    async def reminders(self) -> dict:
        await self.authorize()
        with db_connection() as con:
            rows = con.execute(
                "SELECT operation_id,target_id,channel_id,thread_ts,post_at,status FROM app.slack_operations "
                "WHERE team_id=? AND account_id=? AND action='schedule' ORDER BY created_at DESC LIMIT 101",
                [self.message.team, self.account_id],
            ).fetchall()
        if len(rows) > 100:
            raise ValueError(
                "Plus de 100 rappels ; intervention requise pour consulter le journal."
            )
        # A passed due date is not evidence of delivery by Slack.
        return {
            "reminders": [
                dict(
                    zip(
                        ("id", "target", "channel", "thread", "post_at", "status"),
                        r,
                        strict=True,
                    )
                )
                for r in rows
            ],
            "note": "scheduled signifie accepté par Slack, pas livraison vérifiée.",
        }

    async def cancel(self, operation_id: str) -> dict:
        async with self.lock:
            await self.authorize()
            if self.private:
                raise PermissionError(
                    "Annule le rappel depuis un fil produit sans données privées."
                )
            with db_connection() as con:
                row = con.execute(
                    "SELECT channel_id,slack_id,post_at,status FROM app.slack_operations "
                    "WHERE operation_id=? AND team_id=? AND account_id=? AND action='schedule'",
                    [operation_id, self.message.team, self.account_id],
                ).fetchone()
            if not row:
                raise ValueError("Rappel introuvable pour cet administrateur.")
            channel, slack_id, post_at, status = row
            if status == "cancelled":
                return {"id": operation_id, "status": status}
            if status != "scheduled" or not slack_id:
                raise ValueError(
                    "Résultat incertain : vérification manuelle requise, aucun rejeu."
                )
            if post_at - datetime.now(UTC).timestamp() <= CANCEL_GUARD_SECONDS:
                raise ValueError(
                    "Annulation impossible dans les 60 dernières secondes ou après l'échéance."
                )
            if self.actions >= MAX_ACTIONS:
                raise ValueError("Limite de cinq actions Slack atteinte.")
            self.actions += 1
            cancel_id = hashlib.sha256((operation_id + ":cancel").encode()).hexdigest()
            if await to_thread.run_sync(_operation, cancel_id):
                raise ValueError(
                    "Une annulation a déjà été tentée ; vérifie son résultat."
                )
            await to_thread.run_sync(
                self._reserve,
                cancel_id,
                "cancel",
                "",
                channel,
                None,
                operation_id,
                post_at,
            )
            await to_thread.run_sync(
                self._complete, operation_id, slack_id, "cancel_uncertain"
            )
            await self.client.call(
                "chat.deleteScheduledMessage",
                {"channel": channel, "scheduled_message_id": slack_id},
            )
            await to_thread.run_sync(
                self._complete, operation_id, slack_id, "cancelled"
            )
            await to_thread.run_sync(self._complete, cancel_id, slack_id, "cancelled")
            return {"id": operation_id, "status": "cancelled"}
