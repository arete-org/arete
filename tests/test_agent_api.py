"""Tests for the coaching agent (graph mocked — no network)."""

from __future__ import annotations

import json
from unittest.mock import patch
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import HumanMessage

from arete.agent.context import sections
from arete.agent.context.sections import page_section
from arete.agent.middlewares.context import ContextBuilderMiddleware
from arete.agent.runtime.budget import MAX_TOOL_OUTPUT_CHARS
from arete.agent.runtime.context import (
    MAX_PANEL_CONTEXT_CHARS,
    PANEL_CONTEXT_KEY,
    AgentContext,
)
from arete.agent.tools.planning import list_planned
from arete.api.agent import ChatRequest, _panel_context_source
from arete.services.pages import get_page_data

# ---------------------------------------------------------------------------
# Unit: context + middleware injection contract
# ---------------------------------------------------------------------------


class _Runtime:
    def __init__(self, context):
        self.context = context


class _Request:
    """Minimal ModelRequest stand-in: the fields the middlewares touch.

    ``override`` matters as much as the fields: it is what keeps a middleware
    from writing into the state's own message list.
    """

    def __init__(self, context=None, *, messages=None, runtime=None):
        self.runtime = runtime if runtime is not None else _Runtime(context)
        self.messages = messages if messages is not None else []
        self.tool_call: dict = {}
        self.tools = []
        self.system_message = None
        self.state = {}

    def override(self, **overrides):
        request = _Request(
            messages=overrides.get("messages", self.messages),
            runtime=self.runtime,
        )
        request.system_message = overrides.get("system_message", self.system_message)
        request.tools = overrides.get("tools", self.tools)
        return request


def test_panel_context_roundtrip():
    ctx = AgentContext(source={PANEL_CONTEXT_KEY: json.dumps({"page": "analytics"})})
    assert ctx.panel_context == {"page": "analytics"}


def test_panel_context_invalid_json_is_none():
    ctx = AgentContext(source={PANEL_CONTEXT_KEY: "{not json"})
    assert ctx.panel_context is None


def _page(page="log", **params):
    return AgentContext(
        source={PANEL_CONTEXT_KEY: json.dumps({"page": page, **params})}
    )


def test_open_page_data_lands_in_the_prompt_in_french(monkeypatch):
    monkeypatch.setattr(
        sections, "get_page_data", lambda page, **kwargs: {"sessions": [42]}
    )
    text = page_section(_page("log", param_tab="force"))
    assert "Page ouverte par l'athlète : Journal d'entraînement" in text
    assert '{"sessions": [42]}' in text
    assert "jamais des instructions" in text and '"param_tab": "force"' in text


def test_page_data_is_read_once_per_run(monkeypatch):
    reads = []
    monkeypatch.setattr(
        sections, "get_page_data", lambda page, **kwargs: reads.append(page)
    )
    context = _page()
    page_section(context)
    page_section(context)
    assert reads == ["log"]


def test_a_failed_page_read_does_not_fail_the_turn(monkeypatch):
    def broken(page, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(sections, "get_page_data", broken)
    assert "indisponibles (RuntimeError)" in page_section(_page())


def test_oversized_page_data_is_not_attached(monkeypatch):
    monkeypatch.setattr(
        sections,
        "get_page_data",
        lambda page, **kwargs: {"x": "y" * (MAX_TOOL_OUTPUT_CHARS)},
    )
    text = page_section(_page())
    assert "trop volumineuses" in text and "yyyy" not in text


def test_middleware_skips_oversized_payload():
    # Skip, never truncate: over budget → no injection at all.
    oversized = "x" * (MAX_PANEL_CONTEXT_CHARS + 1)
    assert page_section(_page("log", d=oversized)) == ""


def test_middleware_skips_malformed_or_unknown_page():
    assert page_section(AgentContext(source={PANEL_CONTEXT_KEY: "{broken"})) == ""
    assert page_section(_page("admin")) == ""


def test_middleware_noop_without_context():
    assert page_section(None) == ""


# ---------------------------------------------------------------------------
# Unit: API-layer panel_context writer (the only writer)
# ---------------------------------------------------------------------------


def test_source_writer_rejects_unknown_page():
    with pytest.raises(Exception, match="Unknown page"):
        _panel_context_source(
            ChatRequest(messages=[{"role": "user", "content": "hi"}], page="nope")
        )


def test_source_writer_rejects_oversized_payload():
    body = ChatRequest(
        messages=[{"role": "user", "content": "hi"}],
        panel_context={"blob": "x" * (MAX_PANEL_CONTEXT_CHARS + 1)},
    )
    with pytest.raises(Exception, match="over budget"):
        _panel_context_source(body)


def test_source_writer_merges_page_and_freeform():
    source = _panel_context_source(
        ChatRequest(
            messages=[{"role": "user", "content": "hi"}],
            page="log",
            panel_context={"x": 1},
        )
    )
    payload = json.loads(source[PANEL_CONTEXT_KEY])
    assert payload["page"] == "log"
    assert payload["x"] == 1


# ---------------------------------------------------------------------------
# Server-side page reads
# ---------------------------------------------------------------------------


def test_page_reads_show_what_the_athlete_sees():
    from arete.services.pages import get_page_data

    dashboard = get_page_data("dashboard")
    assert {"player_stats", "planned_today", "done_today", "strength_today"} <= set(
        dashboard
    )
    assert "briefing_today" in dashboard
    assert "recent_strength_sessions" in get_page_data("log")


@pytest.mark.parametrize(
    "page", ["dashboard", "analytics", "planning", "log", "settings", "profile"]
)
def test_all_server_page_reads_succeed(page):
    out = get_page_data(page)
    assert "error" not in out, out


# ---------------------------------------------------------------------------
# Endpoint: POST /agent/chat (graph mocked)
# ---------------------------------------------------------------------------


class _FakeFinal:
    def __init__(self):
        self.content = "Réponse du coach."

    def text(self):
        return self.content


@pytest.fixture()
def client():
    from arete.api.main import app

    with TestClient(app) as c:
        yield c


def test_chat_endpoint_with_mocked_graph(client):
    class _FakeGraph:
        async def ainvoke(self, state, *, context=None, config=None):
            assert config["recursion_limit"] > 0
            assert isinstance(context, AgentContext)
            return {"messages": [state["messages"][-1], _FakeFinal()]}

    with patch("arete.api.agent.get_agent", return_value=_FakeGraph()):
        response = client.post(
            "/agent/chat",
            json={
                "messages": [{"role": "user", "content": "Comment ça va ?"}],
                "page": "dashboard",
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert body["message"]["role"] == "assistant"
    assert body["message"]["content"] == "Réponse du coach."


def test_chat_endpoint_rejects_unknown_page(client):
    response = client.post(
        "/agent/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "page": "nope"},
    )
    assert response.status_code == 422


def test_chat_endpoint_rejects_empty_messages(client):
    response = client.post("/agent/chat", json={"messages": []})
    assert response.status_code == 422


def test_skill_catalog_uses_native_discovery_without_building_a_model(client):
    with patch(
        "arete.coaching.build_chat_model", side_effect=AssertionError("No model needed")
    ):
        response = client.get("/agent/skills")
    assert response.status_code == 200
    skills = response.json()
    assert any(skill["name"] == "document-planning" for skill in skills)
    assert all(set(skill) == {"name", "description", "path"} for skill in skills)


def test_invalid_skill_is_a_client_error_in_http_and_stream(client):
    from arete.agent.context.skills import SkillSelectionError

    class InvalidSkill:
        async def ainvoke(self, state, **kwargs):
            raise SkillSelectionError("Skill inconnu : /unknown")

        async def astream(self, state, **kwargs):
            raise SkillSelectionError("Skill inconnu : /unknown")
            yield  # An async generator, matching the graph's streaming contract.

    with patch("arete.api.agent.get_agent", return_value=InvalidSkill()):
        body = {"messages": [{"role": "user", "content": "/unknown"}]}
        response = client.post("/agent/chat", json=body)
        assert response.status_code == 422
        assert "Skill inconnu" in response.json()["detail"]
        stream = client.post("/agent/chat/stream", json=body)
    assert '"type": "error"' in stream.text
    assert '"type": "done"' not in stream.text


def test_middleware_wraps_handler_without_context():
    # Smoke: with no context at all the middleware must pass through cleanly.
    middleware = ContextBuilderMiddleware()

    request = _Request()
    sentinel = "ok"
    result = middleware.wrap_model_call(request, lambda _r: sentinel)
    assert result == sentinel


# ---------------------------------------------------------------------------
# Streaming endpoint + tool events
# ---------------------------------------------------------------------------


def test_tool_event_middleware_emits_start_and_end():
    from arete.agent.middlewares.events import ToolEventMiddleware

    events: list[dict] = []

    class _FakeWriter:
        def __call__(self, event):
            events.append(event)

    class _Request:
        tool_call = {
            "id": "call-1",
            "name": "list_planned",
            "args": {"start_date": "2027-01-01"},
        }

    with patch("langgraph.config.get_stream_writer", return_value=_FakeWriter()):
        middleware = ToolEventMiddleware()
        result = middleware.wrap_tool_call(_Request(), lambda _r: "result")

    assert result == "result"
    assert events[0] == {
        "type": "tool_start",
        "id": "call-1",
        "name": "list_planned",
        "args": {"text": '{"start_date": "2027-01-01"}', "truncated": False},
    }
    assert events[1]["id"] == "call-1"
    assert events[1]["status"] == "done"
    assert events[1]["output"]["text"] == "result"
    assert events[1]["elapsed_ms"] >= 0


def test_chat_stream_endpoint_sse(client):
    import json as _json

    class _FakePart:
        def __init__(self, data):
            self.data = data

    def _fake_astream(self, _input, **_kwargs):
        async def _gen():
            yield {
                "type": "custom",
                "data": {
                    "type": "tool_start",
                    "name": "list_planned",
                    "args": "log",
                },
            }
            from langchain_core.messages import AIMessageChunk

            yield {
                "type": "messages",
                "data": (AIMessageChunk(content="Salut"), {"langgraph_node": "model"}),
            }

        return _gen()

    with patch("langgraph.graph.state.CompiledStateGraph.astream", _fake_astream):
        response = client.post(
            "/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "salut"}], "page": "log"},
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    events = [
        _json.loads(line[6:])
        for line in response.text.split("\n")
        if line.startswith("data: ")
    ]
    types = [e["type"] for e in events]
    assert types == ["tool_start", "token", "done"]
    assert events[1]["text"] == "Salut"


def test_chat_stream_endpoint_error_event(client):
    import json as _json

    def _fake_astream(self, _input, **_kwargs):
        async def _gen():
            raise RuntimeError("boom")
            yield  # pragma: no cover

        return _gen()

    with patch("langgraph.graph.state.CompiledStateGraph.astream", _fake_astream):
        response = client.post(
            "/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "salut"}]},
        )
    assert response.status_code == 200  # error rides an SSE event, not the status
    events = [
        _json.loads(line[6:])
        for line in response.text.split("\n")
        if line.startswith("data: ")
    ]
    assert events[-1]["type"] == "error"
    # The exception's text stays in the server logs, out of the response.
    assert events[-1]["detail"] == "Agent run failed"


# ---------------------------------------------------------------------------
# Provider mapping
# ---------------------------------------------------------------------------


class TestBuildChatModel:
    """Every provider `.env.example` documents must build, or the agent 500s."""

    def test_ollama_is_the_default(self, monkeypatch):
        from arete.agent.models.providers import build_chat_model

        monkeypatch.delenv("LLM_PROVIDER", raising=False)
        monkeypatch.delenv("LLM_MODEL", raising=False)
        assert build_chat_model().openai_api_base.startswith("http")

    @staticmethod
    def _payload(model):
        # Exercise tool binding: the router needs the schemas to select a
        # capable model.
        with patch.object(model.client.with_raw_response, "create") as create:
            create.return_value.headers = {}
            create.return_value.parse.return_value = {
                "choices": [{"message": {"role": "assistant", "content": "OK"}}],
                "model": "selected/model",
            }
            model.bind_tools([list_planned]).invoke("Hello")
        return create.call_args.kwargs

    @staticmethod
    def _openrouter(monkeypatch, model=None, fallbacks=None):
        monkeypatch.setenv("LLM_PROVIDER", "openrouter")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
        for name, value in (("LLM_MODEL", model), ("LLM_MODEL_FALLBACKS", fallbacks)):
            if value is None:
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, value)

    @pytest.mark.parametrize("configured_model", [None, ""])
    def test_openrouter_default_sends_its_fallback_list(
        self, monkeypatch, configured_model
    ):
        from arete.agent.models.providers import build_chat_model
        from arete.agent.models.registry import (
            DEFAULT_OPENROUTER_FALLBACKS,
            DEFAULT_OPENROUTER_MODEL,
        )

        self._openrouter(monkeypatch, configured_model)
        model = build_chat_model()
        assert model.openai_api_base == "https://openrouter.ai/api/v1"
        assert not model.default_headers
        payload = self._payload(model)
        assert payload["model"] == DEFAULT_OPENROUTER_MODEL
        assert payload["tools"][0]["function"]["name"] == "list_planned"
        assert payload["extra_body"]["models"] == [
            DEFAULT_OPENROUTER_MODEL,
            *DEFAULT_OPENROUTER_FALLBACKS,
        ]
        # The free router once answered a briefing with a safety classifier.
        assert "openrouter/free" not in payload["extra_body"]["models"]

    def test_free_only_routing_requires_the_openrouter_host(self, monkeypatch):
        from dataclasses import replace

        from arete.agent.models.providers import build_chat_model
        from arete.agent.models.routing import resolve_route

        self._openrouter(monkeypatch)
        lookalike = replace(
            resolve_route(), base_url="https://openrouter.ai.example.com/api/v1"
        )
        assert (
            "provider"
            not in self._payload(build_chat_model(route=lookalike))["extra_body"]
        )

    def test_only_auxiliary_openrouter_calls_disable_reasoning(self, monkeypatch):
        from arete import coaching

        self._openrouter(monkeypatch)
        with patch.object(coaching, "build_agent") as assemble:
            coaching._assemble("chat")
        models = assemble.call_args.kwargs
        coach_payload = self._payload(models["model"])
        assert "suggestion_model" not in models
        assert "reasoning" not in coach_payload["extra_body"]
        # Main graph fallback owns candidate selection, with one attempt each.
        candidates = [models["model"], *models["fallback_models"]]
        assert len(candidates) == 3
        for candidate in candidates:
            assert candidate.max_retries == 0
            assert "models" not in self._payload(candidate)["extra_body"]

    def test_pinned_model_without_fallback_preserves_bounded_sdk_retries(
        self, monkeypatch
    ):
        from arete import coaching

        self._openrouter(monkeypatch, "pinned:free")
        with patch.object(coaching, "build_agent") as assemble:
            coaching._assemble("chat")
        models = assemble.call_args.kwargs
        assert models["model"].max_retries == 2
        assert models["fallback_models"] == ()
        assert "models" not in self._payload(models["model"])["extra_body"]

    @pytest.mark.parametrize("provider", ["ollama", "github"])
    def test_openrouter_reasoning_controls_do_not_reach_other_providers(
        self, monkeypatch, provider
    ):
        from arete.agent.models.providers import build_chat_model

        monkeypatch.setenv("LLM_PROVIDER", provider)
        monkeypatch.setenv("GITHUB_TOKEN", "test-token")
        payload = self._payload(build_chat_model(openrouter_reasoning=False))
        assert "reasoning" not in (payload.get("extra_body") or {})

    def test_a_pinned_model_is_never_rerouted_silently(self, monkeypatch):
        from arete.agent.models.providers import build_chat_model

        self._openrouter(monkeypatch, "custom/model:free")
        payload = self._payload(build_chat_model())
        assert payload["model"] == "custom/model:free"
        assert "models" not in (payload.get("extra_body") or {})

    @pytest.mark.parametrize("pinned", [None, "custom/model:free"])
    def test_openrouter_requests_never_pay(self, monkeypatch, pinned):
        from arete.agent.models.providers import build_chat_model

        self._openrouter(monkeypatch, pinned)
        payload = self._payload(build_chat_model())
        assert payload["extra_body"]["provider"] == {
            "max_price": {"prompt": 0, "completion": 0}
        }

    def test_a_pinned_model_takes_explicit_fallbacks_in_order(self, monkeypatch):
        from arete.agent.models.providers import build_chat_model

        self._openrouter(monkeypatch, "a/one:free", "b/two:free, openrouter/free")
        payload = self._payload(build_chat_model())
        assert payload["extra_body"]["models"] == [
            "a/one:free",
            "b/two:free",
            "openrouter/free",
        ]

    def test_more_than_three_models_is_refused_before_any_request(self, monkeypatch):
        # OpenRouter answers HTTP 400 to a longer list.
        from arete.agent.models.providers import build_chat_model

        self._openrouter(monkeypatch, "a:free", "b:free,c:free,d:free")
        with pytest.raises(ValueError, match="3 models"):
            build_chat_model()

    def test_openrouter_without_a_key_is_actionable(self, monkeypatch):
        from arete.agent.models.providers import build_chat_model

        monkeypatch.setenv("LLM_PROVIDER", "openrouter")
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
            build_chat_model()

    def test_github_provider_builds(self, monkeypatch):
        # Documented in .env.example; it used to raise ValueError here while
        # working fine for the tips path.
        from arete.agent.models.providers import build_chat_model
        from arete.agent.models.registry import DEFAULT_GITHUB_MODEL

        monkeypatch.setenv("LLM_PROVIDER", "github")
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test")
        monkeypatch.delenv("LLM_MODEL", raising=False)
        model = build_chat_model()
        assert model.model_name == DEFAULT_GITHUB_MODEL
        assert urlsplit(model.openai_api_base).hostname == (
            "models.inference.ai.azure.com"
        )

    def test_github_without_a_token_is_actionable(self, monkeypatch):
        import pytest

        from arete.agent.models.providers import build_chat_model

        monkeypatch.setenv("LLM_PROVIDER", "github")
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        with pytest.raises(ValueError, match="GITHUB_TOKEN"):
            build_chat_model()

    def test_unknown_provider_lists_the_supported_ones(self, monkeypatch):
        import pytest

        from arete.agent.models.providers import build_chat_model

        monkeypatch.setenv("LLM_PROVIDER", "bedrock")
        with pytest.raises(ValueError, match="ollama, openrouter, github"):
            build_chat_model()


class TestPanelContextStaysOutOfState:
    """The open page is for the request, not for the conversation.

    `request.messages` IS the state's message list. A stamp appended to it
    in place used to pile up, one copy per model call. The page now lives in
    the rebuilt system message, so the message list is never touched.
    """

    @pytest.fixture(autouse=True)
    def page_data(self, monkeypatch):
        monkeypatch.setattr(
            sections, "get_page_data", lambda page, **kwargs: {"page": page}
        )

    @staticmethod
    def _request(messages):
        return _Request(
            messages=messages,
            runtime=_Runtime(
                AgentContext(source={PANEL_CONTEXT_KEY: '{"page": "log"}'})
            ),
        )

    def test_the_caller_list_is_not_mutated(self):
        from arete.agent.middlewares.context import ContextBuilderMiddleware

        request = self._request([HumanMessage("salut")])
        ContextBuilderMiddleware().wrap_model_call(request, lambda r: "ok")
        assert len(request.messages) == 1

    def test_the_model_receives_it_in_the_system_message(self):
        from arete.agent.middlewares.context import ContextBuilderMiddleware

        seen: list = []
        ContextBuilderMiddleware().wrap_model_call(
            self._request([HumanMessage("salut")]), lambda r: seen.append(r) or "ok"
        )
        (request,) = seen
        assert "Page ouverte par l'athlète" in request.system_message.text
        assert [m.text for m in request.messages] == ["salut"]

    def test_turns_do_not_pile_up(self):
        from arete.agent.middlewares.context import ContextBuilderMiddleware

        middleware = ContextBuilderMiddleware()
        messages = [HumanMessage("salut")]
        counts: list[int] = []
        request = self._request(messages)
        for _ in range(3):
            middleware.wrap_model_call(
                request, lambda r: counts.append(len(r.messages)) or "ok"
            )
        assert counts == [1, 1, 1]
        assert len(messages) == 1


@pytest.mark.parametrize("endpoint", ["/agent/chat", "/agent/chat/stream"])
def test_chat_routes_preserve_thread_id(client, endpoint):
    from langchain_core.messages import AIMessage

    thread_id = "dfe771b8-661a-46af-9cee-dce80e6bc304"

    class Graph:
        async def ainvoke(self, state, *, context, config):
            assert context.thread_id == thread_id
            assert config["metadata"]["thread_id"] == thread_id
            return {"messages": [AIMessage(content="ok")]}

        async def astream(self, state, *, context, config, **kwargs):
            result = await self.ainvoke(state, context=context, config=config)
            yield {"type": "updates", "data": {"model": result}}

    with patch("arete.api.agent.get_agent", return_value=Graph()):
        response = client.post(
            endpoint,
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "thread_id": thread_id,
            },
        )
    assert response.status_code == 200
    assert "ok" in response.text
    assert '"type": "error"' not in response.text


@pytest.mark.parametrize("endpoint", ["/agent/chat", "/agent/chat/stream"])
def test_chat_routes_reject_invalid_thread_id(client, endpoint):
    response = client.post(
        endpoint,
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "thread_id": "not-a-uuid",
        },
    )
    assert response.status_code == 422


class TestPlanningPageRead:
    """The Planning page read is a window, not the whole plan.

    Read whole, a plan that runs months out overflowed the 32k bound — 109
    sessions on real data — and the tool answered with an error, so the coach
    on the Planning page could not see the plan at all.
    """

    def _plan(self, offsets_days):
        from datetime import date, timedelta

        from arete.garmin.models import PlannedSession, SessionType
        from arete.garmin.repository import GarminRepository

        repo = GarminRepository()
        today = date.today()
        return repo, [
            repo.create_planned_session(
                PlannedSession(
                    date=today + timedelta(days=offset),
                    sport="running",
                    session_type=SessionType.ENDURANCE,
                    description=f"offset {offset}",
                )
            )
            for offset in offsets_days
        ]

    def test_only_the_window_is_read(self):
        from arete.services.pages import PLANNING_AHEAD_DAYS, PLANNING_PAST_DAYS

        repo, ids = self._plan(
            [-(PLANNING_PAST_DAYS + 5), -2, 3, PLANNING_AHEAD_DAYS + 30]
        )
        try:
            out = get_page_data("planning")
            seen = {row["description"] for row in out["planned_sessions"]}
        finally:
            for i in ids:
                repo.delete_planned_session(i)
        assert "offset -2" in seen and "offset 3" in seen
        assert f"offset {-(PLANNING_PAST_DAYS + 5)}" not in seen
        assert f"offset {PLANNING_AHEAD_DAYS + 30}" not in seen

    def test_rows_are_in_date_order_and_carry_no_nulls(self):
        repo, ids = self._plan([5, 1, 3])
        try:
            rows = get_page_data("planning")["planned_sessions"]
        finally:
            for i in ids:
                repo.delete_planned_session(i)
        dates = [row["date"] for row in rows]
        assert dates == sorted(dates)
        assert all(value is not None for row in rows for value in row.values())

    def test_the_read_shows_what_was_done_in_the_window(self):
        """A run synced today must be visible next to the plan it replaces."""
        from datetime import date, timedelta

        from arete.garmin.models import ActualSession
        from arete.garmin.repository import GarminRepository
        from arete.services.pages import PLANNING_PAST_DAYS

        repo = GarminRepository()
        today = date.today()
        ids = [
            repo.create_actual_session(
                ActualSession(date=day, sport="running", name=name, duration_sec=2400)
            )
            for day, name in (
                (today, "Run 8 km"),
                (today - timedelta(days=PLANNING_PAST_DAYS + 5), "Old run"),
            )
        ]
        try:
            done = get_page_data("planning")["done_sessions"]
        finally:
            for i in ids:
                repo.delete_actual_session(i)
        names = {row["name"] for row in done}
        assert "Run 8 km" in names and "Old run" not in names

    def test_the_read_says_where_to_look_beyond_it(self):
        out = get_page_data("planning")
        assert out["window"]["from"] < out["window"]["to"]
        assert "list_planned" in out["beyond_the_window"]


class TestAnalyticsPageRead:
    """The coach reads what each card says; the chart keeps its points.

    The daily series were 84 % of an Analytics read on real data. The agent
    reasons from the headline, the previous-period comparison and the card's
    insight, and asks the analytics toolkit when it needs a trend.
    """

    def test_the_agent_read_has_no_series(self):
        out = get_page_data("analytics")
        cards = out["overview"]["cards"]
        assert cards, "no cards at all"
        assert all("series" not in card for card in cards.values())

    def test_what_each_card_says_is_kept(self):
        out = get_page_data("analytics")
        for card in out["overview"]["cards"].values():
            assert "headline" in card

    def test_the_read_points_at_the_toolkit_for_trends(self):
        out = get_page_data("analytics")
        assert "get_workload" in out["trends"]

    def test_the_page_itself_still_gets_its_series(self, client):
        # Trimming the agent's read must not touch the route the chart uses.
        cards = client.get("/analytics/overview?period=30d").json()["cards"]
        assert any("series" in card for card in cards.values())


class TestLedgerTools:
    """The journal supports targeted corrections without arbitrary file creation."""

    def _tools(self):
        from arete.agent.backends.memory import build_memory_filesystem

        return {t.name: t for t in build_memory_filesystem().tools}

    def test_reading_points_at_the_end_of_the_journal(self):
        """`read_file` reads 100 lines from the top; new entries are appended.

        Past 100 lines, a default read returns the oldest entries and misses
        the recent ones.
        """
        assert "fin" in self._tools()["read_file"].description

    def test_the_filesystem_can_correct_and_delete_but_not_create(self):
        assert set(self._tools()) == {
            "read_file",
            "ls",
            "glob",
            "grep",
            "edit_file",
            "delete",
        }


def test_settings_page_data_has_no_identity_fields():
    from arete.services.pages import get_page_data

    settings = get_page_data("settings")["settings"]
    assert "email" not in settings and "display_name" not in settings
    assert "lthr" in settings  # the coaching fields stay


def test_every_supported_page_can_be_injected_without_a_model_call(monkeypatch):
    from arete.agent.runtime.context import PANEL_PAGES

    monkeypatch.setattr(
        sections, "get_page_data", lambda page, **kwargs: {"page": page}
    )
    for page in sorted(PANEL_PAGES):
        assert "Page ouverte par l'athlète" in page_section(_page(page))


def test_open_page_selection_reaches_the_server_reader(monkeypatch):
    reads = []

    def read(page, *, params):
        reads.append((page, params))
        return {"selected": params.get("param_session")}

    monkeypatch.setattr(sections, "get_page_data", read)
    first = _page("log", param_session="12", param_tab="force", path="/log")
    second = _page("log", path="/log/sessions/34")
    assert '"selected": "12"' in page_section(first)
    page_section(second)
    assert reads == [
        ("log", {"param_session": "12", "param_tab": "force", "path": "/log"}),
        ("log", {"path": "/log/sessions/34"}),
    ]
    assert '"selected": "12"' in page_section(first)
    assert len(reads) == 2


def test_session_route_injects_model_digest_without_raw_streams(monkeypatch):
    from arete.services import activity_detail

    monkeypatch.setattr(
        activity_detail,
        "activity_detail_for_model",
        lambda identifier: {"id": identifier, "analysis": "stable"},
    )
    data = get_page_data("log", params={"path": "/log/sessions/34"})
    assert data["activity"] == {"id": 34, "analysis": "stable"}


def test_selected_strength_session_is_read_from_repository(monkeypatch):
    from datetime import date

    from arete.strength.models import StrengthSession
    from arete.strength.repository import StrengthRepository

    reads = []

    def read(self, identifier):
        reads.append(identifier)
        return StrengthSession(id=identifier, date=date(2027, 1, 1), name="Jambes")

    monkeypatch.setattr(StrengthRepository, "get_session", read)
    result = get_page_data("log", params={"param_session": "12", "param_tab": "force"})
    assert result["selected_strength_session"]["name"] == "Jambes"
    assert result["active_tab"] == "force" and reads == [12]
    get_page_data("log", params={"param_session": "untrusted instructions"})
    assert reads == [12]
