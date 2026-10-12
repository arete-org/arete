"""Exercise the shared graph and actual LangChain callbacks without the network."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGenerationChunk
from langsmith import Client
from pydantic import PrivateAttr

from arete import coaching as agent
from arete.agent.profiles.catalog import get_profile
from arete.agent.runtime import execution
from arete.agent.runtime.context import AgentContext
from arete.observability import tracing

TASK_INSTRUCTIONS = {
    task: get_profile("feedback" if task == "session_feedback" else task).instructions
    for task in ("chat", "briefing", "session_feedback")
}


def graph_for(context):
    return {
        "chat": agent.get_agent,
        "briefing": agent.build_briefing_agent,
        "feedback": agent.build_feedback_agent,
    }[context.profile]()


def invoke(state, *, context):
    # Each test uses fake models; production workers reuse the server loop.
    return asyncio.run(
        execution.invoke_agent(graph_for(context), state, context=context)
    )


def stream_run(state, *, context):
    return execution.stream_agent(graph_for(context), state, context=context)


class FakeCoach(GenericFakeChatModel):
    _seen: list = PrivateAttr(default_factory=list)
    _barrier: Barrier | None = PrivateAttr(default=None)
    _fail: bool = PrivateAttr(default=False)

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._seen.append(messages)
        if self._barrier:
            self._barrier.wait(timeout=5)
        if self._fail:
            raise RuntimeError("inference unavailable")
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        # GenericFakeChatModel only streams text/legacy function_call fields;
        # preserve modern tool_calls and usage just as ChatOpenAI does.
        message = self._generate(messages, **kwargs).generations[0].message
        chunk = ChatGenerationChunk(
            message=AIMessageChunk(
                **message.model_dump(exclude={"type"}), chunk_position="last"
            )
        )
        if run_manager:
            run_manager.on_llm_new_token(chunk.text, chunk=chunk)
        yield chunk


class RecordingClient(Client):
    """Capture the SDK write boundary; use the real RunTree/LangChain tracer."""

    def __init__(self):
        super().__init__(api_key="test-key", auto_batch_tracing=False)
        self.recorded_runs = {}
        self.lock = Lock()

    def create_run(self, name, inputs, run_type, **kwargs):
        with self.lock:
            self.recorded_runs[str(kwargs["id"])] = {
                "name": name,
                "inputs": inputs,
                "run_type": run_type,
                **kwargs,
            }

    def update_run(self, run_id, **kwargs):
        with self.lock:
            # SDK patches use inputs=None to leave the original input intact.
            self.recorded_runs[str(run_id)].update(
                {k: v for k, v in kwargs.items() if k != "inputs" or v is not None}
            )


@pytest.fixture(autouse=True)
def isolated_graph(monkeypatch, tmp_path):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "agent.duckdb"))
    from arete.dataio.init_duckdb import main as init_db

    init_db()  # Missing memory tables are now explicit failures, not empty context.
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_MODEL", "test-coach")
    monkeypatch.setenv("LANGSMITH_PROJECT", "test-project")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    monkeypatch.setattr(tracing, "_client", None)
    # Accidental real requests are test failures, not hidden network access.
    monkeypatch.setattr(
        "requests.sessions.Session.request",
        Mock(side_effect=AssertionError("network forbidden")),
    )
    clearers = [
        factory.cache_clear
        for factory in (
            agent.get_agent,
            agent.build_briefing_agent,
            agent.build_feedback_agent,
        )
    ]
    for clear in clearers:
        clear()
    yield
    for clear in clearers:
        clear()


@pytest.fixture
def recorder(monkeypatch):
    client = RecordingClient()
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "test-key")
    monkeypatch.setattr(tracing, "_client", client)
    yield client
    client.close(timeout=0)


def install_model(monkeypatch, responses):
    model = FakeCoach(messages=iter(responses))
    factory = Mock(return_value=model)
    monkeypatch.setattr(
        agent,
        "build_chat_model",
        lambda **kw: FakeCoach(messages=iter([]))
        if kw.get("max_tokens") == 512
        else factory(),
    )
    return model, factory


def state(text="hello"):
    return {"messages": [HumanMessage(text)]}


def tool_call(name, args, call_id):
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}],
    )


def assert_trace_tree(client, roots=1):
    runs = list(client.recorded_runs.values())
    root_runs = [r for r in runs if r.get("parent_run_id") is None]
    assert len(root_runs) == roots
    root_ids = {str(r["id"]) for r in root_runs}
    for run in runs:
        assert str(run["trace_id"]) in root_ids
        assert run.get("end_time"), run["name"]
        assert run.get("session_name") == "test-project"
        parent = run.get("parent_run_id")
        if parent is not None:
            assert str(parent) in client.recorded_runs, run["name"]
            assert client.recorded_runs[str(parent)]["trace_id"] == run["trace_id"]
    assert {r["name"] for r in root_runs} == {"arete_coach"}
    return runs, root_runs


def test_concurrent_profiles_keep_instructions_and_traces_isolated(
    monkeypatch, recorder
):
    model, factory = install_model(monkeypatch, [AIMessage(content="ok")] * 3)
    model._barrier = Barrier(3)
    tasks = list(TASK_INSTRUCTIONS)

    def run(task):
        return invoke(
            state(task),
            context=AgentContext(
                profile="feedback" if task == "session_feedback" else task,
                source={"panel_context": '{"page":"log"}'},
            ),
        )

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(run, tasks, timeout=10))
    assert all(r["messages"][-1].content == "ok" for r in results)
    assert factory.call_count == 3  # One main model per declarative profile.
    for messages in model._seen:
        task = next(
            m.content for m in messages if m.type == "human" and m.content in tasks
        )
        prompt = messages[0].content
        assert TASK_INSTRUCTIONS[task] in prompt
        for other in set(tasks) - {task}:
            assert TASK_INSTRUCTIONS[other] not in prompt
        assert ("Page ouverte par l'athlète" in prompt) == (task == "chat")
    runs, roots = assert_trace_tree(recorder, roots=3)
    assert {r["extra"]["metadata"]["task"] for r in roots} == set(tasks)
    for root in roots:
        metadata = root["extra"]["metadata"]
        assert metadata["model"] == "test-coach"
        assert metadata["provider"] == "ollama"
        assert metadata["task"] == root["inputs"]["messages"][0].content
        children = [r for r in runs if r["trace_id"] == root["trace_id"]]
        assert all(r["extra"]["metadata"]["task"] == metadata["task"] for r in children)


@pytest.mark.parametrize("streaming", [False, True])
def test_native_dynamic_and_filesystem_tools_stay_in_one_trace(
    monkeypatch, recorder, streaming
):
    install_model(
        monkeypatch,
        [
            tool_call(
                "append_journal",
                {"file": "notes.md", "title": "", "body": ""},
                "journal",
            ),
            tool_call("get_workload", {"days": 0}, "dynamic"),
            tool_call("read_file", {"file_path": "/notes.md"}, "memory"),
            AIMessage(
                content="Finished.",
                usage_metadata={
                    "input_tokens": 10,
                    "output_tokens": 2,
                    "total_tokens": 12,
                },
            ),
        ],
    )
    if streaming:

        async def consume():
            return [part async for part in stream_run(state(), context=AgentContext())]

        parts = asyncio.run(consume())
        events = [p["data"] for p in parts if p["type"] == "custom"]
        assert {e["name"] for e in events if e["type"] == "tool_start"} >= {
            "get_workload",
            "read_file",
        }
        assert any(p["type"] == "messages" for p in parts)
    else:
        result = invoke(state(), context=AgentContext())
        assert result["messages"][-1].content == "Finished."
    runs, roots = assert_trace_tree(recorder)
    tools = [r for r in runs if r["run_type"] == "tool"]
    assert {r["name"] for r in tools} == {
        "append_journal",
        "get_workload",
        "read_file",
    }
    assert len(tools) == 3  # No double instrumentation.
    assert len([r for r in runs if r["run_type"] == "llm"]) == 4
    llms = [r for r in runs if r["run_type"] == "llm"]
    assert any(
        r["outputs"]["generations"][0][0]["message"]["kwargs"].get("usage_metadata")
        == {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}
        for r in llms
    )
    assert all(r.get("outputs") for r in tools)
    assert roots[0].get("outputs") is not None


@pytest.mark.parametrize("streaming", [False, True])
def test_skill_retrieval_exports_one_child_span_before_inference(
    monkeypatch, recorder, streaming
):
    from arete.agent.backends.attachments import attachment_files

    attachment = "/attachments/plan.md"
    install_model(
        monkeypatch,
        [
            tool_call(
                "read_file",
                {"file_path": "/skills/system/document-planning/SKILL.md"},
                "plan",
            ),
            AIMessage(content="Séance retrouvée."),
        ],
    )
    question = "regarde la prépa semi ci jointe"
    inputs = {
        **state(question),
        "files": attachment_files({attachment: "2026-10-10 : 3 x 10 minutes"}),
    }
    context = AgentContext(attachment_paths=(attachment,), thread_id="skill-thread")
    if streaming:

        async def consume():
            return [part async for part in stream_run(inputs, context=context)]

        asyncio.run(consume())
    else:
        invoke(inputs, context=context)
    runs, roots = assert_trace_tree(recorder)
    assert not [run for run in runs if run["run_type"] == "retriever"]
    reads = [
        run for run in runs if run["run_type"] == "tool" and run["name"] == "read_file"
    ]
    assert len(reads) == 1
    assert reads[0]["trace_id"] == roots[0]["trace_id"]
    assert reads[0]["extra"]["metadata"]["thread_id"] == "skill-thread"
    assert context.stats.skill_reads == 1
    assert len([run for run in runs if run["run_type"] == "llm"]) == 2


@pytest.mark.parametrize("streaming", [False, True])
def test_inference_errors_close_the_root_and_model_spans(
    monkeypatch, recorder, streaming
):
    model, _ = install_model(monkeypatch, [])
    model._fail = True
    with pytest.raises(RuntimeError, match="inference unavailable"):
        if streaming:

            async def consume():
                return [p async for p in stream_run(state(), context=AgentContext())]

            asyncio.run(consume())
        else:
            invoke(state(), context=AgentContext())
    runs, roots = assert_trace_tree(recorder)
    assert "inference unavailable" in roots[0]["error"]
    assert any(r["run_type"] == "llm" and r.get("error") for r in runs)


def test_disabled_tracing_overrides_legacy_environment(monkeypatch):
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    client_factory = Mock(side_effect=AssertionError("must not create client"))
    monkeypatch.setattr(tracing, "Client", client_factory)
    install_model(monkeypatch, [AIMessage(content="offline")])
    assert invoke(state(), context=AgentContext())["messages"][-1].content == "offline"
    client_factory.assert_not_called()


def test_enabled_tracing_requires_key_before_inference(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    model, factory = install_model(monkeypatch, [])
    with pytest.raises(ValueError, match="LANGSMITH_API_KEY"):
        invoke(state(), context=AgentContext())
    assert not model._seen


def test_trace_export_failure_preserves_the_answer(monkeypatch, recorder, caplog):
    install_model(monkeypatch, [AIMessage(content="still works")])
    monkeypatch.setattr(
        recorder, "create_run", Mock(side_effect=ConnectionError("export unavailable"))
    )
    monkeypatch.setattr(
        recorder, "update_run", Mock(side_effect=ConnectionError("export unavailable"))
    )
    result = invoke(state(), context=AgentContext())
    assert result["messages"][-1].content == "still works"
    assert "export unavailable" in caplog.text


def test_client_is_reused_bounded_and_closed(monkeypatch, caplog):
    from queue import PriorityQueue

    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "private-key")
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com/")
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", "workspace-id")
    client = Mock(tracing_queue=PriorityQueue())
    factory = Mock(return_value=client)
    monkeypatch.setattr(tracing, "Client", factory)
    assert tracing.get_tracing_client() is tracing.get_tracing_client()
    factory.assert_called_once()
    options = factory.call_args.kwargs
    assert options["timeout_ms"] == tracing.TRACE_TIMEOUT_MS
    assert options["retry_config"].total == tracing.TRACE_MAX_RETRIES
    assert options["tracing_sampling_rate"] == 1.0
    assert options["api_url"] == "https://eu.api.smith.langchain.com"
    assert options["workspace_id"] == "workspace-id"
    assert client.tracing_queue.maxsize == tracing.TRACE_QUEUE_MAX_SIZE
    options["tracing_error_callback"](ConnectionError("private-key"))
    assert "LangSmith trace export failed" in caplog.text
    assert "private-key" not in caplog.text
    tracing.close_tracing()
    client.close.assert_called_once_with(timeout=tracing.TRACE_SHUTDOWN_TIMEOUT_SEC)
    tracing.close_tracing()
    assert tracing._client is None


@pytest.mark.parametrize("cancel_task", [False, True])
@pytest.mark.parametrize("export_failure", [False, True])
def test_early_stream_close_finishes_trace_in_its_original_context(
    monkeypatch, recorder, cancel_task, export_failure, caplog
):
    from contextlib import aclosing

    from langsmith.run_helpers import get_tracing_context

    class PausedCoach(FakeCoach):
        async def _astream(self, messages, **kwargs):
            yield ChatGenerationChunk(message=AIMessageChunk(content="first token"))
            # Keep inference unfinished until the consumer disconnects. A fast
            # synchronous fake races graph shutdown and can hide missing spans.
            async with asyncio.timeout(5):
                await asyncio.Event().wait()

    monkeypatch.setattr(
        agent, "build_chat_model", lambda **kw: PausedCoach(messages=iter([]))
    )

    async def consume():
        before = get_tracing_context().copy()
        async with aclosing(stream_run(state(), context=AgentContext())) as stream:
            async with asyncio.timeout(5):
                async for part in stream:
                    if part["type"] == "messages":
                        break
                else:
                    pytest.fail("Model never streamed a token")
            if export_failure:
                monkeypatch.setattr(
                    recorder,
                    "update_run",
                    Mock(side_effect=ConnectionError("export unavailable")),
                )
            if cancel_task:
                task = asyncio.current_task()
                assert task is not None
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await anext(stream)
        # Check before asyncio.run performs its own async-generator cleanup.
        assert get_tracing_context() == before
        if export_failure:
            assert "LangSmith trace export failed" in caplog.text
            return
        runs, _ = assert_trace_tree(recorder)
        models = [r for r in runs if r["run_type"] == "llm"]
        assert len(models) == 1
        assert models[0]["error"]

    asyncio.run(consume())


@pytest.mark.parametrize("streaming", [False, True])
def test_dynamic_tool_exception_is_traced_and_propagated(
    monkeypatch, recorder, streaming
):
    from arete.agent.tools.analytics import get_workload

    install_model(
        monkeypatch,
        [
            tool_call("get_workload", {"days": 28}, "broken"),
        ],
    )

    def fail(days: int = 28):
        raise RuntimeError("tool unavailable")

    monkeypatch.setattr(get_workload, "func", fail)
    with pytest.raises(RuntimeError, match="tool unavailable"):
        if streaming:

            async def consume():
                return [p async for p in stream_run(state(), context=AgentContext())]

            asyncio.run(consume())
        else:
            invoke(state(), context=AgentContext())
    runs, roots = assert_trace_tree(recorder)
    tool_span = next(r for r in runs if r["name"] == "get_workload")
    assert "tool unavailable" in tool_span["error"]
    assert "tool unavailable" in roots[0]["error"]


@pytest.mark.parametrize(
    "task, limit", [("chat", 200), ("briefing", 200), ("session_feedback", 200)]
)
def test_task_limits_reach_both_execution_paths(monkeypatch, task, limit):
    graph = Mock()
    graph.ainvoke = AsyncMock(return_value={"messages": []})
    seen = []

    async def stream(_state, *, context, config, **kwargs):
        seen.append(config)
        yield {"type": "custom", "data": {}}

    graph.astream = stream
    monkeypatch.setattr(agent, "get_agent", lambda: graph)
    monkeypatch.setattr(agent, "build_briefing_agent", lambda: graph)
    monkeypatch.setattr(agent, "build_feedback_agent", lambda: graph)
    invoke(
        state(),
        context=AgentContext(
            profile="feedback" if task == "session_feedback" else task
        ),
    )

    async def consume():
        return [
            p
            async for p in stream_run(
                state(),
                context=AgentContext(
                    profile="feedback" if task == "session_feedback" else task
                ),
            )
        ]

    asyncio.run(consume())
    assert graph.ainvoke.call_args.kwargs["config"]["recursion_limit"] == limit
    assert seen[0]["recursion_limit"] == limit


def test_producers_select_the_correct_task(monkeypatch):
    from arete.coaching import run_briefing as briefing
    from arete.coaching import run_feedback as feedback

    invoke = Mock(return_value={"messages": [AIMessage(content="Un conseil.")]})
    monkeypatch.setattr(agent, "invoke_agent_sync", invoke)
    assert briefing("briefing facts") == "Un conseil."
    assert feedback("session facts") == "Un conseil."
    assert [call.kwargs["context"].profile for call in invoke.call_args_list] == [
        "briefing",
        "feedback",
    ]
    assert invoke.call_args.args[1]["messages"][0]["content"] == "session facts"


def test_unattended_runs_do_not_emit_ui_tool_events(monkeypatch):
    install_model(
        monkeypatch,
        [
            tool_call("read_file", {"file_path": "/notes.md"}, "memory"),
            AIMessage(content="feedback"),
        ],
    )

    async def consume():
        return [
            p
            async for p in stream_run(state(), context=AgentContext(profile="feedback"))
        ]

    assert not [p for p in asyncio.run(consume()) if p["type"] == "custom"]


def test_invalid_tracing_switch_is_a_configuration_error(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "typo")
    with pytest.raises(ValueError, match="true or false"):
        tracing.get_tracing_client()


@pytest.mark.parametrize("streaming", [False, True])
def test_chat_turns_share_thread_metadata_without_reusing_trace_or_date(
    monkeypatch, recorder, streaming
):
    from datetime import date, timedelta

    turn_ids = []
    model, factory = install_model(monkeypatch, [AIMessage(content="ok")] * 3)
    for index, thread_id in enumerate(("thread-a", "thread-a", "thread-b")):
        today = date(2026, 10, 8) + timedelta(days=index)
        context = AgentContext(thread_id=thread_id, current_date=today)
        turn_ids.append(context.run_id)
        if streaming:

            async def consume(context=context):
                return [p async for p in stream_run(state(), context=context)]

            asyncio.run(consume())
        else:
            invoke(state(), context=context)
        prompt = model._seen[-1][0].content
        assert f"Date actuelle : {today.isoformat()}" in prompt
        assert f"Demain : {(today + timedelta(days=1)).isoformat()}" in prompt
    factory.assert_called_once()
    runs, roots = assert_trace_tree(recorder, roots=3)
    assert len({r["trace_id"] for r in roots}) == 3
    assert {r["id"] for r in roots} == set(turn_ids)
    assert {r["trace_id"] for r in roots} == set(turn_ids)
    assert sorted(r["extra"]["metadata"]["thread_id"] for r in roots) == [
        "thread-a",
        "thread-a",
        "thread-b",
    ]
    threads = {r["trace_id"]: r["extra"]["metadata"]["thread_id"] for r in roots}
    assert all(
        r["extra"]["metadata"]["thread_id"] == threads[r["trace_id"]] for r in runs
    )


@pytest.fixture
def slack_dispatch(monkeypatch):
    from types import SimpleNamespace

    from arete.services import slack, slack_identity

    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    actor = SimpleNamespace(is_admin=True, clerk_user_id="admin")
    monkeypatch.setattr(slack_identity, "identity", lambda *a: (actor, "Europe/Paris"))
    monkeypatch.setattr(slack_identity, "private_owner", lambda *a: None)
    monkeypatch.setattr(slack_identity, "require_admin", lambda *a: actor)
    # Admission is tested in the service tests; allow concurrent trace lifetimes.
    monkeypatch.setattr(slack, "reserve", lambda *a: "running")
    monkeypatch.setattr(slack, "finish", lambda *a, **kw: None)
    agent._slack_graph.cache_clear()
    client = AsyncMock(spec=slack.SlackClient)
    client.call.return_value = {"ok": True, "ts": "2.000001", "members": []}

    async def history(message):
        return [{"role": "user", "content": message.text}]

    client.history.side_effect = history

    async def run(thread="1.000001"):
        message = slack.SlackMessage(
            "T123",
            thread,
            "A123",
            "C123",
            "U123",
            thread,
            thread,
            "Trouve Arthur",
            in_channel=True,
            mentioned=True,
        )
        return await agent.dispatch_slack_message(message, client=client)

    yield run
    agent._slack_graph.cache_clear()


class FakeClassifier(FakeCoach):
    extra_body: dict | None = None
    model_name: str = "test-classifier"


@pytest.mark.parametrize("enabled", [False, True])
def test_slack_classifier_and_native_tools_share_the_agent_trace(
    monkeypatch, recorder, slack_dispatch, enabled
):
    from langsmith.run_helpers import get_tracing_context

    monkeypatch.setenv("LANGSMITH_TRACING", "true" if enabled else "false")
    classifier = FakeClassifier(
        messages=iter(
            [
                AIMessage(
                    content='{"surface":"product","private_data":false,"outbound":false}'
                )
            ]
        )
    )
    coach = FakeCoach(
        messages=iter(
            [
                tool_call("find_slack_member", {"query": "Arthur"}, "find"),
                AIMessage(content="Aucun Arthur trouvé."),
            ]
        )
    )
    monkeypatch.setattr(
        agent,
        "build_chat_model",
        lambda **kw: (classifier if kw.get("max_tokens") == 1024 else coach),
    )

    async def run():
        before = get_tracing_context().copy()
        assert await slack_dispatch() == "Aucun Arthur trouvé."
        assert get_tracing_context() == before

    asyncio.run(run())
    if not enabled:
        assert not recorder.recorded_runs
        return
    runs, roots = assert_trace_tree(recorder)
    root = roots[0]
    assert root["outputs"] == {"output": "Aucun Arthur trouvé."}
    assert root["extra"]["metadata"]["thread_id"] == "slack:T123:C123:1.000001"
    classification = next(r for r in runs if r["name"] == "classify_slack_intent")
    assert classification["parent_run_id"] == root["id"]
    assert set(classification["inputs"]) == {"messages"}
    assert classification["outputs"] == {
        "surface": "product",
        "private_data": False,
        "outbound": False,
    }
    llms = [r for r in runs if r["run_type"] == "llm"]
    assert len(llms) == 3
    assert (
        next(r for r in llms if r["name"] == "slack_surface")["parent_run_id"]
        == classification["id"]
    )
    assert len([r for r in runs if r["run_type"] == "tool"]) == 1
    assert all(
        r["extra"]["metadata"]["thread_id"] == root["extra"]["metadata"]["thread_id"]
        for r in runs
    )


@pytest.mark.parametrize("failure", ["invalid", "cancelled"])
def test_slack_classifier_failure_closes_spans_without_running_agent(
    monkeypatch, recorder, slack_dispatch, failure
):
    from langsmith.run_helpers import get_tracing_context

    started = asyncio.Event()

    class Classifier(FakeClassifier):
        async def _agenerate(self, *args, **kwargs):
            if failure == "cancelled":
                started.set()
                async with asyncio.timeout(5):
                    await asyncio.Event().wait()
            return await super()._agenerate(*args, **kwargs)

    classifier = Classifier(messages=iter([AIMessage(content="invalid JSON")]))
    monkeypatch.setattr(agent, "build_chat_model", lambda **kw: classifier)

    async def run():
        before = get_tracing_context().copy()
        if failure == "cancelled":
            task = asyncio.create_task(slack_dispatch())
            async with asyncio.timeout(5):
                await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            assert await slack_dispatch() is None
        assert get_tracing_context() == before

    asyncio.run(run())
    runs, _ = assert_trace_tree(recorder)
    classification = next(r for r in runs if r["name"] == "classify_slack_intent")
    assert classification["error"]
    assert len([r for r in runs if r["run_type"] == "llm"]) == 1
    assert not [r for r in runs if r["run_type"] == "tool"]


def test_concurrent_slack_classifiers_keep_separate_parent_traces(
    monkeypatch, recorder, slack_dispatch
):
    classifier = FakeClassifier(
        messages=iter(
            [
                AIMessage(
                    content='{"surface":"product","private_data":false,"outbound":false}'
                )
            ]
            * 2
        )
    )
    classifier._barrier = Barrier(2)
    coach = FakeCoach(messages=iter([AIMessage(content="Réponse.")] * 2))
    monkeypatch.setattr(
        agent,
        "build_chat_model",
        lambda **kw: (classifier if kw.get("max_tokens") == 1024 else coach),
    )

    async def run():
        async with asyncio.timeout(10):
            return await asyncio.gather(
                slack_dispatch("1.000001"), slack_dispatch("2.000001")
            )

    assert asyncio.run(run()) == ["Réponse.", "Réponse."]
    runs, roots = assert_trace_tree(recorder, roots=2)
    assert len({r["extra"]["metadata"]["thread_id"] for r in roots}) == 2
    for root in roots:
        children = [r for r in runs if r["trace_id"] == root["trace_id"]]
        assert all(
            r["extra"]["metadata"]["thread_id"]
            == root["extra"]["metadata"]["thread_id"]
            for r in children
        )
        classification = [r for r in children if r["name"] == "classify_slack_intent"]
        assert len(classification) == 1
        assert classification[0]["parent_run_id"] == root["id"]


@pytest.mark.parametrize("enabled", [True, False])
def test_memory_classifier_stays_in_native_tool_trace_without_credentials(
    monkeypatch, recorder, enabled
):
    import json

    import httpx
    from pydantic import SecretStr

    from arete.agent.models.jev import JEV_MODEL, JevClient
    from arete.services import athlete_facts

    monkeypatch.setenv("LANGSMITH_TRACING", "true" if enabled else "false")
    monkeypatch.setenv("MEMORY_JEV_ENABLED", "true")

    def handler(request):
        choices = json.loads(request.content)["questions"]["memory"]["criteria"]
        return httpx.Response(
            200,
            json={
                "model": JEV_MODEL,
                "answers": {
                    "memory": {
                        "type": "choice",
                        "choice": "create",
                        "confidence": 1.0,
                        "probabilities": {
                            key: float(key == "create") for key in choices
                        },
                    }
                },
                "usage": {"input_tokens": 100, "output_tokens": 10},
            },
        )

    model = JevClient(
        api_key=SecretStr("never-export-this"),
        model=JEV_MODEL,
        timeout=1,
        max_retries=0,
        transport=httpx.MockTransport(handler),
    )
    monkeypatch.setattr(agent, "JevClient", lambda **_: model)
    athlete_facts.add_fact("preference", "Matin", evidence="explicit")
    install_model(
        monkeypatch,
        [
            tool_call(
                "remember_fact",
                {
                    "kind": "preference",
                    "text": "Forêt",
                    "evidence": "explicit",
                    "source_ref": "Je préfère la forêt",
                },
                "remember",
            ),
            AIMessage(content="C’est mémorisé."),
        ],
    )
    context = AgentContext(thread_id="memory-thread")
    result = invoke(state("Je préfère la forêt"), context=context)
    assert result["messages"][-1].text == "C’est mémorisé."
    assert context.stats.memory_decision_calls == 1
    if not enabled:
        assert not recorder.recorded_runs
        return
    runs, roots = assert_trace_tree(recorder)
    decision = next(r for r in runs if r["name"] == "classify_memory")
    tool = next(r for r in runs if r["run_type"] == "tool")
    assert str(decision["parent_run_id"]) == str(tool["id"])
    assert set(decision["inputs"]) == {"state", "choices"}
    assert decision["outputs"]["choice"] == "create"
    assert decision["extra"]["metadata"]["thread_id"] == "memory-thread"
    assert "never-export-this" not in str(recorder.recorded_runs)
