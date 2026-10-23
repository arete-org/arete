"""Archive lifecycle, tenant isolation and title work independent of streaming."""

import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
from agent_clock import CLOCK
from langchain_core.messages import AIMessage, HumanMessage

from arete.dataio.db import db_connection
from arete.services import conversations as store
from arete.services.athlete_scope import athlete_scope


@pytest.fixture(autouse=True)
def archives():
    with db_connection() as con:
        con.execute("DELETE FROM app.coach_conversations")
    yield


def snapshot(**changes):
    return store.Snapshot.model_validate(
        {
            "revision": 0,
            "write_id": "a" * 64,
            "title": "Hyrox",
            "messages": [
                {
                    "role": "user",
                    "content": "Hyrox après le footing",
                    "sentAt": "2026-10-17T16:19:00+02:00",
                }
            ],
            "created_at": 1,
            "updated_at": 2,
            **changes,
        }
    )


def test_idempotency_revision_and_deletion_prevent_resurrection():
    ident = str(uuid4())
    first = store.save(ident, snapshot())
    assert first["revision"] == 1
    assert store.save(ident, snapshot()) == first
    with pytest.raises(store.ConversationConflict):
        store.save(ident, snapshot(write_id="b" * 64))
    assert store.read(ident)["messages"][0]["sentAt"].endswith("+02:00")
    assert store.search("HYROX")["items"][0]["id"] == ident
    store.delete(ident)
    assert not store.search("Hyrox")["items"]
    with pytest.raises(store.ConversationConflict):
        store.save(ident, snapshot(revision=1, write_id="b" * 64))
    assert not store.set_title(ident, "Late title")
    never_saved = str(uuid4())
    store.delete(never_saved)
    with pytest.raises(store.ConversationConflict):
        store.save(never_saved, snapshot())


def test_private_scope_and_literal_search():
    ident = str(uuid4())
    store.save(ident, snapshot())
    with db_connection() as con:
        con.execute(
            "INSERT INTO app.athletes (id) VALUES (9876) ON CONFLICT DO NOTHING"
        )
    with athlete_scope(9876):
        assert not store.search("Hyrox")["items"]
        with pytest.raises(store.ConversationError):
            store.read(ident)
        assert not store.set_title(ident, "stolen", manual=True)
        store.delete(ident)
    assert store.read(ident)["title"] == "Hyrox"
    assert not store.search("%")["items"]
    assert not store.search("' OR 1=1 --")["items"]


def test_pagination_and_incomplete_answers():
    for i in range(32):
        store.save(
            str(uuid4()),
            snapshot(
                title=f"Fil {i}",
                messages=[
                    {
                        "role": "assistant",
                        "content": "incomplete secret",
                        "interrupted": True,
                    }
                ],
            ),
        )
    assert len(store.search()["items"]) == 30
    assert store.search()["next_offset"] == 30
    assert len(store.search(offset=30)["items"]) == 2
    assert not store.search("incomplete")["items"]
    with pytest.raises(store.ConversationError):
        store.search(offset=100_001)


def test_manual_title_wins_over_model_and_snapshot():
    ident = str(uuid4())
    assert store.claim_title(ident, "Provisional")
    assert not store.claim_title(ident, "Again")
    assert store.set_title(ident, "Mon titre", manual=True)
    assert not store.set_title(ident, "Late generation")
    store.save(ident, snapshot())
    assert store.read(ident)["title"] == "Mon titre"


def test_api_roundtrip_and_conflict(router_client):
    from arete.api.conversations import router

    client = router_client(router)
    ident = str(uuid4())
    assert (
        client.put(
            f"/conversations/{ident}", json=snapshot().model_dump(mode="json")
        ).status_code
        == 200
    )
    assert client.get(f"/conversations/{ident}").json()["revision"] == 1
    assert (
        client.put(
            f"/conversations/{ident}",
            json=snapshot(write_id="b" * 64).model_dump(mode="json"),
        ).status_code
        == 409
    )
    assert client.get("/conversations", params={"offset": -1}).status_code == 422
    assert client.get("/conversations", params={"q": "Hyrox"}).json()["items"]


def test_title_hook_is_nonblocking_and_cancelled_with_run(monkeypatch):
    from arete.agent.middlewares.conversation_title import ConversationTitleMiddleware
    from arete.agent.runtime.context import AgentContext
    from arete.agent.runtime.conversation_title import close_title

    async def scenario():
        started, released = asyncio.Event(), asyncio.Event()

        async def slow(*args):
            started.set()
            await released.wait()

        context = AgentContext(current_datetime=CLOCK, thread_id=str(uuid4()))
        middleware = ConversationTitleMiddleware(slow)
        runtime = SimpleNamespace(context=context, stream_writer=lambda _: None)
        await asyncio.wait_for(
            middleware.abefore_agent({"messages": [HumanMessage("Hyrox")]}, runtime),
            0.1,
        )
        await asyncio.wait_for(started.wait(), 0.1)
        assert not context.title_task.done()
        await close_title(context)
        assert context.title_task.cancelled()

    asyncio.run(scenario())


def test_title_custom_event_is_correlated_and_never_answer_text():
    from arete.agent.runtime.context import AgentContext
    from arete.agent.runtime.conversation_title import generate_title
    from arete.agent.runtime.streaming import StreamProjection

    class Model:
        model_name = "test"
        calls = 0

        async def ainvoke(self, messages, config):
            self.calls += 1
            return AIMessage("Footing et renforcement Hyrox")

    async def scenario():
        model = Model()
        context = AgentContext(current_datetime=CLOCK, thread_id=str(uuid4()))
        events = []
        await generate_title(model, context, "Hyrox après footing", events.append)
        await generate_title(model, context, "Encore", events.append)
        assert model.calls == 1
        assert context.stats.model_calls == 1
        assert events == [
            {
                "type": "thread_title",
                "thread_id": context.thread_id,
                "title": "Footing et renforcement Hyrox",
            }
        ]
        projection = StreamProjection()
        assert projection.events({"type": "custom", "data": events[0]}) == events
        assert not projection.events(
            {
                "type": "messages",
                "data": (
                    AIMessage("secret title"),
                    {"langgraph_node": "model", "lc_source": "conversation_title"},
                ),
            }
        )

    asyncio.run(scenario())


def test_native_graph_emits_title_custom_event_before_answer_and_closes_task(
    monkeypatch,
):
    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    from arete.agent.middlewares.conversation_title import ConversationTitleMiddleware
    from arete.agent.runtime.context import AgentContext
    from arete.agent.runtime.execution import stream_agent

    async def fresh(context):
        return None

    monkeypatch.setattr("arete.agent.runtime.execution.refresh_personal_data", fresh)

    async def scenario():
        events = []
        title_ready = asyncio.Event()

        async def title(context, first, emit):
            emit(
                {
                    "type": "thread_title",
                    "thread_id": context.thread_id,
                    "title": "Hyrox",
                }
            )
            title_ready.set()

        class Model(GenericFakeChatModel):
            async def _agenerate(self, *args, **kwargs):
                await asyncio.wait_for(title_ready.wait(), 1)
                return await super()._agenerate(*args, **kwargs)

        graph = create_agent(
            Model(messages=iter([AIMessage("Réponse principale")])),
            middleware=[ConversationTitleMiddleware(title)],
            context_schema=AgentContext,
        )
        context = AgentContext(current_datetime=CLOCK, thread_id=str(uuid4()))
        async for part in stream_agent(
            graph, {"messages": [HumanMessage("Hyrox ?")]}, context=context
        ):
            events.append(part)
        assert any(
            part["type"] == "custom" and part["data"].get("type") == "thread_title"
            for part in events
        )
        assert context.title_task.done()

    asyncio.run(scenario())


def test_concurrent_snapshots_have_one_winner():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    ident = str(uuid4())
    store.save(ident, snapshot())
    ready = Barrier(2)

    def write(key):
        ready.wait(timeout=5)
        try:
            return store.save(
                ident,
                snapshot(
                    revision=1,
                    write_id=key * 64,
                    messages=[{"role": "user", "content": key}],
                ),
            )["revision"]
        except store.ConversationConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as workers:
        outcomes = list(workers.map(write, ["b", "c"]))
    assert outcomes.count(2) == 1
    assert outcomes.count("conflict") == 1
    assert store.read(ident)["revision"] == 2
