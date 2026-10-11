"""Product routing, private reads and external writes at the trust boundaries."""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from langchain_core.messages import AIMessage

from arete.agent.runtime.context import AgentContext
from arete.agent.runtime.surface import SurfaceDecision, detect_surface
from arete.dataio.db import db_connection
from arete.dataio.init_duckdb import main as init_db
from arete.services import admin_athlete_data, slack, slack_identity, users
from arete.services.athlete_scope import athlete_scope, current_athlete_id
from arete.services.slack_product import SlackProduct, schedule_time


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "product.duckdb"))
    monkeypatch.setenv("ARETE_OWNER_EMAIL", "owner@example.com")
    init_db()
    admin = users.upsert_user("admin", "admin@example.com", verified=True)
    admin = users.set_role(admin.id, "admin")
    other = users.upsert_user("other", "other@example.com", verified=True)
    slack_identity.link("T123", "UADMIN", admin.email, "Europe/Paris")
    client = AsyncMock(spec=slack.SlackClient)
    client.open_dm.return_value = "DPRIVATE"
    client.post.return_value = "100.000001"

    async def call(method, payload):
        if method == "users.info":
            return {
                "ok": True,
                "user": {
                    "id": payload["user"],
                    "team_id": "T123",
                    "name": "Arthur",
                    "profile": {"display_name": "Arthur"},
                },
            }
        if method == "conversations.members":
            return {"ok": True, "members": ["UADMIN", "UTARGET"]}
        return {"ok": True, "ts": "200.000001", "scheduled_message_id": "Q123"}

    client.call.side_effect = call
    message = slack.SlackMessage(
        "T123",
        "EV1",
        "A123",
        "C123",
        "UADMIN",
        "1.000001",
        "1.000001",
        "Ping <@UTARGET> pour ses tickets front",
        in_channel=True,
        mentioned=True,
    )
    return (
        admin,
        other,
        SlackProduct(client, message, admin.clerk_user_id, "Europe/Paris"),
    )


def model_for(text, **metadata):
    return SimpleNamespace(
        extra_body={"provider": {"max_price": {"prompt": 0}}},
        model_name="fake",
        ainvoke=AsyncMock(
            return_value=AIMessage(content=text, response_metadata=metadata)
        ),
    )


@pytest.mark.parametrize(
    "surface,private,outbound",
    [
        ("coach", False, False),
        ("product", False, True),
        ("product", True, False),
        ("clarify", False, False),
    ],
)
def test_classifier_typed_and_measured(surface, private, outbound):
    model = model_for(
        json.dumps({"surface": surface, "private_data": private, "outbound": outbound})
    )
    context = AgentContext(thread_id="thread")
    decision = asyncio.run(
        detect_surface(model, [{"role": "user", "content": "Question"}], context, 8192)
    )
    assert decision.surface == surface
    assert context.stats.model_calls == 1
    assert model.ainvoke.await_count == 1
    assert (
        model.ainvoke.call_args.kwargs["extra_body"]["provider"]
        == model.extra_body["provider"]
    )
    assert "session_id" not in model.extra_body


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        '{"surface":"root","private_data":false,"outbound":false}',
        '{"surface":"coach","private_data":true,"outbound":false}',
        '{"surface":"product","private_data":false,"outbound":false,"tools":["delete"]}',
    ],
)
def test_classifier_invalid_fails_once(content):
    model = model_for(content)
    context = AgentContext()
    with pytest.raises(ValueError):
        asyncio.run(detect_surface(model, [], context, 8192))
    assert context.stats.model_calls == 1
    assert model.ainvoke.await_count == 1


def test_classifier_mixed_request_clarifies():
    assert (
        SurfaceDecision(surface="product", private_data=True, outbound=True).surface
        == "clarify"
    )


def test_classifier_timeout_and_truncation(monkeypatch):
    from arete.agent.models.responses import TruncatedModelResponseError
    from arete.agent.runtime import surface

    context = AgentContext()
    with pytest.raises(TruncatedModelResponseError):
        asyncio.run(
            detect_surface(
                model_for(
                    '{"surface":"coach","private_data":false,"outbound":false}',
                    finish_reason="length",
                ),
                [],
                context,
                8192,
            )
        )
    model = model_for("")

    async def slow(*args, **kwargs):
        await asyncio.sleep(1)

    model.ainvoke.side_effect = slow
    monkeypatch.setattr(surface, "CLASSIFIER_TIMEOUT", 0.001)
    with pytest.raises(TimeoutError):
        asyncio.run(detect_surface(model, [], context, 8192))
    assert context.stats.model_calls == 2


def test_classifier_oversized_history_never_calls_provider():
    model = model_for("")
    with pytest.raises(ValueError, match="volumineux"):
        asyncio.run(
            detect_surface(
                model, [{"role": "user", "content": "x" * 40000}], AgentContext(), 8192
            )
        )
    model.ainvoke.assert_not_called()


def test_ping_mentions_only_validated_target_and_deduplicates(setup):
    _, _, service = setup

    async def run():
        results = await asyncio.gather(
            service.send("UTARGET", "faire <@UOTHER> <!channel>"),
            service.send("UTARGET", "faire <@UOTHER> <!channel>"),
        )
        assert all(r["status"] == "sent" for r in results)

    asyncio.run(run())
    writes = [
        c for c in service.client.call.call_args_list if c.args[0] == "chat.postMessage"
    ]
    assert len(writes) == 1
    payload = writes[0].args[1]
    assert payload["thread_ts"] == service.message.thread_ts
    assert payload["text"].count("<@") == 1
    assert "<!channel>" not in payload["text"]
    assert "&lt;!channel&gt;" in payload["text"]


def test_external_timeout_records_uncertain_never_replays(setup):
    _, _, service = setup
    original = service.client.call.side_effect

    async def call(method, payload):
        if method == "chat.postMessage":
            with db_connection() as con:
                assert con.execute(
                    "SELECT status FROM app.slack_operations"
                ).fetchone() == ("uncertain",)
            raise httpx.ReadTimeout("unknown")
        return await original(method, payload)

    service.client.call.side_effect = call

    async def run():
        with pytest.raises(httpx.ReadTimeout):
            await service.send("UTARGET", "tickets")
        assert (await service.send("UTARGET", "tickets"))["status"] == "uncertain"

    asyncio.run(run())
    assert (
        sum(c.args[0] == "chat.postMessage" for c in service.client.call.call_args_list)
        == 1
    )


def test_limits_and_private_read_context_block_writes(setup):
    _, _, service = setup

    async def run():
        service.private = True
        with pytest.raises(PermissionError):
            await service.send("UTARGET", "secret")
        service.private = False
        for i in range(5):
            await service.send("UTARGET", str(i))
        with pytest.raises(ValueError, match="cinq"):
            await service.send("UTARGET", "six")

    asyncio.run(run())
    assert (
        sum(c.args[0] == "chat.postMessage" for c in service.client.call.call_args_list)
        == 5
    )


def test_revocation_and_identity_ambiguity_deny(setup):
    admin, _, service = setup
    users.set_role(admin.id, "athlete")
    with pytest.raises(PermissionError):
        asyncio.run(service.send("UTARGET", "tickets"))
    service.client.call.assert_not_called()
    users.set_role(admin.id, "admin")
    users.upsert_user("duplicate", admin.email, verified=True)
    assert slack_identity.identity("T123", "UADMIN") is None


def test_nonmember_needs_explicit_dm(setup):
    _, _, service = setup
    original = service.client.call.side_effect

    async def call(method, payload):
        return (
            {"members": []}
            if method == "conversations.members"
            else await original(method, payload)
        )

    service.client.call.side_effect = call

    async def run():
        with pytest.raises(ValueError, match="pas dans ce canal"):
            await service.send("UTARGET", "tickets")
        with pytest.raises(ValueError, match="explicitement"):
            await service.send("UTARGET", "tickets", dm=True)
        service.message = replace(service.message, text="Ping <@UTARGET> en DM")
        assert (await service.send("UTARGET", "tickets", dm=True))[
            "channel"
        ] == "DPRIVATE"

    asyncio.run(run())


def test_schedule_cancel_and_no_metadata(setup):
    _, _, service = setup
    at = (
        (datetime.now(UTC) + timedelta(days=1))
        .astimezone(__import__("zoneinfo").ZoneInfo("Europe/Paris"))
        .isoformat()
    )

    async def run():
        sent = await service.send("UTARGET", "tickets", at=at)
        assert sent["status"] == "scheduled"
        assert (await service.reminders())["reminders"][0]["id"] == sent["id"]
        assert (await service.cancel(sent["id"]))["status"] == "cancelled"
        assert (await service.cancel(sent["id"]))["status"] == "cancelled"

    asyncio.run(run())
    payload = next(
        c.args[1]
        for c in service.client.call.call_args_list
        if c.args[0] == "chat.scheduleMessage"
    )
    assert "metadata" not in payload
    assert payload["thread_ts"] == service.message.thread_ts
    assert (
        sum(
            c.args[0] == "chat.deleteScheduledMessage"
            for c in service.client.call.call_args_list
        )
        == 1
    )


@pytest.mark.parametrize(
    "value",
    [
        "2026-10-20",
        "2026-10-25T02:30",
        "2026-03-29T02:30",
        "2025-01-01T10:00",
        "2027-12-01T10:00",
    ],
)
def test_schedule_requires_unambiguous_future_hour(value):
    with pytest.raises(ValueError):
        schedule_time(value, "Europe/Paris", now=datetime(2026, 10, 1, tzinfo=UTC))


def test_explicit_dst_offset_is_accepted():
    now = datetime(2026, 10, 1, tzinfo=UTC)
    first = schedule_time("2026-10-25T02:30+02:00", "Europe/Paris", now=now)
    second = schedule_time("2026-10-25T02:30+01:00", "Europe/Paris", now=now)
    assert second - first == 3600


def test_private_reads_restore_scope_and_recheck_revocation(setup):
    admin, other, service = setup
    from arete.services.athlete_facts import add_fact

    with athlete_scope(other.athlete_id):
        add_fact("preference", "private-other")
    with athlete_scope(admin.athlete_id):
        result = admin_athlete_data.read(
            "T123", "UADMIN", admin.clerk_user_id, other.athlete_id, "facts"
        )
        assert result["facts"][0]["text"] == "private-other"
        assert current_athlete_id() == admin.athlete_id
    users.set_role(admin.id, "athlete")
    with pytest.raises(PermissionError):
        admin_athlete_data.read(
            "T123", "UADMIN", admin.clerk_user_id, other.athlete_id, "facts"
        )


def test_profiles_exclude_training_and_private_public_tools():
    from arete.agent.capabilities.discovery import authorized_tools
    from arete.agent.profiles.catalog import get_profile

    product = {t.name for t in authorized_tools("product")}
    private = {t.name for t in authorized_tools("admin_data")}
    assert "ping_slack_member" in product
    assert "read_athlete_data" not in product
    assert private == {"list_athlete_accounts", "read_athlete_data"}
    assert not get_profile("product").personal_context
    assert not get_profile("admin_data").training_writes
    for t in authorized_tools("product") + authorized_tools("admin_data"):
        assert "runtime" not in t.tool_call_schema["properties"]


def test_private_dispatch_moves_before_producer_and_deduplicates(setup):
    admin, _, service = setup
    seen = []

    async def produce(history, thread, visibility, emit):
        seen.append(visibility)
        assert visibility == "private"
        assert (
            slack_identity.private_owner("slack:T123:DPRIVATE:100.000001")
            == admin.clerk_user_id
        )
        await emit({"type": "token", "text": "secret", "id": "m1"})
        return "secret"

    prepare = AsyncMock(
        return_value=slack.SlackPreparation(
            produce, product=True, private=True, account_id=admin.clerk_user_id
        )
    )
    service.client.history.return_value = [
        {"role": "user", "content": "Lire les données"}
    ]

    async def run():
        await slack.dispatch(
            service.message, client=service.client, produce=produce, prepare=prepare
        )
        await slack.dispatch(
            service.message, client=service.client, produce=produce, prepare=prepare
        )

    with athlete_scope(admin.athlete_id):
        asyncio.run(run())
    assert seen == ["private"]
    assert prepare.await_count == 1
    for call in service.client.call.call_args_list:
        payload = call.args[1]
        if "secret" in json.dumps(payload):
            assert payload.get("channel") == "DPRIVATE"


def test_product_graph_executes_native_tool_without_personal_context(
    setup, monkeypatch
):
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import HumanMessage

    from arete.agent.context import builder
    from arete.agent.middlewares import limits

    monkeypatch.setattr(limits, "MAX_MODEL_CALLS", 3)
    monkeypatch.setattr(builder, "MAX_MODEL_CALLS", 3)
    from arete.agent.factory import build_agent
    from arete.agent.profiles.catalog import get_profile
    from arete.agent.runtime.execution import invoke_agent

    admin, _, service = setup

    def forbidden(*args):
        raise AssertionError("Product graph read coaching data")

    for name in (
        "facts_block",
        "journal_block",
        "followup_block",
        "search_personal_context",
    ):
        monkeypatch.setattr(builder, name, forbidden)
    captured = []

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            captured.append(messages)
            return super()._generate(
                messages, stop=stop, run_manager=run_manager, **kwargs
            )

    model = Model(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "ping_slack_member",
                            "args": {"target": "UTARGET", "text": "tickets"},
                            "id": "ping",
                        }
                    ],
                ),
                AIMessage(content="Arthur a été mentionné."),
            ]
        )
    )
    graph = build_agent(
        get_profile("product"),
        model=model,
        filesystem=AgentMiddleware(),
        context_tokens=65536,
        output_tokens=4096,
    )
    context = AgentContext(
        profile="product", slack_visibility="public", slack_product=service
    )
    context.stats.model_calls = 1
    context.classifier_calls = 1
    with athlete_scope(admin.athlete_id):
        result = asyncio.run(
            invoke_agent(
                graph,
                {"messages": [HumanMessage("Ping Arthur")], "run_model_call_count": 1},
                context=context,
            )
        )
    assert "Dernier appel du budget" in captured[-1][0].text
    assert context.stats.model_calls == 3
    tools = [m for m in result["messages"] if m.type == "tool"]
    assert len(tools) == 1 and tools[0].status == "success"
    assert json.loads(tools[0].content)["status"] == "sent"
    assert "Chiron" not in captured[0][0].text


@pytest.mark.parametrize(
    "route,private,expected",
    [
        ("coach", False, "chat"),
        ("product", False, "product"),
        ("product", True, "admin_data"),
    ],
)
def test_composition_selects_route_and_keeps_classifier_budget(
    setup, monkeypatch, route, private, expected
):
    from arete import coaching
    from arete.agent.runtime import execution

    admin, _, service = setup
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    model = model_for(
        json.dumps({"surface": route, "private_data": private, "outbound": False})
    )
    calls = []
    monkeypatch.setattr(
        coaching, "build_chat_model", lambda **kwargs: (calls.append(kwargs) or model)
    )
    graph_calls = []
    monkeypatch.setattr(
        coaching, "_slack_graph", lambda *args: (graph_calls.append(args) or object())
    )
    captured = {}

    async def stream(graph, state, *, context):
        captured.update(state=state, context=context)
        yield {
            "type": "updates",
            "data": {"model": {"messages": [AIMessage(content="Fait.")]}},
        }

    monkeypatch.setattr(execution, "stream_agent", stream)

    async def run():
        prepared = await coaching.prepare_slack_agent(
            [{"role": "user", "content": "question"}], service.message, service.client
        )
        assert prepared.private == private
        await prepared.produce(
            [], "thread", "private" if private else "public", AsyncMock()
        )
        prepared.finalize()

    with athlete_scope(admin.athlete_id):
        asyncio.run(run())
    assert calls[0]["max_retries"] == 0 and calls[0]["route"].fallbacks == ()
    assert (
        calls[0]["timeout"] == 15
        and calls[0]["max_tokens"] == 1024
        and calls[0]["temperature"] == 0
    )
    assert graph_calls[0][1] == expected
    assert captured["context"].classifier_calls == 1
    assert captured["context"].profile == expected


def test_nonadmin_has_no_classifier_and_revoked_private_thread_is_denied(
    setup, monkeypatch
):
    from arete import coaching

    admin, other, service = setup
    model = AsyncMock()
    monkeypatch.setattr(coaching, "build_chat_model", model)
    slack_identity.link("T123", "UOTHER", other.email, "Europe/Paris")
    message = replace(service.message, user="UOTHER")
    asyncio.run(coaching.prepare_slack_agent([], message, service.client))
    model.assert_not_called()
    slack_identity.mark_private(service.message.thread_id, admin.clerk_user_id)
    users.set_role(admin.id, "athlete")
    with pytest.raises(slack.HistoryError):
        asyncio.run(coaching.prepare_slack_agent([], service.message, service.client))
    model.assert_not_called()


def test_private_thread_cannot_regain_outbound_tools(setup, monkeypatch):
    from arete import coaching

    admin, _, service = setup
    service.message = replace(service.message, in_channel=False, channel="DADMIN")
    slack_identity.mark_private(service.message.thread_id, admin.clerk_user_id)
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    monkeypatch.setattr(
        coaching,
        "build_chat_model",
        lambda **kw: model_for(
            '{"surface":"product","private_data":false,"outbound":true}'
        ),
    )
    assemble = AsyncMock()
    monkeypatch.setattr(coaching, "_slack_graph", assemble)

    async def run():
        p = await coaching.prepare_slack_agent([], service.message, service.client)
        assert p.private
        assert "deux fils" in await p.produce([], "", "private", AsyncMock())

    with athlete_scope(admin.athlete_id):
        asyncio.run(run())
    assemble.assert_not_called()


def test_directory_members_without_accounts_ambiguity_and_page_bound(setup):
    _, _, service = setup
    service.client.call.side_effect = None
    service.client.call.return_value = {
        "members": [
            {"id": u, "team_id": "T123", "name": "Arthur"} for u in ("UA", "UB")
        ]
    }
    assert asyncio.run(service.search("Arthur"))["ambiguous"]
    service.client.call.return_value = {
        "members": [],
        "response_metadata": {"next_cursor": "more"},
    }
    service.client.call.reset_mock()
    with pytest.raises(slack.SlackError, match="volumineux"):
        asyncio.run(service.search("Arthur"))
    assert service.client.call.await_count == 10


def test_cancel_failure_never_replays(setup):
    _, _, service = setup
    from zoneinfo import ZoneInfo

    at = (datetime.now(ZoneInfo("Europe/Paris")) + timedelta(days=1)).isoformat()
    original = service.client.call.side_effect

    async def call(method, payload):
        if method == "chat.deleteScheduledMessage":
            raise httpx.ReadTimeout("uncertain cancellation")
        return await original(method, payload)

    service.client.call.side_effect = call

    async def run():
        sent = await service.send("UTARGET", "tickets", at=at)
        with pytest.raises(httpx.ReadTimeout):
            await service.cancel(sent["id"])
        with pytest.raises(ValueError, match="incertain"):
            await service.cancel(sent["id"])
        assert (await service.reminders())["reminders"][0][
            "status"
        ] == "cancel_uncertain"

    asyncio.run(run())
    assert (
        sum(
            c.args[0] == "chat.deleteScheduledMessage"
            for c in service.client.call.call_args_list
        )
        == 1
    )


def test_concurrent_admin_reads_keep_targets_isolated(setup):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from arete.services.athlete_facts import add_fact

    admin, first, _ = setup
    second = users.upsert_user("second", "second@example.com", verified=True)
    for account in (first, second):
        with athlete_scope(account.athlete_id):
            add_fact("preference", account.email)
    barrier = Barrier(2, timeout=5)

    def read_target(account):
        with athlete_scope(admin.athlete_id):
            barrier.wait()
            result = admin_athlete_data.read(
                "T123", "UADMIN", admin.clerk_user_id, account.athlete_id, "facts"
            )
            assert current_athlete_id() == admin.athlete_id
            return result["facts"][0]["text"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(read_target, (first, second))) == [
            first.email,
            second.email,
        ]


def test_private_documents_are_scoped_and_unextracted_documents_report_error(setup):
    import hashlib
    from uuid import uuid4

    from arete.services import documents

    admin, other, _ = setup
    thread = str(uuid4())
    with athlete_scope(other.athlete_id):
        doc = documents.begin_upload(
            thread, "private.txt", 3, hashlib.sha256(b"abc").hexdigest()
        )
    listed = admin_athlete_data.read(
        "T123", "UADMIN", admin.clerk_user_id, other.athlete_id, "documents"
    )
    assert listed["documents"][0]["name"] == "private.txt"
    with pytest.raises(documents.DocumentError, match="prêt"):
        admin_athlete_data.read(
            "T123",
            "UADMIN",
            admin.clerk_user_id,
            other.athlete_id,
            "document",
            resource=doc["id"],
            thread_id=thread,
        )
    with pytest.raises(documents.DocumentError, match="introuvable"):
        admin_athlete_data.read(
            "T123",
            "UADMIN",
            admin.clerk_user_id,
            admin.athlete_id,
            "document",
            resource=doc["id"],
            thread_id=thread,
        )


def test_cancellation_in_final_minute_does_not_call_slack(setup):
    from zoneinfo import ZoneInfo

    _, _, service = setup
    at = (datetime.now(ZoneInfo("Europe/Paris")) + timedelta(seconds=30)).isoformat()

    async def run():
        sent = await service.send("UTARGET", "tickets", at=at)
        with pytest.raises(ValueError, match="60 dernières"):
            await service.cancel(sent["id"])

    asyncio.run(run())
    assert not any(
        c.args[0] == "chat.deleteScheduledMessage"
        for c in service.client.call.call_args_list
    )


def test_failed_classifier_is_reported_and_releases_admission(setup, monkeypatch):
    from arete import coaching

    admin, _, service = setup
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    model = model_for("invalid")
    monkeypatch.setattr(coaching, "build_chat_model", lambda **kw: model)
    service.client.history.return_value = [{"role": "user", "content": "Ping Arthur"}]
    produce = AsyncMock()
    with athlete_scope(admin.athlete_id):
        asyncio.run(
            slack.dispatch(
                service.message,
                client=service.client,
                produce=produce,
                prepare=coaching.prepare_slack_agent,
            )
        )
        assert slack.reserve(replace(service.message, event_id="EV2")) == "running"
    produce.assert_not_called()
    assert model.ainvoke.await_count == 1
    assert "aucune action" in service.client.reply.call_args.args[1]
    assert not service.client.call.called
