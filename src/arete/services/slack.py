"""Slack conversations for every athlete and durable, at-most-once dispatch.

Slack owns history. The database stores delivery IDs and one run reservation
per athlete, never conversation text. A crashed/ambiguous run stays reserved:
replaying a coach that can write training data would be unsafe. The caller
resolves the author's athlete and runs ``dispatch`` in that athlete's scope.
"""

from __future__ import annotations

import asyncio
import html
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Literal

import duckdb
from anyio import to_thread

from arete.dataio.db import transaction
from arete.services import consent, slack_athletes
from arete.services.athlete_scope import current_athlete_id

if TYPE_CHECKING:
    import httpx

logger = logging.getLogger(__name__)

MAX_HISTORY_MESSAGES = 60
MAX_MESSAGE_CHARS = 16_000
MAX_REPLY_CHARS = 39_000
MAX_DELIVERY_RECORDS = 100_000
MAX_JOB_SECONDS = 240
SLACK_HTTP_TIMEOUT_SECONDS = 10
FINISH_ATTEMPTS = 5
FINISH_RETRY_SECONDS = 0.2

FAILURE_MESSAGE = (
    "Le coach n’a pas pu terminer. Des modifications ont peut-être déjà été "
    "effectuées : vérifie Arete avant de poursuivre. Cette demande ne sera "
    "pas relancée automatiquement."
)
BUSY_MESSAGE = (
    "Une demande est déjà en cours ou doit être vérifiée après une interruption. "
    "Ce message n’a pas été exécuté. Attends la réponse avant de poursuivre."
)
UNLINKED_MESSAGE = (
    "Aucun compte Arete n’est associé à l’adresse e-mail de ton profil Slack. "
    "Connecte-toi à Arete avec cette adresse, puis réessaie."
)
UNCONSENTED_MESSAGE = (
    "Avant que le coach puisse te répondre, accepte les conditions d’utilisation, "
    "la politique de confidentialité et le traitement de tes données de santé "
    "dans l’application Arete."
)
PRIVATE_NOTE = (
    "<@{user}> je t’ai répondu en message privé. Pour recevoir les réponses ici, "
    "active les réponses publiques dans Réglages → Connexions."
)
OTHER_PARTICIPANT = "[Autre participant <@{user}>] "

Visibility = Literal["private", "public"]
Emitter = Callable[[dict], Awaitable[None]]
Producer = Callable[[list[dict[str, str]], str, Visibility, Emitter], Awaitable[str]]

# One stream per run; batch UI updates without spending another model request.
STREAM_FLUSH_SECONDS = 1.0
MAX_STREAM_APPENDS = 240
MAX_STREAM_CHARS = 64_000
MAX_PENDING_CHARS = 10_000
MAX_PENDING_CHUNKS = 100
MAX_TASKS = 50
MAX_MARKDOWN_CHARS = 12_000
# Keep recognizing interrupted messages produced before the native-only UI.
PENDING_ANSWER = "⏳ Réponse provisoire — génération en cours."
ARETE_REACTION = "image-5"
TOOL_LABELS = {
    "read_file": "Lecture d’un fichier",
    "ls": "Recherche dans tes notes",
    "glob": "Recherche dans tes notes",
    "grep": "Recherche dans tes notes",
    "edit_file": "Mise à jour de tes notes",
    "delete": "Suppression dans tes notes",
    "append_journal": "Mise à jour du journal",
    "get_workload": "Analyse de la charge",
    "get_fitness": "Analyse de la forme",
    "get_training_advice": "Préparation des recommandations",
    "list_recent_sessions": "Lecture de tes séances",
    "get_activity_detail": "Analyse de la séance",
    "save_workout": "Enregistrement de la séance",
    "list_strength_sessions": "Lecture de tes séances de musculation",
    "update_workout": "Correction de la séance",
    "get_strength_progress": "Lecture de ta progression en force",
    "list_planned": "Lecture du planning",
    "inspect_planned_session": "Lecture des étapes",
    "list_garmin_devices": "Recherche des appareils Garmin",
    "export_garmin_sessions": "Programmation dans Garmin",
    "reconcile_garmin_session": "Vérification Garmin",
    "sync_garmin_activities": "Synchronisation Garmin",
    "create_planned_session": "Création d’une séance",
    "update_planned_session": "Modification d’une séance",
    "delete_planned_session": "Suppression d’une séance",
}


@dataclass(frozen=True)
class SlackMessage:
    team: str
    event_id: str
    app_id: str
    channel: str
    user: str
    ts: str
    thread_ts: str
    text: str
    # The dedicated channel rather than a direct message.
    in_channel: bool = False
    # The text mentions the bot user, so a channel message addresses Arete.
    mentioned: bool = False
    bot_user: str = ""

    @property
    def key(self) -> str:
        return f"{self.team}:{self.event_id}"

    @property
    def thread_id(self) -> str:
        return f"slack:{self.team}:{self.channel}:{self.thread_ts}"


@dataclass
class SlackPreparation:
    produce: Producer
    product: bool = False
    private: bool = False
    account_id: str = ""
    finalize: Callable[[], None] | None = None


class SlackError(RuntimeError):
    """An operating error, without token or message contents."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class HistoryError(SlackError):
    """A complete usable thread could not be retrieved."""


def reserve(message: SlackMessage) -> Literal["running", "duplicate", "busy"]:
    """Commit ownership before any model or Slack write; never retry a conflict."""
    athlete_id = current_athlete_id()
    slack_athletes.ensure_row(athlete_id)
    with transaction() as con:
        if con.execute(
            "SELECT 1 FROM app.slack_deliveries WHERE event_key = ?", [message.key]
        ).fetchone():
            return "duplicate"
        count = con.execute("SELECT count(*) FROM app.slack_deliveries").fetchone()
        assert count is not None
        if count[0] >= MAX_DELIVERY_RECORDS:
            raise SlackError("Slack delivery ledger is full; operator review required")
        # Touch even a busy row: all of an athlete's admissions must conflict on
        # it, otherwise simultaneous busy deliveries could exceed the ledger bound.
        owner = con.execute(
            "UPDATE app.slack_athletes SET run_event_key = coalesce(run_event_key, ?) "
            "WHERE athlete_id = ? RETURNING run_event_key",
            [message.key, athlete_id],
        ).fetchone()
        assert owner is not None, "Slack athlete row is missing"
        status: Literal["running", "busy"] = (
            "running" if owner[0] == message.key else "busy"
        )
        con.execute(
            "INSERT INTO app.slack_deliveries (event_key, status, thread_id) VALUES (?, ?, ?)",
            [message.key, status, message.thread_id],
        )
        return status


def record_refusal(message: SlackMessage) -> bool:
    """Record an event answered with a refusal; False for a redelivery.

    The same ledger as ``reserve``, without the athlete's run reservation:
    nothing runs, and a later redelivery of the event is a duplicate there too.
    """
    with transaction() as con:
        if con.execute(
            "SELECT 1 FROM app.slack_deliveries WHERE event_key = ?", [message.key]
        ).fetchone():
            return False
        count = con.execute("SELECT count(*) FROM app.slack_deliveries").fetchone()
        assert count is not None
        if count[0] >= MAX_DELIVERY_RECORDS:
            raise SlackError("Slack delivery ledger is full; operator review required")
        con.execute(
            "INSERT INTO app.slack_deliveries (event_key, status, thread_id) VALUES (?, 'refused', ?)",
            [message.key, message.thread_id],
        )
    return True


def set_delivery_thread(message: SlackMessage, destination: SlackMessage) -> None:
    """Record the actual reply destination before any provisional text can land."""
    with transaction() as con:
        con.execute(
            "UPDATE app.slack_deliveries SET thread_id = ? WHERE event_key = ? RETURNING event_key",
            [destination.thread_id, message.key],
        )


def check_thread_delivery(message: SlackMessage) -> None:
    """An interrupted stream stays untrusted even after Slack stops displaying it."""
    with transaction() as con:
        interrupted = con.execute(
            "SELECT 1 FROM app.slack_deliveries WHERE thread_id = ? "
            "AND event_key != ? AND status IN ('running', 'failed') LIMIT 1",
            [message.thread_id, message.key],
        ).fetchone()
    if interrupted:
        raise HistoryError(
            "Ce fil contient une réponse interrompue ou en cours. Vérifie Arete, "
            "puis commence un nouveau fil."
        )


def finish(message: SlackMessage, status: str, *, release: bool) -> None:
    """Idempotent, so a write conflict is retried: a lost release would leave
    every later message busy until an operator unblocks it."""
    for attempt in range(1, FINISH_ATTEMPTS + 1):
        try:
            with transaction() as con:
                con.execute(
                    "UPDATE app.slack_deliveries SET status = ?, updated_at = now() "
                    "WHERE event_key = ? RETURNING event_key",
                    [status, message.key],
                )
                if release:
                    con.execute(
                        "UPDATE app.slack_athletes SET run_event_key = NULL "
                        "WHERE athlete_id = ? AND run_event_key = ? RETURNING athlete_id",
                        [current_athlete_id(), message.key],
                    )
            return
        except duckdb.TransactionException:
            if attempt == FINISH_ATTEMPTS:
                raise
            time.sleep(FINISH_RETRY_SECONDS * attempt)


class SlackClient:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self.http = http
        self.author_timezone = "Europe/Paris"

    async def call(self, method: str, payload: dict) -> dict:
        # No SDK retries: an uncertain chat.postMessage must not be replayed.
        url = f"https://slack.com/api/{method}"
        if method in (
            "conversations.replies",
            "users.info",
            "users.list",
            "conversations.members",
        ):
            response = await self.http.get(url, params=payload)
        else:
            response = await self.http.post(url, json=payload)
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict) or result.get("ok") is not True:
            code = result.get("error") if isinstance(result, dict) else None
            raise SlackError(
                f"Slack {method} failed", code=code if isinstance(code, str) else None
            )
        return result

    async def react(self, message: SlackMessage) -> None:
        """Acknowledge once; a cosmetic failure must not cancel the coach."""
        import httpx  # here, not at module level: the API boot skips httpx

        try:
            await self.call(
                "reactions.add",
                {
                    "channel": message.channel,
                    "timestamp": message.ts,
                    "name": ARETE_REACTION,
                },
            )
        except SlackError as exc:
            if exc.code != "already_reacted":
                logger.warning(
                    "Slack logo reaction failed: %s (%s)", message.key, exc.code
                )
        except httpx.HTTPError:
            logger.exception("Slack logo reaction request failed: %s", message.key)

    async def _thread(self, message: SlackMessage) -> list[dict]:
        result = await self.call(
            "conversations.replies",
            {
                "channel": message.channel,
                "ts": message.thread_ts,
                "latest": message.ts,
                "inclusive": True,
                "limit": MAX_HISTORY_MESSAGES + 1,
            },
        )
        rows = result.get("messages")
        if (
            not isinstance(rows, list)
            or not rows
            or len(rows) > MAX_HISTORY_MESSAGES
            or result.get("has_more")
            or result.get("response_metadata", {}).get("next_cursor")
        ):
            raise HistoryError(
                "Le fil est trop long ou incomplet. Commence une nouvelle conversation "
                "en écrivant un nouveau message à Arete."
            )
        return rows

    @staticmethod
    def _from_this_app(row: dict, message: SlackMessage) -> bool:
        return row.get("app_id") == message.app_id and bool(row.get("bot_id"))

    async def engaged(self, message: SlackMessage) -> bool:
        """Whether a channel thread reply belongs to a conversation with Arete."""
        rows = await self._thread(message)
        root = rows[0].get("text")
        return any(self._from_this_app(row, message) for row in rows) or (
            bool(message.bot_user)
            and isinstance(root, str)
            and f"<@{message.bot_user}>" in root
        )

    async def author_email(self, message: SlackMessage) -> str | None:
        """A full member's confirmed workspace address, else None."""
        result = await self.call("users.info", {"user": message.user})
        user = result.get("user")
        if (
            not isinstance(user, dict)
            or user.get("team_id") != message.team
            or user.get("deleted")
            or user.get("is_bot")
            or user.get("is_restricted")
            or user.get("is_ultra_restricted")
            or user.get("is_email_confirmed") is False
        ):
            return None
        self.author_timezone = user.get("tz") or "Europe/Paris"
        email = (user.get("profile") or {}).get("email")
        return email if isinstance(email, str) and email.strip() else None

    async def history(self, message: SlackMessage) -> list[dict[str, str]]:
        if message.thread_ts == message.ts:
            return [{"role": "user", "content": message.text}]
        await to_thread.run_sync(check_thread_delivery, message)
        rows = await self._thread(message)
        history = []
        for row in rows:
            prefix = ""
            if self._from_this_app(row, message):
                role = "assistant"
            elif row.get("user") == message.user and not row.get("bot_id"):
                role = "user"
            elif message.in_channel and row.get("user") and not row.get("bot_id"):
                # Another member of the channel: never this athlete's own words.
                role = "user"
                prefix = OTHER_PARTICIPANT.format(user=row["user"])
            else:
                raise HistoryError("Ce fil contient un participant non autorisé.")
            text = row.get("text")
            if role == "assistant" and (
                isinstance(text, str)
                and text.startswith(PENDING_ANSWER)
                or any(
                    block.get("block_id") == "arete_pending"
                    for block in row.get("blocks", [])
                    if isinstance(block, dict)
                )
            ):
                raise HistoryError(
                    "Ce fil contient une réponse interrompue. Vérifie les modifications "
                    "dans Arete, puis commence un nouveau fil."
                )
            if row.get("files") or not isinstance(text, str) or not text.strip():
                raise HistoryError(
                    "Ce fil contient un message non textuel non pris en charge."
                )
            limit = MAX_REPLY_CHARS if role == "assistant" else MAX_MESSAGE_CHARS
            if len(text) > limit:
                raise HistoryError(
                    "Un message du fil est trop long. Commence un nouveau fil."
                )
            history.append({"role": role, "content": prefix + text})
        # Fail closed if Slack returned stale or unexpected history. Never silently
        # lose the current objective or append it twice.
        if rows[0].get("ts") != message.thread_ts or rows[-1].get("ts") != message.ts:
            raise HistoryError(
                "L’historique Slack est incomplet. Réessaie dans un nouveau fil."
            )
        if history[-1] != {"role": "user", "content": message.text}:
            raise HistoryError(
                "Le message a changé pendant son traitement. Envoie un nouveau message."
            )
        return history

    async def open_dm(self, user: str) -> str:
        result = await self.call("conversations.open", {"users": user})
        channel = (result.get("channel") or {}).get("id")
        if not isinstance(channel, str) or not channel:
            raise SlackError("Slack conversations.open returned no channel")
        return channel

    async def post(self, channel: str, thread_ts: str | None, text: str) -> str:
        if not text.strip() or len(text) > MAX_REPLY_CHARS:
            raise SlackError("Coach answer is empty or exceeds Slack's message budget")
        payload: dict = {
            "channel": channel,
            "text": text,
            "mrkdwn": False,
            "parse": "none",
            "link_names": False,
            "unfurl_links": False,
            "unfurl_media": False,
        }
        if thread_ts:
            payload["thread_ts"] = thread_ts
        result = await self.call("chat.postMessage", payload)
        return message_timestamp(result)

    async def reply(self, message: SlackMessage, text: str) -> None:
        await self.post(message.channel, message.thread_ts, text)


def message_timestamp(result: dict) -> str:
    value = result.get("ts")
    if not isinstance(value, str) or not value:
        raise SlackError("Slack returned no message timestamp")
    return value


class SlackStream:
    """Invocation-local UI, never an owner of execution or conversation state."""

    def __init__(self, client: SlackClient, message: SlackMessage) -> None:
        self.client = client
        self.message = message
        self.ts = ""
        self.processing = False
        self.stop_attempted = False
        self.pending: list[dict] = []
        self.pending_chars = 0
        self.chars = 0
        self.appends = 0
        self.last_flush = 0.0
        self.last_message = ""
        self.tasks: dict[str, str] = {}

    async def status(self, value: str) -> None:
        await self.client.call(
            "agents.sessions.setStatus",
            {
                "channel_id": self.message.channel,
                "thread_ts": self.message.thread_ts,
                "status": value,
            },
        )

    async def start(self) -> None:
        # Even an uncertain status write needs a best-effort clear at exit.
        self.processing = True
        await self.status("processing")

    async def emit(self, event: dict) -> None:
        kind = event["type"]
        if kind == "token":
            text = html.escape(event["text"], quote=False)
            if self.last_message and self.last_message != event["id"]:
                text = "\n\n" + text
            self.last_message = event["id"]
            self.chars += len(text)
            if self.chars > MAX_STREAM_CHARS or len(text) > MAX_PENDING_CHARS:
                raise SlackError("Slack stream exceeds its text budget")
            if self.pending_chars + len(text) > MAX_PENDING_CHARS:
                await self.flush()
            if self.pending and self.pending[-1]["type"] == "markdown_text":
                self.pending[-1]["text"] += text
            else:
                self.pending.append({"type": "markdown_text", "text": text})
            self.pending_chars += len(text)
        elif kind in ("tool_start", "tool_end"):
            call_id = event["id"]
            if call_id not in self.tasks:
                if len(self.tasks) >= MAX_TASKS:
                    raise SlackError("Slack stream exceeds its task budget")
                # Compact transport IDs bound payload size; no arguments or
                # result previews leave the runtime through these task cards.
                self.tasks[call_id] = f"task-{len(self.tasks) + 1}"
            status = (
                "in_progress"
                if kind == "tool_start"
                else "error"
                if event["status"] == "error"
                else "complete"
            )
            self.pending.append(
                {
                    "type": "task_update",
                    "id": self.tasks[call_id],
                    "title": TOOL_LABELS.get(event["name"], "Action du coach"),
                    "status": status,
                }
            )
        else:
            return
        if (
            len(self.pending) >= MAX_PENDING_CHUNKS
            or time.monotonic() - self.last_flush >= STREAM_FLUSH_SECONDS
        ):
            await self.flush()

    async def flush(self) -> None:
        if not self.pending:
            return
        if self.appends >= MAX_STREAM_APPENDS:
            raise SlackError("Slack stream exceeds its request budget")
        # Large chunks may force a flush before the usual event-time check.
        # Backpressure keeps a single run below the append method's rate limit.
        remaining = STREAM_FLUSH_SECONDS - (time.monotonic() - self.last_flush)
        if remaining > 0:
            await asyncio.sleep(remaining)
        # No retry, even if the connection fails after Slack accepted the append.
        self.appends += 1
        chunks, self.pending = self.pending, []
        self.pending_chars = 0
        if self.ts:
            await self.client.call(
                "chat.appendStream",
                {"channel": self.message.channel, "ts": self.ts, "chunks": chunks},
            )
        else:
            result = await self.client.call(
                "chat.startStream",
                {
                    "channel": self.message.channel,
                    "thread_ts": self.message.thread_ts,
                    "recipient_user_id": self.message.user,
                    "recipient_team_id": self.message.team,
                    "task_display_mode": "plan",
                    "chunks": [
                        {"type": "plan_update", "title": "Analyse en cours"},
                        *chunks,
                    ],
                },
            )
            self.ts = message_timestamp(result)
        self.last_flush = time.monotonic()

    async def stop(self) -> None:
        if self.ts and not self.stop_attempted:
            self.stop_attempted = True
            await self.client.call(
                "chat.stopStream",
                {"channel": self.message.channel, "ts": self.ts},
            )

    async def finish(self, answer: str) -> None:
        if not answer.strip() or len(answer) > MAX_REPLY_CHARS:
            raise SlackError("Coach answer is empty or exceeds Slack's message budget")
        # Replace provisional text (including failed fallback attempts) with the
        # canonical answer. Plain-text fallback preserves longer answers in full.
        self.pending = []
        await self.stop()
        escaped = html.escape(answer, quote=False)
        payload = {
            "channel": self.message.channel,
            "text": answer,
            "mrkdwn": False,
            "parse": "none",
            "link_names": False,
            "blocks": [{"type": "markdown", "text": escaped}]
            if len(escaped) <= MAX_MARKDOWN_CHARS
            else [],
        }
        if self.ts:
            payload["ts"] = self.ts
            await self.client.call("chat.update", payload)
        else:
            # Providers can return a completed answer without yielding tokens.
            # Post it directly rather than manufacturing an empty stream.
            payload["thread_ts"] = self.message.thread_ts
            payload["unfurl_links"] = False
            payload["unfurl_media"] = False
            await self.client.call("chat.postMessage", payload)

    async def cleanup(self) -> None:
        # Cleanup failures must remain visible without replacing the run's error.
        try:
            await self.stop()
        except Exception:
            logger.exception("Slack stream closure failed: %s", self.message.key)
        if self.processing:
            try:
                await self.status("active")
            except Exception:
                logger.exception("Slack status cleanup failed: %s", self.message.key)


async def resolve(message: SlackMessage, *, client: SlackClient) -> int | None:
    """The author's athlete, or None once the message needs nothing more.

    A channel message that neither mentions Arete nor continues one of its
    threads is ignored. An author without a verified Arete account is told so.
    """
    # Top-level chatter costs no Slack call; only thread replies are checked.
    if (
        message.in_channel
        and not message.mentioned
        and (message.thread_ts == message.ts or not await client.engaged(message))
    ):
        return None
    email = await client.author_email(message)
    athlete_id = (
        await to_thread.run_sync(slack_athletes.athlete_for_email, email)
        if email
        else None
    )
    if athlete_id is not None and not await to_thread.run_sync(
        consent.allows_processing, athlete_id
    ):
        # Nothing of the athlete's reaches the coach before their consent, and
        # whether they gave it is theirs alone: a channel never hears it. Once
        # per event: Slack's redeliveries are recorded duplicates.
        if not await to_thread.run_sync(record_refusal, message):
            return None
        if message.in_channel:
            channel = await client.open_dm(message.user)
            await client.post(channel, None, UNCONSENTED_MESSAGE)
        else:
            await client.reply(message, UNCONSENTED_MESSAGE)
        return None
    if athlete_id is not None and email:
        from arete.services.slack_identity import link

        zone = getattr(client, "author_timezone", "Europe/Paris")
        await to_thread.run_sync(
            link,
            message.team,
            message.user,
            email,
            zone if isinstance(zone, str) else "Europe/Paris",
        )
    if athlete_id is None:
        await client.reply(message, UNLINKED_MESSAGE)
    return athlete_id


async def dispatch(
    message: SlackMessage,
    *,
    client: SlackClient,
    produce: Producer,
    prepare: Callable[..., Awaitable[SlackPreparation]] | None = None,
) -> str | None:
    """Answer one message; the caller holds the author's athlete scope."""
    try:
        status = await to_thread.run_sync(reserve, message)
    except duckdb.TransactionException:
        # A concurrent admission touched the reservation first. Nothing was
        # recorded or executed, so say so rather than dropping the message.
        status = "busy"
    if status == "duplicate":
        return None
    if status == "busy":
        await client.reply(message, BUSY_MESSAGE)
        return None
    started_coach = False
    completed_coach = False
    output: SlackStream | None = None
    delivery_status = "failed"
    prepared: SlackPreparation | None = None
    try:
        async with asyncio.timeout(MAX_JOB_SECONDS):
            if not message.text.strip() or len(message.text) > MAX_MESSAGE_CHARS:
                raise HistoryError("Envoie un message texte de 1 à 16 000 caractères.")
            history = await client.history(message)
            prepared = (
                await prepare(history, message, client)
                if prepare
                else SlackPreparation(produce)
            )
            produce = prepared.produce
            # Product coordination is public; athlete coaching still requires consent.
            visibility: Visibility = (
                "public"
                if message.in_channel
                and not prepared.private
                and (
                    prepared.product
                    or await to_thread.run_sync(slack_athletes.public_replies)
                )
                else "private"
            )
            destination = message
            if message.in_channel and visibility == "private":
                channel = await client.open_dm(message.user)
                root = await client.post(
                    channel, None, "Ta demande dans un canal :\n" + message.text
                )
                destination = replace(message, channel=channel, thread_ts=root)
                await to_thread.run_sync(set_delivery_thread, message, destination)
            if prepared.private:
                from arete.services.slack_identity import mark_private

                await to_thread.run_sync(
                    mark_private, destination.thread_id, prepared.account_id
                )
            output = SlackStream(client, destination)
            await output.start()
            await client.react(message)
            started_coach = True
            answer = await produce(history, message.thread_id, visibility, output.emit)
            completed_coach = True
            await output.finish(answer)
            if message.in_channel and visibility == "private":
                await client.reply(
                    message,
                    "Je t’ai répondu en DM administrateur."
                    if prepared.private
                    else PRIVATE_NOTE.format(user=message.user),
                )
        delivery_status = "sent"
        return answer
    except HistoryError as exc:
        delivery_status = "rejected"
        await client.reply(message, str(exc))
    except BaseException:
        # A cancelled synchronous tool can still be writing in an AnyIO worker.
        # Keep the reservation until an operator has checked ambiguous runs.
        logger.exception("Slack delivery failed: %s", message.key)
        # A failed send may actually have landed. Do not post another message then.
        if (
            not completed_coach
            and output is not None
            and (output.ts or output.appends == 0)
        ):
            try:
                await output.finish(FAILURE_MESSAGE)
            except Exception:
                logger.exception("Slack failure display failed: %s", message.key)
        raise
    finally:
        if prepared and prepared.finalize:
            prepared.finalize()
        if output is not None:
            await output.cleanup()
        # Keep admission locked through status cleanup: an older run must not
        # clear the loading indicator of this athlete's next run.
        await to_thread.run_sync(
            lambda: finish(
                message, delivery_status, release=not started_coach or completed_coach
            )
        )
    return None
