"""The scrubber must redact by default and touch neither the model's copy nor
the handful of structural/operational fields a trace stays useful without."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import date
from unittest.mock import Mock

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGenerationChunk
from langsmith import Client
from pydantic import PrivateAttr

from arete.observability import scrubbing
from arete.observability.scrubbing import REDACTED_TRUNCATED, redact_error, scrub
from arete.observability.tracing import _ScrubbingTracer

FIXTURE_SENTENCE = "Sharp pain in the left knee after the long run, mood is low."


class _RecordingTracerClient(Client):
    """A plain run-recording Client, for tracer-level (not scrub()) tests."""

    def __init__(self):
        super().__init__(api_key="test-key", auto_batch_tracing=False)
        self.recorded: dict = {}

    def create_run(self, name, inputs, run_type, **kwargs):
        self.recorded[str(kwargs["id"])] = {"inputs": inputs}

    def update_run(self, run_id, **kwargs):
        self.recorded[str(run_id)].update(kwargs)


# --- scrub(): allowlisted keys kept, everything else redacted. ---


def test_allowlisted_keys_are_kept_verbatim():
    payload = {
        "name": "read_file",
        "type": "tool",
        "id": "msg-1",
        "tool_call_id": "call-1",
        "run_id": "run-1",
        "model_name": "gpt-test",
        "finish_reason": "stop",
        "status": "success",
    }
    assert scrub(payload) == payload


def test_unlisted_keys_are_redacted_with_their_length():
    payload = {"title": "t", "body": FIXTURE_SENTENCE, "day": "2026-01-01"}
    scrubbed = scrub(payload)
    assert scrubbed["title"] == "[REDACTED:1 chars]"
    assert scrubbed["body"] == f"[REDACTED:{len(FIXTURE_SENTENCE)} chars]"
    assert scrubbed["day"] == "[REDACTED:10 chars]"


def test_grep_pattern_and_remember_fact_fields_are_redacted():
    """Review finding: these previously survived because nothing recognized
    the key names; the new default-deny net needs no such list."""
    assert scrub({"pattern": "genou"})["pattern"] == "[REDACTED:5 chars]"
    payload = {"kind": "injury", "since": "2026-01-01", "valid_until": "2026-02-01"}
    scrubbed = scrub(payload)
    assert all(v.startswith("[REDACTED:") for v in scrubbed.values())


def test_numeric_values_pass_through_regardless_of_key():
    payload = {"usage_metadata": {"input_tokens": 10, "output_tokens": 2}}
    assert scrub(payload) == payload


def test_empty_string_redacts_to_the_bare_marker():
    assert scrub({"body": ""})["body"] == "[REDACTED]"


def test_nested_structures_are_walked():
    payload = {"fact": {"id": 1, "kind": "injury", "text": FIXTURE_SENTENCE}}
    scrubbed = scrub(payload)
    assert scrubbed["fact"]["id"] == 1
    assert scrubbed["fact"]["kind"].startswith("[REDACTED:")
    assert scrubbed["fact"]["text"].startswith("[REDACTED:")


def test_lists_are_walked_and_tool_call_names_and_ids_kept():
    payload = {
        "tool_calls": [
            {
                "name": "append_journal",
                "args": {"title": "t", "body": FIXTURE_SENTENCE},
                "id": "c1",
                "type": "tool_call",
            }
        ]
    }
    scrubbed = scrub(payload)
    call = scrubbed["tool_calls"][0]
    assert call["name"] == "append_journal"
    assert call["id"] == "c1"
    assert call["type"] == "tool_call"
    assert call["args"]["title"].startswith("[REDACTED:")
    assert call["args"]["body"].startswith("[REDACTED:")


def test_bound_reached_on_depth_redacts_instead_of_raising():
    nested: dict = {"leaf": FIXTURE_SENTENCE}
    for _ in range(scrubbing.WALK_DEPTH_MAX + 5):
        nested = {"child": nested}
    scrubbed = scrub(nested)
    found = scrubbed
    while isinstance(found, dict) and "child" in found:
        found = found["child"]
    assert found == REDACTED_TRUNCATED


def test_bound_reached_on_node_count_redacts_instead_of_raising():
    payload = {str(i): FIXTURE_SENTENCE for i in range(scrubbing.WALK_NODES_MAX + 50)}
    scrubbed = scrub(payload)
    assert REDACTED_TRUNCATED in scrubbed.values()


def test_bound_reached_on_many_entries_stops_iterating_early():
    """Review finding: a dict comprehension always builds every entry
    regardless of the budget; a trusted-looking value skipped the recursive
    call that used to be the only place enforcing it. The dict walker must
    stop the loop itself once the budget runs out, not just cheapen it."""
    payload = {str(i): i for i in range(scrubbing.WALK_NODES_MAX + 50)}
    scrubbed = scrub(payload)
    assert REDACTED_TRUNCATED in scrubbed.values()
    assert len(scrubbed) <= scrubbing.WALK_NODES_MAX + 1


def test_scrub_never_raises_even_on_a_broken_message_copy():
    broken = Mock()
    broken.__class__ = ToolMessage  # isinstance() matches BaseMessage's check...
    broken.content = FIXTURE_SENTENCE
    broken.additional_kwargs = {}
    broken.model_copy.side_effect = RuntimeError("boom")
    assert scrub({"output": broken}) == {}


def test_an_unrecognized_object_under_an_allowlisted_key_is_still_redacted():
    """Review finding: an allowlisted key name was enough to skip redaction
    outright for a non-string value, even an object this walker has never
    seen, the exact class of leak the unknown-type fallback exists for."""

    class _BoundModel:
        pass

    scrubbed = scrub({"model": _BoundModel()})
    assert scrubbed["model"] == "[REDACTED:_BoundModel]"


def test_non_dict_payload_passes_through():
    assert scrub("not a dict") == "not a dict"


def test_redact_error_keeps_only_the_exception_type():
    assert redact_error("ValueError: tool unavailable") == "ValueError: [REDACTED]"
    assert (
        redact_error("RuntimeError('tool unavailable')") == "RuntimeError: [REDACTED]"
    )
    assert redact_error(None) is None


# --- Messages: content always redacted; type/name/id/tool_call_id kept. ---


def test_system_message_content_is_fully_redacted():
    prompt = "Tu es Chiron.\n\n# Ton journal\nSharp pain, mood is low."
    scrubbed = scrub({"messages": [[SystemMessage(prompt)]]})
    content = scrubbed["messages"][0][0].content
    assert content == f"[REDACTED:{len(prompt)} chars]"


def test_serialized_system_message_content_is_also_redacted():
    payload = {
        "messages": [
            [
                {
                    "kwargs": {
                        "content": "Tu es Chiron. " + FIXTURE_SENTENCE,
                        "type": "system",
                    }
                }
            ]
        ]
    }
    scrubbed = scrub(payload)
    kwargs = scrubbed["messages"][0][0]["kwargs"]
    assert kwargs["type"] == "system"
    assert kwargs["content"].startswith("[REDACTED:")


def test_tool_message_content_is_redacted_regardless_of_tool_name():
    """The new design redacts every tool result, not only a known-sensitive
    one: there is no such thing as a harmless tool result by default."""
    message = ToolMessage(
        content="12 sessions this week", name="get_workload", tool_call_id="r1"
    )
    scrubbed = scrub({"output": message})
    assert scrubbed["output"].name == "get_workload"
    assert scrubbed["output"].tool_call_id == "r1"
    assert scrubbed["output"].content.startswith("[REDACTED:")


def test_live_ai_message_tool_calls_keep_name_and_id_but_redact_args():
    message = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "append_journal",
                "args": {"title": "t", "body": FIXTURE_SENTENCE},
                "id": "c1",
                "type": "tool_call",
            }
        ],
    )
    scrubbed = scrub({"output": message})
    call = scrubbed["output"].tool_calls[0]
    assert call["name"] == "append_journal"
    assert call["id"] == "c1"
    assert call["args"]["body"].startswith("[REDACTED:")
    assert message.tool_calls[0]["args"]["body"] == FIXTURE_SENTENCE  # Unmutated.


def test_raw_provider_function_call_arguments_are_redacted_name_kept():
    message = AIMessage(
        content="",
        additional_kwargs={
            "tool_calls": [
                {
                    "id": "c1",
                    "type": "function",
                    "function": {
                        "name": "remember_fact",
                        "arguments": json.dumps({"text": FIXTURE_SENTENCE}),
                    },
                }
            ]
        },
    )
    scrubbed = scrub({"output": message})
    function = scrubbed["output"].additional_kwargs["tool_calls"][0]["function"]
    assert function["name"] == "remember_fact"
    assert function["arguments"].startswith("[REDACTED:")
    original = message.additional_kwargs["tool_calls"][0]["function"]
    assert FIXTURE_SENTENCE in original["arguments"]  # Unmutated.


def test_response_metadata_keeps_model_and_finish_reason_redacts_the_rest():
    message = AIMessage(
        content="",
        response_metadata={
            "model_name": "gpt-test",
            "finish_reason": "stop",
            "system_fingerprint": "fp_" + FIXTURE_SENTENCE,
        },
    )
    scrubbed = scrub({"output": message})["output"].response_metadata
    assert scrubbed["model_name"] == "gpt-test"
    assert scrubbed["finish_reason"] == "stop"
    assert scrubbed["system_fingerprint"].startswith("[REDACTED:")


def test_attachment_state_content_and_path_are_both_redacted():
    """Review findings: the files dict carries extracted text under
    "content" with no tool name, and is itself keyed by the attachment's
    path, which can carry an athlete-chosen filename. A value-side allowlist
    protects neither; the dict is walked by its shape, not a known key."""
    payload = {"files": {"/attachments/plan.md": {"content": FIXTURE_SENTENCE}}}
    scrubbed = scrub(payload)
    ((key, entry),) = scrubbed["files"].items()
    assert key.startswith("[REDACTED:")
    assert entry["content"].startswith("[REDACTED:")


def test_a_bare_filename_key_with_no_path_separator_is_still_redacted():
    """An athlete-chosen filename need not contain a slash to be content:
    a French, spaced or accented name is not a snake_case schema field."""
    payload = {"genou blessure resultats irm.pdf": {"content": FIXTURE_SENTENCE}}
    scrubbed = scrub(payload)
    (key,) = scrubbed.keys()
    assert key.startswith("[REDACTED:")


def test_two_equal_length_redacted_keys_do_not_collide():
    """Review finding: two distinct dict keys that redact to the exact same
    marker would collide, silently dropping one of the two entries."""
    payload = {
        "plan genou.md": {"content": "a"},
        "plan coeur.md": {"content": "b"},
    }
    scrubbed = scrub(payload)
    assert len(scrubbed) == 2


def test_an_unhashable_value_under_an_enum_key_is_redacted_not_raised():
    """A non-string value must not reach `in` on the enum frozenset: a set,
    unlike a str, is unhashable and would raise there."""
    assert scrub({"status": {1, 2, 3}}) == {"status": "[REDACTED:set]"}


def test_allowlisted_key_with_a_nested_value_is_still_walked():
    """Review finding: trusting an allowlisted key's value outright, without
    recursing, would let content hide inside an unexpectedly nested value."""
    payload = {"model": {"name": "gpt-test", "system_prompt": FIXTURE_SENTENCE}}
    scrubbed = scrub(payload)
    assert scrubbed["model"]["name"] == "gpt-test"
    assert scrubbed["model"]["system_prompt"].startswith("[REDACTED:")


def test_allowlisted_key_with_a_long_string_is_redacted_anyway():
    """Review finding: an allowlisted key name does not guarantee its value
    is actually an identifier; a free-text sentence under "name" is content
    wearing that key's name, not the short tag the allowlist expects."""
    payload = {"name": FIXTURE_SENTENCE * 5}
    assert scrub(payload)["name"].startswith("[REDACTED:")


def test_allowlisted_key_with_any_whitespace_is_redacted_even_if_short():
    """Review finding: a short string can still be athlete content (a brief
    answer, a body part). A real tool/run/model name or id never contains a
    space; any multi-word answer does, so that alone is enough to redact,
    regardless of length."""
    payload = {"name": "mal au genou"}
    assert scrub(payload)["name"].startswith("[REDACTED:")


def test_node_budget_truncation_marker_is_a_valid_json_key():
    """Review finding: Ellipsis as a dict key is not JSON-serializable and
    would break downstream, after scrub()'s own try/except already returned."""
    payload = {str(i): i for i in range(scrubbing.WALK_NODES_MAX + 5)}
    scrubbed = scrub(payload)
    assert all(isinstance(key, str) for key in scrubbed)


def test_a_short_word_under_a_closed_vocabulary_key_is_not_a_free_pass():
    """Review finding: being short and lowercase does not make a value an
    enum member. "genou" (knee) and "success" are the same shape; only the
    latter is an actual status."""
    payload = {"status": "genou", "type": "ai", "role": "escalier"}
    scrubbed = scrub(payload)
    assert scrubbed["status"].startswith("[REDACTED:")
    assert scrubbed["type"] == "ai"
    assert scrubbed["role"].startswith("[REDACTED:")


# --- Tracer: redacts every run's error to its type, which scrub() cannot reach. ---


def test_scrubbing_tracer_redacts_a_tool_error_to_its_type():
    client = _RecordingTracerClient()
    tracer = _ScrubbingTracer(project_name="test-project", client=client)
    run_id = uuid.uuid4()
    tracer.on_tool_start(
        {"name": "edit_file"}, "/notes.md", run_id=run_id, name="edit_file"
    )
    tracer.on_tool_error(
        ValueError(f"String '{FIXTURE_SENTENCE}' appears 2 times"), run_id=run_id
    )
    assert client.recorded[str(run_id)]["error"] == "ValueError: [REDACTED]"


def test_scrubbing_tracer_leaves_a_run_with_no_error_alone():
    client = _RecordingTracerClient()
    tracer = _ScrubbingTracer(project_name="test-project", client=client)
    run_id = uuid.uuid4()
    tracer.on_tool_start(
        {"name": "read_file"}, "/notes.md", run_id=run_id, name="read_file"
    )
    tracer.on_tool_end("content", run_id=run_id)
    assert client.recorded[str(run_id)].get("error") is None


# --- Real end-to-end: drive the actual langsmith.Client hide_* path. ---


def tool_call(name, args, call_id):
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}],
    )


class _ResponseFeed:
    """A consumable response feed that reveals nothing when listed/serialized.

    LangSmith's own JSON encoder, with the real (non-overridden) Client, can
    fall back to dumping a run's `serialized` model repr via pydantic, which
    iterates any `Iterator`-typed field to represent it as a JSON array. A
    plain `iter([...])` of the real scripted responses would therefore both
    get drained before `_generate` ever saw them (breaking the test) and
    place the fixture's sentinels straight into that unscrubbed field (a
    test-only artifact: a real provider model's config has no such field).
    `__next__` serves the real items for generation; `__iter__` hands out
    only their count, independent of `__next__`'s own cursor.
    """

    def __init__(self, items):
        self._items = list(items)
        self._index = 0

    def __next__(self):
        if self._index >= len(self._items):
            raise StopIteration
        item = self._items[self._index]
        self._index += 1
        return item

    def __iter__(self):
        return iter([f"<scripted response {i}>" for i in range(len(self._items))])


class FakeCoach(GenericFakeChatModel):
    _seen: list = PrivateAttr(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._seen.append(messages)
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        # A tracing callback makes LangChain prefer streaming; without this,
        # GenericFakeChatModel's own _stream consumes self.messages on a
        # separate path that drops tool_calls and desyncs from _generate.
        message = self._generate(messages, **kwargs).generations[0].message
        chunk = ChatGenerationChunk(
            message=AIMessageChunk(**message.model_dump(exclude={"type"}))
        )
        if run_manager:
            run_manager.on_llm_new_token(chunk.text, chunk=chunk)
        yield chunk


def _capture_requests(monkeypatch):
    """Patch the HTTP transport, not the Client: every captured body has
    already gone through the real hide_inputs/hide_outputs, exactly as a
    real LangSmith upload would."""
    import requests

    bodies: list[bytes] = []

    def fake_request(self, method, url, **kwargs):
        data = kwargs.get("data")
        if data is not None:
            bodies.append(data if isinstance(data, bytes) else data.encode())
        response = requests.Response()
        response.status_code = 200
        response._content = b"{}"
        return response

    monkeypatch.setattr(requests.sessions.Session, "request", fake_request)
    return bodies


def _no_sentinel_leaked(bodies: list[bytes], *sentinels: str) -> None:
    blob = b"\n".join(bodies).decode("utf-8", errors="replace")
    for sentinel in sentinels:
        assert sentinel not in blob, f"{sentinel!r} leaked in a captured request body"


def _enable_real_tracing(monkeypatch):
    """A real langsmith.Client, synchronous so each run posts immediately,
    with the production hide_inputs/hide_outputs wired exactly as
    get_tracing_client() would."""
    from arete.observability import tracing

    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "test-key")
    client = Client(
        api_key="test-key",
        auto_batch_tracing=False,
        hide_inputs=scrub,
        hide_outputs=scrub,
    )
    monkeypatch.setattr(tracing, "_client", client)
    return client


def _init_isolated_db(monkeypatch, tmp_path):
    monkeypatch.setenv("ARETE_DB", str(tmp_path / "agent.duckdb"))
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_MODEL", "test-coach")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    from arete.dataio.init_duckdb import main as init_db

    init_db()


def test_real_hide_path_leaks_no_sentinel_with_facts_journal_and_attachment(
    monkeypatch, tmp_path
):
    from arete import coaching as agent
    from arete.agent.backends.attachments import attachment_files
    from arete.agent.runtime import execution
    from arete.agent.runtime.context import AgentContext
    from arete.services.athlete_facts import add_fact
    from arete.services.memory import append_entry

    _init_isolated_db(monkeypatch, tmp_path)
    journal_sentence = "SENTINEL_JOURNAL knee pain during squats"
    fact_sentence = "SENTINEL_FACT chronic knee injury since 2020"
    attachment_sentence = "SENTINEL_ATTACH low ferritin"
    grep_pattern = "SENTINEL_PATTERN"
    append_entry("notes.md", "knee check", journal_sentence, when=date(2026, 1, 1))
    add_fact("injury", fact_sentence, since=date(2026, 1, 1))
    agent.get_agent.cache_clear()

    model = FakeCoach(
        messages=_ResponseFeed(
            [
                tool_call("grep", {"pattern": grep_pattern}, "g1"),
                tool_call(
                    "remember_fact",
                    {
                        "kind": "injury",
                        "text": "new injury text",
                        "evidence": "explicit",
                        "source_ref": "athlete said so",
                    },
                    "r1",
                ),
                AIMessage(content="Finished."),
            ]
        )
    )
    monkeypatch.setattr(
        agent,
        "build_chat_model",
        lambda **kw: FakeCoach(messages=_ResponseFeed([]))
        if kw.get("max_tokens") == 512
        else model,
    )

    bodies = _capture_requests(monkeypatch)
    _enable_real_tracing(monkeypatch)

    attachment_path = "/attachments/plan.md"
    state = {
        "messages": [HumanMessage("Comment va mon genou ?")],
        "files": attachment_files({attachment_path: attachment_sentence}),
    }
    context = AgentContext(attachment_paths=(attachment_path,))
    result = asyncio.run(
        execution.invoke_agent(agent.get_agent(), state, context=context)
    )
    assert result["messages"][-1].content == "Finished."

    _no_sentinel_leaked(
        bodies,
        journal_sentence,
        fact_sentence,
        attachment_sentence,
        grep_pattern,
        "new injury text",
        "athlete said so",
    )

    # The model's own history still carries the real content, untouched.
    prompt = model._seen[0][0].content
    assert journal_sentence in prompt
    assert fact_sentence in prompt


def test_real_hide_path_leaks_no_sentinel_with_headingless_archive_retrieval(
    monkeypatch, tmp_path
):
    """Review finding: a hit from an archive alone (no current facts/journal)
    carries no FACTS/JOURNAL heading, so a heading-based cut would miss it.
    The default-deny net does not depend on where in the prompt it sits."""
    from arete import coaching as agent
    from arete.agent.runtime import execution
    from arete.agent.runtime.context import AgentContext
    from arete.services.memory import memory_root

    _init_isolated_db(monkeypatch, tmp_path)
    archive_sentence = "SENTINEL_ARCHIVE genou tendinite"
    root = memory_root()
    (root / "sessions-2026-08.md").write_text(
        f"## 2026-08-03 outing\n{archive_sentence}\n", encoding="utf-8"
    )
    agent.get_agent.cache_clear()

    model = FakeCoach(messages=_ResponseFeed([AIMessage(content="Finished.")]))
    monkeypatch.setattr(
        agent,
        "build_chat_model",
        lambda **kw: FakeCoach(messages=_ResponseFeed([]))
        if kw.get("max_tokens") == 512
        else model,
    )

    bodies = _capture_requests(monkeypatch)
    _enable_real_tracing(monkeypatch)

    state = {"messages": [HumanMessage("mon genou me fait mal, que faire ?")]}
    result = asyncio.run(
        execution.invoke_agent(agent.get_agent(), state, context=AgentContext())
    )
    assert result["messages"][-1].content == "Finished."

    _no_sentinel_leaked(bodies, archive_sentence)

    prompt = model._seen[0][0].content
    assert archive_sentence in prompt  # Confirms retrieval actually fired.


def test_real_hide_path_leaks_no_sentinel_in_a_feedback_run(monkeypatch, tmp_path):
    """Review finding: briefing/feedback/review runs restate the journal in
    their own HumanMessage/AIMessage, which the old design never touched."""
    from arete import coaching as agent
    from arete.agent.runtime import execution
    from arete.agent.runtime.context import AgentContext

    _init_isolated_db(monkeypatch, tmp_path)
    feedback_sentence = "SENTINEL_FEEDBACK sore hamstring, low motivation"
    answer_sentence = "SENTINEL_ANSWER recommends an easy week"

    model = FakeCoach(messages=_ResponseFeed([AIMessage(content=answer_sentence)]))
    monkeypatch.setattr(
        agent,
        "build_chat_model",
        lambda **kw: FakeCoach(messages=_ResponseFeed([]))
        if kw.get("max_tokens") == 512
        else model,
    )
    agent.build_feedback_agent.cache_clear()

    bodies = _capture_requests(monkeypatch)
    _enable_real_tracing(monkeypatch)

    state = {"messages": [HumanMessage(feedback_sentence)]}
    result = asyncio.run(
        execution.invoke_agent(
            agent.build_feedback_agent(),
            state,
            context=AgentContext(profile="feedback"),
        )
    )
    assert result["messages"][-1].content == answer_sentence

    _no_sentinel_leaked(bodies, feedback_sentence, answer_sentence)
