"""Slack transport authorization, complete history and write replay boundaries."""

import asyncio
import hashlib
import hmac
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from unittest.mock import ANY, AsyncMock

import duckdb
import httpx
import pytest

from arete.api import slack as api
from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main as init_db
from arete.services import slack


def mock_slack_client():
    client = AsyncMock(spec=slack.SlackClient)
    client.call.return_value = {"ok": True, "ts": "1700000001.000001"}
    client.post.return_value = "1700000001.000001"
    return client


def final_update(client):
    return [
        c.args[1]
        for c in client.call.await_args_list
        if c.args[0] in ("chat.update", "chat.postMessage")
    ][-1]


@pytest.fixture
def configured(monkeypatch):
    for name, value in {
        "SLACK_SIGNING_SECRET": "test-secret",
        "SLACK_BOT_TOKEN": "test-token",
        "SLACK_TEAM_ID": "T123",
    }.items():
        monkeypatch.setenv(name, value)
    worker = AsyncMock()
    monkeypatch.setattr(api, "process_message", worker)
    return worker


@pytest.fixture
def message():
    return slack.SlackMessage(
        "T123",
        "Ev1",
        "A123",
        "D123",
        "U123",
        "1700000000.000001",
        "1700000000.000001",
        "Ma séance ?",
    )


@pytest.fixture
def payload(message):
    return {
        "type": "event_callback",
        "team_id": message.team,
        "event_id": message.event_id,
        "api_app_id": message.app_id,
        "event": {
            "type": "message",
            "channel_type": "im",
            "user": message.user,
            "channel": message.channel,
            "ts": message.ts,
            "text": message.text,
        },
    }


def signed(payload, *, age=0, secret="test-secret"):
    raw = json.dumps(payload).encode()
    timestamp = str(int(time.time()) - age)
    digest = hmac.new(
        secret.encode(), b"v0:" + timestamp.encode() + b":" + raw, hashlib.sha256
    ).hexdigest()
    return {
        "content": raw,
        "headers": {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": f"v0={digest}",
        },
    }


def test_signed_challenge_does_not_run_coach(router_client, configured):
    response = router_client(api.router).post(
        "/slack/events",
        **signed({"type": "url_verification", "challenge": "challenge"}),
    )
    assert response.json() == {"challenge": "challenge"}
    configured.assert_not_called()


@pytest.mark.parametrize("options", [{"secret": "wrong"}, {"age": 301}, {"age": -301}])
def test_invalid_signatures_rejected(
    router_client, configured, payload, options, monkeypatch
):
    # A future signature 301s ahead can become valid if a slow CI request takes
    # over a second. Freeze signing and verification at the same instant.
    monkeypatch.setattr(time, "time", lambda: 1_800_000_000)
    response = router_client(api.router).post(
        "/slack/events", **signed(payload, **options)
    )
    assert response.status_code == 401
    configured.assert_not_called()


@pytest.mark.parametrize("age", [-300, 300])
def test_signature_window_includes_exact_boundary(
    router_client, configured, monkeypatch, age
):
    monkeypatch.setattr(time, "time", lambda: 1_800_000_000)
    response = router_client(api.router).post(
        "/slack/events",
        **signed({"type": "url_verification", "challenge": "boundary"}, age=age),
    )
    assert response.json() == {"challenge": "boundary"}
    configured.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"channel_type": "mpim"},
        {"bot_id": "B123"},
        {"subtype": "message_changed"},
        {"files": [{"id": "F123"}]},
    ],
)
def test_only_plain_text_dm_or_channel_runs(
    router_client, configured, payload, changes
):
    payload["event"].update(changes)
    assert (
        router_client(api.router).post("/slack/events", **signed(payload)).status_code
        == 200
    )
    configured.assert_not_called()


def test_other_workspace_ignored(router_client, configured, payload):
    payload["team_id"] = "T999"
    assert (
        router_client(api.router).post("/slack/events", **signed(payload)).status_code
        == 200
    )
    configured.assert_not_called()


def test_missing_configuration_fails_closed(
    router_client, configured, payload, monkeypatch
):
    monkeypatch.delenv("SLACK_TEAM_ID")
    assert (
        router_client(api.router).post("/slack/events", **signed(payload)).status_code
        == 503
    )
    configured.assert_not_called()


def test_allowed_dm_schedules_exact_message(
    router_client, configured, payload, message
):
    assert (
        router_client(api.router).post("/slack/events", **signed(payload)).status_code
        == 200
    )
    configured.assert_awaited_once_with(message, "test-token")


def test_any_member_dm_is_scheduled_for_resolution(
    router_client, configured, payload, message
):
    payload["event"]["user"] = "U999"
    router_client(api.router).post("/slack/events", **signed(payload))
    configured.assert_awaited_once_with(replace(message, user="U999"), "test-token")


def test_mention_in_any_invited_channel_is_scheduled(
    router_client, configured, payload, message
):
    payload["authorizations"] = [{"is_bot": True, "user_id": "UBOT"}]
    payload["event"].update(
        {"channel": "C123", "channel_type": "channel", "text": "<@UBOT> séance ?"}
    )
    router_client(api.router).post("/slack/events", **signed(payload))
    configured.assert_awaited_once_with(
        replace(
            message,
            channel="C123",
            text="<@UBOT> séance ?",
            in_channel=True,
            mentioned=True,
            bot_user="UBOT",
        ),
        "test-token",
    )


def test_receipt_sent_before_background_work(configured, payload, monkeypatch):
    from fastapi import FastAPI

    from arete.dataio.mirror import MirrorMiddleware

    app = FastAPI()
    app.include_router(api.router)
    app.add_middleware(MirrorMiddleware)
    monkeypatch.setenv("ARETE_DB", "md:unused")
    output = []

    async def worker(*args):
        assert output[-1]["type"] == "http.response.body"
        assert not output[-1].get("more_body", False)

    monkeypatch.setattr(api, "process_message", worker)
    request = signed(payload)

    async def run():
        async def receive():
            return {
                "type": "http.request",
                "body": request["content"],
                "more_body": False,
            }

        async def send(part):
            output.append(part)

        await app(
            {
                "type": "http",
                "method": "POST",
                "path": "/slack/events",
                "query_string": b"",
                "headers": [
                    (k.encode(), v.encode()) for k, v in request["headers"].items()
                ],
            },
            receive,
            send,
        )

    asyncio.run(run())
    assert output[0]["status"] == 200


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "slack.duckdb"))
    init_db()


def test_duplicates_and_overlapping_requests_are_not_executed(ledger, message):
    assert slack.reserve(message) == "running"
    assert slack.reserve(message) == "duplicate"
    assert slack.reserve(replace(message, event_id="Ev2")) == "busy"
    slack.finish(message, "sent", release=True)
    assert slack.reserve(message) == "duplicate"
    assert slack.reserve(replace(message, event_id="Ev2")) == "duplicate"
    assert slack.reserve(replace(message, event_id="Ev3")) == "running"


def test_concurrent_reservation_has_one_owner(ledger, message):
    def attempt(index):
        try:
            return slack.reserve(replace(message, event_id=f"Ev{index}"))
        except duckdb.TransactionException:
            return "conflict"

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(attempt, range(4)))
    assert results.count("running") == 1


def test_ledger_capacity_is_explicit_failure(ledger, message, monkeypatch):
    monkeypatch.setattr(slack, "MAX_DELIVERY_RECORDS", 1)
    slack.reserve(message)
    slack.finish(message, "sent", release=True)
    with pytest.raises(slack.SlackError, match="ledger is full"):
        slack.reserve(replace(message, event_id="Ev2"))


def test_concurrent_busy_deliveries_cannot_exceed_capacity(
    ledger, message, monkeypatch
):
    monkeypatch.setattr(slack, "MAX_DELIVERY_RECORDS", 2)
    slack.reserve(message)

    def attempt(index):
        try:
            return slack.reserve(replace(message, event_id=f"Other{index}"))
        except (duckdb.TransactionException, slack.SlackError):
            return "rejected"

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(attempt, range(4)))
    assert results.count("busy") == 1
    with db_connection() as con:
        assert con.execute("SELECT count(*) FROM app.slack_deliveries").fetchone() == (
            2,
        )


def test_retry_invokes_coach_and_posts_once(ledger, message):
    client = mock_slack_client()
    client.history.return_value = [{"role": "user", "content": message.text}]
    produce = AsyncMock(return_value="Repos aujourd’hui.")

    async def run():
        await slack.dispatch(message, client=client, produce=produce)
        await slack.dispatch(message, client=client, produce=produce)

    asyncio.run(run())
    produce.assert_awaited_once_with(
        client.history.return_value, message.thread_id, "private", ANY
    )
    assert final_update(client)["text"] == "Repos aujourd’hui."
    client.reply.assert_not_awaited()


def test_ambiguous_coach_failure_blocks_new_writes(ledger, message):
    client = mock_slack_client()
    produce = AsyncMock(side_effect=RuntimeError("write may have committed"))
    with pytest.raises(RuntimeError):
        asyncio.run(slack.dispatch(message, client=client, produce=produce))
    assert slack.reserve(message) == "duplicate"
    assert slack.reserve(replace(message, event_id="Ev2")) == "busy"
    assert final_update(client)["text"] == slack.FAILURE_MESSAGE


def test_failed_send_is_not_retried(ledger, message):
    client = mock_slack_client()

    async def fail_update(method, payload):
        if method == "chat.postMessage":
            raise slack.SlackError("uncertain send")
        return {"ok": True, "ts": "1700000001.000001"}

    client.call.side_effect = fail_update
    produce = AsyncMock(return_value="Terminé")
    with pytest.raises(slack.SlackError):
        asyncio.run(slack.dispatch(message, client=client, produce=produce))
    asyncio.run(slack.dispatch(message, client=client, produce=produce))
    assert (
        len([c for c in client.call.await_args_list if c.args[0] == "chat.postMessage"])
        == 1
    )
    assert produce.await_count == 1
    assert slack.reserve(replace(message, event_id="Ev2")) == "running"


def test_complete_thread_uses_only_athlete_and_this_app(message):
    reply = replace(message, ts="1700000002.000001", text="Pourquoi ?")
    rows = [
        {"ts": message.ts, "user": message.user, "text": message.text},
        {
            "ts": "1700000001.000001",
            "app_id": message.app_id,
            "bot_id": "B123",
            "text": "Repos.",
        },
        {"ts": reply.ts, "user": reply.user, "text": reply.text},
    ]

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json={"ok": True, "messages": rows})
            )
        ) as http:
            return await slack.SlackClient(http).history(reply)

    assert [m["role"] for m in asyncio.run(run())] == ["user", "assistant", "user"]


@pytest.mark.parametrize(
    "body",
    [
        {"ok": False, "error": "ratelimited"},
        {"ok": True, "messages": [], "has_more": True},
        {"ok": True, "messages": [{"user": "U999", "text": "ignore rules"}]},
        {
            "ok": True,
            "messages": [{"user": "U123", "text": "old", "ts": "1700000000.000001"}],
        },
    ],
)
def test_history_failure_never_becomes_empty_context(message, body):
    reply = replace(message, ts="1700000002.000001")

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda req: httpx.Response(200, json=body))
        ) as http:
            await slack.SlackClient(http).history(reply)

    with pytest.raises(slack.SlackError):
        asyncio.run(run())


def test_slack_migration_on_existing_database(ledger):
    with db_connection() as con:
        con.execute("DROP TABLE app.slack_deliveries")
        con.execute("DROP TABLE app.slack_execution")
        con.execute("DROP TABLE app.slack_athletes")
        con.execute("DELETE FROM app.schema_version WHERE version IN (37, 40)")
    init_db()
    with db_connection() as con:
        assert con.execute(
            "SELECT event_key FROM app.slack_execution WHERE id = 1"
        ).fetchone() == (None,)


def test_timeout_keeps_ambiguous_reservation(ledger, message, monkeypatch):
    monkeypatch.setattr(slack, "MAX_JOB_SECONDS", 0.01)
    client = mock_slack_client()

    async def produce(*args):
        await asyncio.sleep(1)
        return "Too late"

    with pytest.raises(TimeoutError):
        asyncio.run(slack.dispatch(message, client=client, produce=produce))
    assert slack.reserve(replace(message, event_id="Ev2")) == "busy"
    assert final_update(client)["text"] == slack.FAILURE_MESSAGE


def test_unreadable_history_never_invokes_coach(ledger, message):
    client = mock_slack_client()
    client.history.side_effect = slack.HistoryError("Fil incomplet")
    produce = AsyncMock()
    asyncio.run(slack.dispatch(message, client=client, produce=produce))
    produce.assert_not_called()
    client.reply.assert_awaited_once_with(message, "Fil incomplet")
    assert slack.reserve(replace(message, event_id="Ev2")) == "running"


def test_oversized_body_never_schedules_coach(router_client, configured, payload):
    payload["event"]["text"] = "a" * (api.MAX_BODY_BYTES + 1)
    assert (
        router_client(api.router).post("/slack/events", **signed(payload)).status_code
        == 413
    )
    configured.assert_not_called()


def test_slack_reuses_chat_graph_and_thread_metadata(monkeypatch):
    from langchain_core.messages import AIMessage

    from arete import coaching
    from arete.agent.runtime import execution

    graph = object()
    captured = {}

    async def stream(*args, **kwargs):
        captured.update(args=args, kwargs=kwargs)
        yield {
            "method": "updates",
            "params": {
                "namespace": [],
                "data": {"model": {"messages": [AIMessage(content="Repos.")]}},
            },
        }

    monkeypatch.setattr(coaching, "get_agent", lambda: graph)
    monkeypatch.setattr(execution, "stream_agent", stream)
    history = [{"role": "user", "content": "Ma séance ?"}]
    answer = asyncio.run(
        coaching.run_slack_coach(history, "slack:T:D:1", "public", AsyncMock())
    )
    assert answer == "Repos."
    assert captured["args"] == (graph, {"messages": history})
    context = captured["kwargs"]["context"]
    assert context.profile == "chat"
    assert context.thread_id == "slack:T:D:1"
    assert context.slack_visibility == "public"


def test_slack_chat_graph_is_composed_off_the_event_loop(monkeypatch):
    from langchain_core.messages import AIMessage
    from worker_only import worker_only

    from arete import coaching
    from arete.agent.runtime import execution
    from arete.services.feature_flags import FeatureFlags

    graph = object()

    async def stream(*args, **kwargs):
        assert args[0] is graph
        yield {
            "method": "updates",
            "params": {
                "namespace": [],
                "data": {"model": {"messages": [AIMessage(content="Repos.")]}},
            },
        }

    monkeypatch.setattr(coaching, "get_feature_flags", worker_only(FeatureFlags))
    monkeypatch.setattr(coaching, "_assemble", worker_only(lambda *a, **kw: graph))
    monkeypatch.setattr(execution, "stream_agent", stream)
    coaching.get_agent.cache_clear()
    try:
        answer = asyncio.run(
            coaching.run_slack_coach([], "slack:T:D:1", "public", AsyncMock())
        )
    finally:
        coaching.get_agent.cache_clear()
    assert answer == "Repos."


@pytest.mark.parametrize("resolved", [7, None])
def test_background_work_runs_as_the_resolved_athlete(
    message, monkeypatch, tmp_path, resolved
):
    from arete.services.athlete_scope import current_athlete_id

    monkeypatch.setenv("ARETE_AUTH", "clerk")  # no implicit athlete without a scope
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "scope.duckdb"))
    seen = []

    async def resolve(*args, **kwargs):
        return resolved

    async def dispatch(*args, **kwargs):
        seen.append(current_athlete_id())

    monkeypatch.setattr(slack, "resolve", resolve)
    monkeypatch.setattr(slack, "dispatch", dispatch)
    asyncio.run(api.process_message(message, "test-token"))
    assert seen == ([resolved] if resolved else [])


def test_reservation_conflict_answers_busy_without_coach(ledger, message, monkeypatch):
    def conflict(_message):
        raise duckdb.TransactionException("Conflict on tuple deletion!")

    monkeypatch.setattr(slack, "reserve", conflict)
    client = mock_slack_client()
    produce = AsyncMock()
    asyncio.run(slack.dispatch(message, client=client, produce=produce))
    produce.assert_not_awaited()
    client.reply.assert_awaited_once_with(message, slack.BUSY_MESSAGE)


def test_release_survives_a_transient_conflict(ledger, message, monkeypatch):
    monkeypatch.setattr(slack, "FINISH_RETRY_SECONDS", 0)
    assert slack.reserve(message) == "running"
    real = slack.transaction
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise duckdb.TransactionException("Conflict on tuple update!")
        return real()

    monkeypatch.setattr(slack, "transaction", flaky)
    slack.finish(message, "sent", release=True)
    monkeypatch.setattr(slack, "transaction", real)
    assert slack.reserve(replace(message, event_id="Ev2")) == "running"


def _account(clerk_id, email, athlete_id, *, verified=True):
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.athletes (id) VALUES (?) ON CONFLICT DO NOTHING",
            [athlete_id],
        )
        con.execute(
            "INSERT INTO app.users (clerk_user_id, email, athlete_id, email_verified_at) "
            "VALUES (?, ?, ?, CASE WHEN ? THEN now() END)",
            [clerk_id, email, athlete_id, verified],
        )


def test_email_resolves_only_a_verified_single_athlete(ledger, monkeypatch):
    from arete.services import slack_athletes

    monkeypatch.setenv("ARETE_OWNER_EMAIL", "owner@example.com")
    _account("c1", "Arthur@Example.com", 2)
    _account("c2", "unverified@example.com", 3, verified=False)
    _account("c3", "shared@example.com", 4)
    _account("c4", "shared@example.com", 5)
    assert slack_athletes.athlete_for_email(" arthur@example.com ") == 2
    assert slack_athletes.athlete_for_email("owner@example.com") == 1
    assert slack_athletes.athlete_for_email("unverified@example.com") is None
    assert slack_athletes.athlete_for_email("shared@example.com") is None
    assert slack_athletes.athlete_for_email("nobody@example.com") is None
    with db_connection() as con:
        con.execute("UPDATE app.athletes SET deleted_at = now() WHERE id = 2")
    assert slack_athletes.athlete_for_email("arthur@example.com") is None


@pytest.mark.parametrize(
    "user",
    [
        {"team_id": "T999"},
        {"is_restricted": True},
        {"is_ultra_restricted": True},
        {"is_bot": True},
        {"deleted": True},
        {"is_email_confirmed": False},
        {"profile": {}},
    ],
)
def test_only_full_members_with_a_confirmed_email_are_identified(message, user):
    body = {
        "ok": True,
        "user": {"team_id": "T123", "profile": {"email": "a@example.com"}} | user,
    }

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda req: httpx.Response(200, json=body))
        ) as http:
            return await slack.SlackClient(http).author_email(message)

    assert asyncio.run(run()) is None


def test_unknown_author_is_told_and_never_reaches_the_coach(ledger, message):
    client = mock_slack_client()
    client.author_email.return_value = "nobody@example.com"
    assert asyncio.run(slack.resolve(message, client=client)) is None
    client.reply.assert_awaited_once_with(message, slack.UNLINKED_MESSAGE)


def test_channel_chatter_outside_arete_threads_is_ignored(ledger, message):
    client = mock_slack_client()
    client.engaged.return_value = False
    reply = replace(message, in_channel=True, thread_ts="1699999999.000001")
    assert asyncio.run(slack.resolve(reply, client=client)) is None
    client.author_email.assert_not_awaited()
    client.reply.assert_not_awaited()


def test_channel_thread_labels_other_participants(message):
    reply = replace(
        message, ts="1700000002.000001", text="Et moi ?", user="U999", in_channel=True
    )
    rows = [
        {"ts": message.ts, "user": message.user, "text": "<@UBOT> séance ?"},
        {
            "ts": "1700000001.000001",
            "app_id": message.app_id,
            "bot_id": "B1",
            "text": "Repos.",
        },
        {"ts": reply.ts, "user": reply.user, "text": reply.text},
    ]

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json={"ok": True, "messages": rows})
            )
        ) as http:
            return await slack.SlackClient(http).history(reply)

    history = asyncio.run(run())
    assert history[0]["content"] == "[Autre participant <@U123>] <@UBOT> séance ?"
    assert history[-1] == {"role": "user", "content": "Et moi ?"}


@pytest.mark.parametrize("public", [False, True])
def test_channel_answer_is_public_only_with_consent(ledger, message, public):
    from arete.services import slack_athletes

    slack_athletes.set_public_replies(public)
    mention = replace(message, channel="C123", in_channel=True, mentioned=True)
    client = mock_slack_client()
    client.history.return_value = [{"role": "user", "content": mention.text}]
    client.open_dm.return_value = "D777"
    produce = AsyncMock(return_value="Repos.")
    asyncio.run(slack.dispatch(mention, client=client, produce=produce))
    visibility = "public" if public else "private"
    produce.assert_awaited_once_with(
        client.history.return_value, mention.thread_id, visibility, ANY
    )
    if public:
        assert final_update(client)["channel"] == mention.channel
        client.reply.assert_not_awaited()
        client.post.assert_not_awaited()
    else:
        client.post.assert_awaited_once_with(
            "D777", None, "Ta demande dans un canal :\n" + mention.text
        )
        assert final_update(client)["channel"] == "D777"
        client.reply.assert_awaited_once_with(
            mention, slack.PRIVATE_NOTE.format(user=mention.user)
        )


def test_one_athlete_busy_never_blocks_another(ledger, message):
    from arete.services.athlete_scope import athlete_scope

    with athlete_scope(1):
        assert slack.reserve(message) == "running"
        assert slack.reserve(replace(message, event_id="Ev2")) == "busy"
    with athlete_scope(2):
        assert slack.reserve(replace(message, event_id="Ev3")) == "running"


def test_preferences_are_per_athlete_and_off_by_default(
    ledger, router_client, configured
):
    from arete.services import slack_athletes
    from arete.services.athlete_scope import athlete_scope

    client = router_client(api.router)
    assert client.get("/slack/preferences").json() == {
        "available": True,
        "public_replies": False,
    }
    assert client.put("/slack/preferences", json={"public_replies": True}).json()[
        "public_replies"
    ]
    assert client.get("/slack/preferences").json()["public_replies"] is True
    with athlete_scope(2):
        assert slack_athletes.public_replies() is False


def test_surface_section_tells_the_coach_who_reads():
    from arete.agent.context.sections import surface_section
    from arete.agent.runtime.context import AgentContext

    assert surface_section(AgentContext()) == ""
    assert "tous ses membres" in surface_section(
        AgentContext(slack_visibility="public")
    )
    private = surface_section(AgentContext(slack_visibility="private"))
    assert "seul l’athlète" in private and "Autre participant" in private


def test_top_level_channel_chatter_costs_no_slack_call(ledger, message):
    client = mock_slack_client()
    chatter = replace(message, in_channel=True)
    assert asyncio.run(slack.resolve(chatter, client=client)) is None
    client.engaged.assert_not_awaited()
    client.author_email.assert_not_awaited()


def test_tool_progress_and_logo_reaction_without_placeholder(ledger, message):
    requests = []

    def respond(request):
        requests.append(
            (request.url.path.rsplit("/", 1)[-1], json.loads(request.content))
        )
        return httpx.Response(200, json={"ok": True, "ts": "1700000001.000001"})

    async def produce(history, thread_id, visibility, emit):
        await emit(
            {
                "type": "tool_start",
                "id": "tool-1",
                "name": "list_planned",
                "args": {"text": "PRIVATE_ARGUMENTS"},
            }
        )
        await emit(
            {
                "type": "tool_end",
                "id": "tool-1",
                "name": "list_planned",
                "status": "done",
                "output": {"text": "PRIVATE_RESULT"},
            }
        )
        await emit(
            {"type": "token", "id": "failed-model", "text": "Wrong provisional answer"}
        )
        await emit({"type": "token", "id": "valid-model", "text": "**Repos** <@U999>"})
        return "**Repos** <@U999>"

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            await slack.dispatch(
                message, client=slack.SlackClient(http), produce=produce
            )

    asyncio.run(run())
    methods = [method for method, _ in requests]
    assert methods == [
        "agents.sessions.setStatus",
        "reactions.add",
        "chat.startStream",
        "chat.stopStream",
        "chat.update",
        "agents.sessions.setStatus",
    ]
    assert requests[1][1] == {
        "channel": message.channel,
        "timestamp": message.ts,
        "name": "image-5",
    }
    assert requests[0][1]["status"] == "processing"
    assert requests[-1][1]["status"] == "active"
    start = requests[2][1]
    assert start["thread_ts"] == message.thread_ts
    assert start["recipient_team_id"] == message.team
    assert start["recipient_user_id"] == message.user
    assert start["chunks"] == [
        {"type": "plan_update", "title": "Analyse en cours"},
        {
            "type": "task_update",
            "id": "task-1",
            "title": "Lecture du planning",
            "status": "in_progress",
        },
    ]
    assert "⏳" not in str(requests)
    assert "Arete travaille" not in str(requests)
    assert "arete_pending" not in str(requests)
    update = requests[-2][1]
    assert update["text"] == "**Repos** <@U999>"
    assert update["blocks"] == [{"type": "markdown", "text": "**Repos** &lt;@U999&gt;"}]
    assert update["link_names"] is False
    assert "PRIVATE_" not in json.dumps(requests)
    assert "Wrong provisional answer" not in json.dumps(update)


@pytest.mark.parametrize(
    "method",
    [
        "agents.sessions.setStatus",
        "chat.startStream",
        "chat.appendStream",
        "chat.stopStream",
        "chat.update",
    ],
)
def test_stream_failures_are_not_replayed_and_clear_status(
    ledger, message, method, monkeypatch
):
    monkeypatch.setattr(slack, "STREAM_FLUSH_SECONDS", 0)
    client = mock_slack_client()
    failed = False

    async def call(name, payload):
        nonlocal failed
        if name == method and not failed:
            failed = True
            raise slack.SlackError("uncertain network outcome")
        return {"ok": True, "ts": "1700000001.000001"}

    client.call.side_effect = call

    async def produce(*args):
        await args[-1]({"type": "token", "id": "answer", "text": "Bon"})
        await args[-1]({"type": "token", "id": "answer", "text": "jour"})
        return "Bonjour"

    producer = AsyncMock(side_effect=produce)
    with pytest.raises(slack.SlackError, match="uncertain"):
        asyncio.run(slack.dispatch(message, client=client, produce=producer))
    asyncio.run(slack.dispatch(message, client=client, produce=producer))
    calls = client.call.await_args_list
    assert calls[-1].args == (
        "agents.sessions.setStatus",
        {
            "channel_id": message.channel,
            "thread_ts": message.thread_ts,
            "status": "active",
        },
    )
    assert producer.await_count == (0 if method == "agents.sessions.setStatus" else 1)
    if method != "agents.sessions.setStatus":
        assert sum(c.args[0] == method for c in calls) == 1
    client.reply.assert_not_awaited()
    assert slack.reserve(replace(message, event_id="Ev2")) == (
        "busy" if method in ("chat.startStream", "chat.appendStream") else "running"
    )


def test_stream_clears_status_before_releasing_admission(ledger, message):
    client = mock_slack_client()

    async def call(method, payload):
        if method == "agents.sessions.setStatus" and payload["status"] == "active":
            assert slack.reserve(replace(message, event_id="Ev2")) == "busy"
        return {"ok": True, "ts": "1700000001.000001"}

    client.call.side_effect = call
    asyncio.run(
        slack.dispatch(message, client=client, produce=AsyncMock(return_value="Repos."))
    )
    assert slack.reserve(replace(message, event_id="Ev3")) == "running"


@pytest.mark.parametrize("field", ["text", "blocks"])
def test_provisional_stream_is_never_used_as_history(message, field):
    reply = replace(message, ts="1700000002.000001")
    provisional = {
        "ts": "1700000001.000001",
        "app_id": message.app_id,
        "bot_id": "B123",
        "text": "Incomplete answer",
    }
    provisional[field] = (
        slack.PENDING_ANSWER
        if field == "text"
        else [{"type": "context", "block_id": "arete_pending"}]
    )
    rows = [
        {"ts": message.ts, "user": message.user, "text": message.text},
        provisional,
        {"ts": reply.ts, "user": reply.user, "text": reply.text},
    ]

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json={"ok": True, "messages": rows})
            )
        ) as http:
            await slack.SlackClient(http).history(reply)

    with pytest.raises(slack.HistoryError, match="interrompue"):
        asyncio.run(run())


def test_long_final_answer_is_preserved_without_markdown_truncation(message):
    client = mock_slack_client()
    output = slack.SlackStream(client, message)
    answer = "x" * slack.MAX_REPLY_CHARS

    async def run():
        await output.start()
        await output.finish(answer)

    asyncio.run(run())
    assert final_update(client)["text"] == answer
    assert final_update(client)["blocks"] == []


@pytest.mark.parametrize(
    "limit", ["MAX_STREAM_CHARS", "MAX_STREAM_APPENDS", "MAX_TASKS"]
)
def test_stream_limits_fail_explicitly(message, monkeypatch, limit):
    monkeypatch.setattr(slack, limit, 0)
    output = slack.SlackStream(mock_slack_client(), message)
    event = (
        {"type": "tool_start", "id": "tool-1", "name": "list_planned"}
        if limit == "MAX_TASKS"
        else {"type": "token", "id": "answer", "text": "Bonjour"}
    )

    async def run():
        await output.start()
        await output.emit(event)

    with pytest.raises(slack.SlackError, match="budget"):
        asyncio.run(run())


def test_slack_tokens_without_completed_answer_fail_and_close_stream(monkeypatch):
    from langchain_core.messages import AIMessageChunk

    from arete import coaching
    from arete.agent.runtime import execution

    closed = []

    async def stream(*args, **kwargs):
        try:
            yield {
                "type": "messages",
                "data": (
                    AIMessageChunk(content="Unvalidated", id="m1"),
                    {"langgraph_node": "model"},
                ),
            }
        finally:
            closed.append(True)

    monkeypatch.setattr(coaching, "get_agent", lambda: object())
    monkeypatch.setattr(execution, "stream_agent", stream)
    with pytest.raises(RuntimeError, match="empty Slack answer"):
        asyncio.run(coaching.run_slack_coach([], "slack:T:D:1", "private", AsyncMock()))
    assert closed == [True]


def test_waiting_shows_only_native_status(message):
    client = mock_slack_client()
    output = slack.SlackStream(client, message)

    async def run():
        await output.start()

    asyncio.run(run())
    client.call.assert_awaited_once_with(
        "agents.sessions.setStatus",
        {
            "channel_id": message.channel,
            "thread_ts": message.thread_ts,
            "status": "processing",
        },
    )
    assert not output.ts


@pytest.mark.parametrize(
    "error", ["already_reacted", "invalid_name", "missing_scope", "timeout"]
)
def test_logo_reaction_failure_never_blocks_coaching(ledger, message, error, caplog):
    methods = []

    def respond(request):
        method = request.url.path.rsplit("/", 1)[-1]
        methods.append(method)
        if method == "reactions.add":
            if error == "timeout":
                raise httpx.ReadTimeout("uncertain reaction")
            return httpx.Response(200, json={"ok": False, "error": error})
        return httpx.Response(200, json={"ok": True, "ts": "1700000001.000001"})

    producer = AsyncMock(return_value="Repos.")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            await slack.dispatch(
                message, client=slack.SlackClient(http), produce=producer
            )
            await slack.dispatch(
                message, client=slack.SlackClient(http), produce=producer
            )

    asyncio.run(run())
    assert methods.count("reactions.add") == 1
    assert methods.count("chat.postMessage") == 1
    assert producer.await_count == 1
    assert ("reaction" in caplog.text) == (error != "already_reacted")


def test_logo_reaction_targets_user_reply_not_thread_root(ledger, message):
    reply = replace(message, ts="1700000002.000001")
    client = mock_slack_client()
    asyncio.run(
        slack.dispatch(reply, client=client, produce=AsyncMock(return_value="Repos."))
    )
    client.react.assert_awaited_once_with(reply)
    requests = []

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: (
                    requests.append(json.loads(req.content))
                    or httpx.Response(200, json={"ok": True})
                )
            )
        ) as http:
            await slack.SlackClient(http).react(reply)

    asyncio.run(run())
    assert requests == [
        {"channel": message.channel, "timestamp": reply.ts, "name": "image-5"}
    ]


@pytest.mark.parametrize("status", ["running", "failed"])
def test_incomplete_delivery_rejects_unmarked_history(ledger, message, status):
    slack.reserve(message)
    if status == "failed":
        slack.finish(message, "failed", release=True)
    reply = replace(message, event_id="Ev2", ts="1700000002.000001")

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: pytest.fail("Incomplete history must not reach Slack")
            )
        ) as http:
            await slack.SlackClient(http).history(reply)

    with pytest.raises(slack.HistoryError, match="interrompue ou en cours"):
        asyncio.run(run())


def test_successful_and_current_deliveries_do_not_block_thread(ledger, message):
    slack.reserve(message)
    slack.check_thread_delivery(message)
    slack.finish(message, "sent", release=True)
    reply = replace(message, event_id="Ev2", ts="1700000002.000001")
    slack.reserve(reply)
    slack.check_thread_delivery(reply)


def test_private_output_records_destination_before_stream(ledger, message):
    client = mock_slack_client()
    client.open_dm.return_value = "D777"
    mention = replace(message, channel="C123", in_channel=True, mentioned=True)

    async def produce(*args):
        with db_connection() as con:
            assert con.execute(
                "SELECT thread_id FROM app.slack_deliveries WHERE event_key = ?",
                [message.key],
            ).fetchone() == ("slack:T123:D777:1700000001.000001",)
        raise RuntimeError("interrupted")

    with pytest.raises(RuntimeError, match="interrupted"):
        asyncio.run(slack.dispatch(mention, client=client, produce=produce))
    client.react.assert_awaited_once_with(mention)
    followup = replace(
        message,
        event_id="Ev2",
        channel="D777",
        thread_ts="1700000001.000001",
        ts="1700000002.000001",
    )
    with pytest.raises(slack.HistoryError, match="interrompue"):
        slack.check_thread_delivery(followup)


def test_delivery_thread_migration_preserves_existing_records(ledger, message):
    slack.reserve(message)
    slack.finish(message, "sent", release=True)
    with db_connection() as con:
        con.execute("ALTER TABLE app.slack_deliveries DROP COLUMN thread_id")
        con.execute("DELETE FROM app.schema_version WHERE version = 42")
    init_db()
    with db_connection() as con:
        assert con.execute(
            "SELECT event_key, status, thread_id FROM app.slack_deliveries"
        ).fetchone() == (message.key, "sent", None)
    assert slack.reserve(replace(message, event_id="Ev2")) == "running"
