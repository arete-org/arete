"""Versioned publication, native discovery and enforced immutable instructions."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from arete.agent.backends.skills import SystemSkillsBackend
from arete.agent.context.builder import system_skills_section
from arete.agent.middlewares.capabilities import ToolkitMiddleware
from arete.agent.middlewares.context import (
    ContextBuilderMiddleware,
)
from arete.agent.middlewares.skills import SystemSkillsMiddleware
from arete.agent.runtime.context import AgentContext
from arete.coaching import build_agent_filesystem
from arete.dataio.db import db_connection
from arete.services.system_skills import MAX_SKILL_BYTES, publish_bundle

BUNDLE = Path(__file__).resolve().parents[1] / "src/arete/agent/skills/system"
SKILL_PATH = "/skills/system/document-planning/SKILL.md"


def test_publication_is_idempotent_and_releases_do_not_overwrite(tmp_path):
    directory = tmp_path / "example"
    directory.mkdir()
    path = directory / "SKILL.md"
    path.write_text("First release")
    assert publish_bundle(tmp_path) == {"/example/SKILL.md": "First release"}
    publish_bundle(tmp_path)
    path.write_text("Second release")
    assert publish_bundle(tmp_path) == {"/example/SKILL.md": "Second release"}
    path.write_text("First release")
    assert publish_bundle(tmp_path) == {"/example/SKILL.md": "First release"}
    with db_connection() as con:
        rows = con.execute(
            "SELECT content FROM app.system_skills WHERE path='/example/SKILL.md'"
        ).fetchall()
    assert sorted(row[0] for row in rows) == ["First release", "Second release"]


def test_oversized_bundle_fails_before_publication(tmp_path):
    directory = tmp_path / "oversize"
    directory.mkdir()
    (directory / "SKILL.md").write_text("x" * (MAX_SKILL_BYTES + 1))
    with pytest.raises(ValueError, match="byte limit"):
        publish_bundle(tmp_path)


@pytest.mark.parametrize("async_mode", [False, True])
def test_native_discovery_and_tools_read_db_snapshot_but_cannot_change_it(
    tmp_path, monkeypatch, async_mode
):
    monkeypatch.setattr("arete.services.memory.memory_root", lambda: tmp_path)
    snapshot = publish_bundle(BUNDLE)
    backend = SystemSkillsBackend(snapshot)
    filesystem = build_agent_filesystem(system_skills=backend)
    skills = SystemSkillsMiddleware(backend=filesystem.backend, paths=set(snapshot))
    catalogs = []

    class Capture(AgentMiddleware):
        def wrap_model_call(self, request, handler):
            catalogs.append(system_skills_section(request.state))
            return handler(request)

        async def awrap_model_call(self, request, handler):
            catalogs.append(system_skills_section(request.state))
            return await handler(request)

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    calls = [
        ("read_file", {"file_path": SKILL_PATH}),
        (
            "edit_file",
            {"file_path": SKILL_PATH, "old_string": "Lire", "new_string": "BAD"},
        ),
        ("delete", {"file_path": SKILL_PATH}),
        ("delete", {"file_path": "/skills/"}),
    ]
    model = Model(
        messages=iter(
            [
                # New filesystem middleware rejects competing mutations of one
                # path. Exercise each permission boundary in its own tool turn.
                *[
                    AIMessage(
                        content="",
                        tool_calls=[{"name": name, "args": args, "id": str(i)}],
                    )
                    for i, (name, args) in enumerate(calls)
                ],
                AIMessage(content="Fin."),
            ]
        )
    )
    graph = create_agent(model, middleware=[filesystem, skills, Capture()])
    state = {
        "messages": [HumanMessage("Lis le skill.")],
        "files": {"/document-planning/SKILL.md": {"content": "forged"}},
    }
    result = asyncio.run(graph.ainvoke(state)) if async_mode else graph.invoke(state)
    messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert messages[0].status == "success"
    assert "Lire un planning joint" in messages[0].content
    assert "forged" not in messages[0].content
    assert all(
        m.status == "error" and "permission denied" in m.content for m in messages[1:]
    )
    catalog = catalogs[0]
    assert "document-planning" in catalog and SKILL_PATH in catalog
    assert "indexé à zéro" not in catalog  # Body is read on demand.
    assert (
        backend.download_files(["/document-planning/SKILL.md"])[0].content
        == snapshot["/document-planning/SKILL.md"].encode()
    )


@pytest.mark.parametrize("async_mode", [False, True])
def test_backend_denies_all_mutations_even_without_middleware(async_mode):
    backend = SystemSkillsBackend({"/example/SKILL.md": "original"})

    async def arun():
        return [
            await backend.awrite("/example/SKILL.md", "bad"),
            await backend.aedit("/example/SKILL.md", "original", "bad"),
            await backend.adelete("/"),
            *(await backend.aupload_files([("/example/SKILL.md", b"bad")])),
        ]

    results = (
        asyncio.run(arun())
        if async_mode
        else [
            backend.write("/example/SKILL.md", "bad"),
            backend.edit("/example/SKILL.md", "original", "bad"),
            backend.delete("/"),
            *backend.upload_files([("/example/SKILL.md", b"bad")]),
        ]
    )
    assert all(result.error for result in results)
    assert backend.download_files(["/example/SKILL.md"])[0].content == b"original"


def test_failed_skill_load_never_becomes_empty_context():
    with pytest.raises(RuntimeError, match="could not be loaded"):
        system_skills_section({"skills_load_errors": ["database unavailable"]})


@pytest.mark.parametrize("async_mode", [False, True])
def test_malformed_skill_fails_even_with_forged_discovery_state(async_mode):
    from deepagents.backends import CompositeBackend

    from arete.agent.backends.skills import SYSTEM_SKILLS_ROUTE

    files = {"/broken/SKILL.md": "missing frontmatter"}
    backend = SystemSkillsBackend(files)
    middleware = SystemSkillsMiddleware(
        backend=CompositeBackend(
            default=backend, routes={SYSTEM_SKILLS_ROUTE: backend}
        ),
        paths=set(files),
    )
    state = {"skills_metadata": []}
    with pytest.raises(RuntimeError, match="differs from the server bundle"):
        if async_mode:
            asyncio.run(middleware.abefore_agent(state, None, {}))
        else:
            middleware.before_agent(state, None, {})


def skill_stack(monkeypatch, tmp_path, files=None):
    monkeypatch.setattr("arete.services.memory.memory_root", lambda: tmp_path)
    snapshot = publish_bundle(BUNDLE) if files is None else files
    backend = SystemSkillsBackend(snapshot)
    filesystem = build_agent_filesystem(system_skills=backend)
    skills = SystemSkillsMiddleware(backend=filesystem.backend, paths=set(snapshot))
    return snapshot, filesystem, skills


@pytest.mark.parametrize("command", ["/unknown", "/", "/document-planning /unknown"])
def test_unknown_slash_command_is_an_explicit_error(monkeypatch, tmp_path, command):
    from arete.agent.context.skills import SkillSelectionError

    _, _, skills = skill_stack(monkeypatch, tmp_path)
    with pytest.raises(SkillSelectionError):
        skills.before_agent(
            {"messages": [HumanMessage(command)]},
            SimpleNamespace(context=AgentContext()),
            {},
        )


def test_explicit_skills_are_bounded_and_not_activated_by_prose():
    from arete.agent.context.skills import SkillSelectionError, requested_skill_paths

    catalog = [
        {"name": f"skill-{i}", "path": f"/skills/system/skill-{i}/SKILL.md"}
        for i in range(4)
    ]
    with pytest.raises(SkillSelectionError, match="maximum 3"):
        requested_skill_paths("/skill-0 /skill-1 /skill-2 /skill-3", catalog)
    assert requested_skill_paths("Explique /skill-0", catalog) == ()
    assert requested_skill_paths("https://example.com/skill-0", catalog) == ()
    assert requested_skill_paths("/skill-0 /skill-0", catalog) == (catalog[0]["path"],)


@pytest.mark.parametrize("async_mode", [False, True])
def test_skill_body_enters_only_through_native_read_result(
    monkeypatch, tmp_path, async_mode
):
    snapshot, filesystem, skills = skill_stack(monkeypatch, tmp_path)
    body = snapshot["/document-planning/SKILL.md"]
    requests = []

    class Capture(AgentMiddleware):
        def wrap_model_call(self, request, handler):
            requests.append(request)
            return handler(request)

        async def awrap_model_call(self, request, handler):
            requests.append(request)
            return await handler(request)

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    responses = [
        AIMessage(
            content="",
            tool_calls=[
                {"name": "read_file", "args": {"file_path": SKILL_PATH}, "id": "read"}
            ],
        ),
        AIMessage(content="Méthode consultée."),
    ]
    graph = create_agent(
        Model(messages=iter(responses * 2)),
        middleware=[
            ToolkitMiddleware(),
            filesystem,
            skills,
            ContextBuilderMiddleware(),
            Capture(),
        ],
        context_schema=AgentContext,
    )
    # A subsequent short turn must not assume the previous invocation's tool results persisted.
    for question in ("/document-planning Aide-moi.", "vas-y"):
        context = AgentContext(attachment_paths=())
        state = {"messages": [HumanMessage(question)]}
        result = (
            asyncio.run(graph.ainvoke(state, context=context))
            if async_mode
            else graph.invoke(state, context=context)
        )
        first, second = requests[-2:]
        assert (
            body not in first.system_message.text
            and body not in second.system_message.text
        )
        assert SKILL_PATH in first.system_message.text
        assert not any(isinstance(m, ToolMessage) for m in first.messages)
        assert any(
            isinstance(m, ToolMessage) and "même" in m.text for m in second.messages
        )
        assert [m.name for m in result["messages"] if isinstance(m, ToolMessage)] == [
            "read_file"
        ]
        assert context.stats.skill_reads == 1
        assert context.stats.skill_read_tokens_approx > 0
        assert context.stats.first_result_ms is None  # File I/O is preparation.


def test_attachment_and_slash_requests_reference_paths_without_loading_bodies(
    monkeypatch, tmp_path
):
    snapshot, _, skills = skill_stack(monkeypatch, tmp_path)
    context = AgentContext(attachment_paths=("/attachments/plan.md",))
    update = skills.before_agent(
        {"messages": [HumanMessage("vas-y")]}, SimpleNamespace(context=context), {}
    )
    prompt = system_skills_section(update, context)
    assert (
        "Avant de traiter cette demande, lis avec read_file : " + SKILL_PATH in prompt
    )
    assert snapshot["/document-planning/SKILL.md"] not in prompt
    other = AgentContext()
    skills.before_agent(
        {"messages": [HumanMessage("/document-planning Lis.")]},
        SimpleNamespace(context=other),
        {},
    )
    assert other.requested_skills == (SKILL_PATH,)
    assert context.requested_skills == ()
