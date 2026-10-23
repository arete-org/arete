"""Run receipts, remote failures and feedback writes, with no external I/O."""

import json
from contextlib import contextmanager, nullcontext
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from langsmith.utils import LangSmithConnectionError, LangSmithNotFoundError

from arete.api.agent import router
from arete.api.agent_feedback import chat_trace
from arete.observability import feedback
from arete.services.athlete_scope import athlete_scope


@pytest.fixture
def remote(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "test-only-key")
    client = Mock()
    client.read_feedback.side_effect = LangSmithNotFoundError("missing")
    client.read_project.return_value = SimpleNamespace(id=uuid4())

    @contextmanager
    def fake_client():
        yield client

    monkeypatch.setattr(feedback, "feedback_client", fake_client)
    return client


def payload(run_id, thread_id):
    return {
        "thread_id": str(thread_id),
        "feedback_token": feedback.receipt(run_id, thread_id, ""),
        "key": "user_score",
        "value": 1,
    }


def test_create_update_remove_and_read_target_the_same_root(router_client, remote):
    api = router_client(router)
    run, thread = uuid4(), uuid4()
    body = payload(run, thread)
    url = f"/agent/feedback/{run}"
    assert api.put(url, json=body).status_code == 204
    created = remote.create_feedback.call_args.kwargs
    assert created["trace_id"] == run
    assert "run_id" not in created
    assert created["session_id"] == remote.read_project.return_value.id
    assert created["score"] == 1 and created["value"] is None
    assert created["stop_after_attempt"] == 1
    remote.read_feedback.side_effect = None
    remote.read_feedback.return_value = SimpleNamespace(score=1, value=None)
    assert api.put(url, json={**body, "value": 0}).status_code == 204
    remote.update_feedback.assert_called_once_with(
        created["feedback_id"], score=0, value=None
    )
    remote.create_feedback.assert_called_once()
    assert api.put(url, json={**body, "value": None}).status_code == 204
    remote.delete_feedback.assert_called_once_with(created["feedback_id"])
    remote.read_feedback.side_effect = [
        SimpleNamespace(score=0),
        SimpleNamespace(value="👩🏽‍💻"),
    ]
    assert api.post(f"{url}/read", json=body).json() == {
        "user_score": 0,
        "reaction": "👩🏽‍💻",
    }


@pytest.mark.parametrize("emoji", ["🎯", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇫🇷", "1️⃣", "❤️"])
def test_any_single_emoji_is_a_textual_feedback(router_client, remote, emoji):
    run, thread = uuid4(), uuid4()
    response = router_client(router).put(
        f"/agent/feedback/{run}",
        json={**payload(run, thread), "key": "reaction", "value": emoji},
    )
    assert response.status_code == 204
    created = remote.create_feedback.call_args.kwargs
    assert created["key"] == "reaction" and created["value"] == emoji
    assert created["score"] is None


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("user_score", True),
        ("user_score", 2),
        ("user_score", "1"),
        ("reaction", "hello"),
        ("reaction", "🔥🔥"),
        ("reaction", "🇫"),
        ("reaction", ""),
        ("reaction", "🔥" * 33),
        ("reaction", 1),
        ("other", 1),
    ],
)
def test_invalid_feedback_never_reaches_langsmith(router_client, remote, key, value):
    run, thread = uuid4(), uuid4()
    response = router_client(router).put(
        f"/agent/feedback/{run}",
        json={**payload(run, thread), "key": key, "value": value},
    )
    assert response.status_code == 422
    assert not remote.mock_calls


@pytest.mark.parametrize("change", ["run", "thread", "athlete", "account", "project"])
def test_receipt_cannot_be_reused_outside_its_origin(
    router_client, remote, monkeypatch, change
):
    run, thread = uuid4(), uuid4()
    body = payload(run, thread)
    if change == "run":
        run = uuid4()
    if change == "thread":
        body["thread_id"] = str(uuid4())
    if change == "account":
        monkeypatch.setattr("arete.api.agent_feedback.clerk_account", lambda _: "other")
    if change == "project":
        monkeypatch.setenv("LANGSMITH_PROJECT", "other")
    with athlete_scope(2 if change == "athlete" else 1):
        response = router_client(router).put(f"/agent/feedback/{run}", json=body)
    assert response.status_code == 403
    assert not remote.mock_calls


def test_disabled_tracing_has_no_receipt_and_cannot_write(
    router_client, remote, monkeypatch
):
    run, thread = uuid4(), uuid4()
    body = payload(run, thread)
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    assert chat_trace(run, str(thread), "") is None
    assert (
        router_client(router).put(f"/agent/feedback/{run}", json=body).status_code
        == 503
    )
    assert not remote.mock_calls


@pytest.mark.parametrize(
    "step",
    [
        "read_feedback",
        "read_project",
        "create_feedback",
        "update_feedback",
        "delete_feedback",
    ],
)
def test_failures_are_not_acknowledged_or_replayed(router_client, remote, step):
    run, thread = uuid4(), uuid4()
    body = payload(run, thread)
    if step in ("update_feedback", "delete_feedback"):
        remote.read_feedback.side_effect = None
        remote.read_feedback.return_value = SimpleNamespace(score=0)
    if step == "delete_feedback":
        body["value"] = None
    getattr(remote, step).side_effect = LangSmithConnectionError("secret payload")
    response = router_client(router).put(f"/agent/feedback/{run}", json=body)
    assert response.status_code == 502
    assert "secret payload" not in response.text
    assert getattr(remote, step).call_count == 1


def test_feedback_client_is_synchronous_and_has_no_sdk_or_http_retries(monkeypatch):
    constructor = Mock()
    monkeypatch.setattr(feedback, "Client", constructor)
    with feedback.feedback_client() as client:
        assert client is constructor.return_value
    options = constructor.call_args.kwargs
    assert options["auto_batch_tracing"] is False
    assert options["retry_config"].total == 0
    assert options["timeout_ms"] == (1000, 4000)
    client.close.assert_called_once_with(timeout=1.0)


def test_real_sdk_posts_feedback_before_returning_with_no_trace_queue(monkeypatch):
    from urllib.parse import urlparse

    import requests

    monkeypatch.setenv("LANGSMITH_API_KEY", "test-only-key")
    run, project = uuid4(), uuid4()
    calls = []

    def transport(self, method, url, **kwargs):
        path = urlparse(url).path
        calls.append((method, path, kwargs))
        response = requests.Response()
        response.status_code = 200
        response.url = url
        if path.endswith("/info"):
            data = {
                "version": "0.12.0",
                "batch_ingest_config": {"use_multipart_endpoint": True},
            }
        elif method == "GET" and "/feedback/" in path:
            response.status_code = 404
            data = {"detail": "not found"}
        elif path.endswith("/sessions"):
            data = [
                {
                    "id": str(project),
                    "tenant_id": str(uuid4()),
                    "reference_dataset_id": None,
                }
            ]
        elif method == "POST" and path.endswith("/feedback"):
            data = {}
        else:
            raise AssertionError(f"Unexpected SDK request: {method} {path}")
        response._content = json.dumps(data).encode()
        return response

    monkeypatch.setattr(requests.Session, "request", transport)
    feedback.write_feedback(run, "reaction", "🎯")
    posts = [kwargs for method, path, kwargs in calls if method == "POST"]
    assert len(posts) == 1 and len(calls) <= 4
    data = json.loads(posts[0]["data"])
    assert data["run_id"] == data["trace_id"] == str(run)
    assert data["session_id"] == str(project)
    assert data["value"] == "🎯" and data["key"] == "reaction"
    assert "score" not in data


@pytest.mark.parametrize("streaming", [False, True])
def test_http_receipt_identifies_the_graph_root_per_turn(
    router_client, remote, monkeypatch, streaming
):
    from langchain_core.messages import AIMessage, AIMessageChunk

    roots = []

    class Graph:
        async def ainvoke(self, state, *, context, config):
            roots.append(config["run_id"])
            return {"messages": [AIMessage(content="Réponse")]}

        async def astream(self, state, *, context, config, **kwargs):
            roots.append(config["run_id"])
            yield {
                "type": "messages",
                "data": (
                    AIMessageChunk(content="Réponse"),
                    {"langgraph_node": "model"},
                ),
            }

    monkeypatch.setattr("arete.api.agent.get_agent", Graph)
    monkeypatch.setattr("arete.api.agent._document_state", lambda _: {})
    monkeypatch.setattr("arete.agent.runtime.execution.agent_tracing", nullcontext)
    api = router_client(router)
    thread = uuid4()
    for _ in range(2):
        response = api.post(
            "/agent/chat" + ("/stream" if streaming else ""),
            json={
                "thread_id": str(thread),
                "messages": [{"role": "user", "content": "Demain ?"}],
            },
        )
        assert response.status_code == 200
        data = (
            [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ][-1]
            if streaming
            else response.json()
        )
        assert data["trace"] == {
            "trace_id": str(roots[-1]),
            "feedback_token": feedback.receipt(roots[-1], thread, ""),
        }
    assert len(set(roots)) == 2
