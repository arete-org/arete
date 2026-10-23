"""Generic filesystem composition and the public text backend contract."""

import asyncio
from contextvars import ContextVar

import pytest
from deepagents.backends import StateBackend
from deepagents.backends.utils import create_file_data
from deepagents.middleware.filesystem import FilesystemMiddleware
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, ToolMessage

from arete.agent.backends.skills import SystemSkillsBackend
from arete.agent.backends.text import ReadOnlyTextBackend
from arete.agent.middlewares.filesystem import build_filesystem_middleware


@pytest.mark.parametrize("async_mode", [False, True])
def test_native_middleware_accepts_a_backend_without_journal_dependencies(async_mode):
    filesystem = build_filesystem_middleware(StateBackend(), permissions=[])
    assert type(filesystem) is FilesystemMiddleware

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    model = Model(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "edit_file",
                            "id": "edit",
                            "args": {
                                "file_path": "/project.md",
                                "old_string": "old",
                                "new_string": "new",
                            },
                        }
                    ],
                ),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "id": "read",
                            "args": {"file_path": "/project.md"},
                        }
                    ],
                ),
                AIMessage(content="Done"),
            ]
        )
    )
    graph = create_agent(model, middleware=[filesystem])
    state = {
        "messages": [{"role": "user", "content": "Edit the file"}],
        "files": {"/project.md": create_file_data("old")},
    }
    config = {"recursion_limit": 10}
    result = (
        asyncio.run(graph.ainvoke(state, config))
        if async_mode
        else graph.invoke(state, config)
    )
    messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert all(m.status == "success" for m in messages)
    assert "new" in messages[-1].content
    assert result["files"]["/project.md"]["content"] == "new"
    assert "append_journal" not in {tool.name for tool in filesystem.tools}


def test_text_backend_returns_native_pagination_search_and_transfer_results():
    backend = SystemSkillsBackend(
        {
            "/root.md": "line one\nliteral .*\nline three",
            "/nested/child.md": "literal .*",
            "/nested/deeper/leaf.txt": "leaf",
        }
    )
    assert [(f["path"], f["is_dir"]) for f in backend.ls("/").entries] == [
        ("/nested/", True),
        ("/root.md", False),
    ]
    assert [f["path"] for f in backend.glob("*.md").matches] == ["/root.md"]
    assert [f["path"] for f in backend.glob("**/*.md").matches] == [
        "/nested/child.md",
        "/root.md",
    ]
    assert [f["path"] for f in backend.glob("*.md", "/nested").matches] == [
        "/nested/child.md"
    ]
    assert [f["path"] for f in backend.glob("*.md", "/root.md").matches] == ["/root.md"]
    page = backend.read("/root.md", offset=1, limit=1)
    assert page.file_data["content"] == "literal .*\n"
    assert page.start_line == 2
    assert backend.read("/missing").error
    assert backend.read("/../root.md").error
    assert backend.ls("/../").error
    assert backend.glob("*", "/../").error
    matches = backend.grep(".*", glob="*.md", max_count=1)
    assert len(matches.matches) == 1 and matches.truncated
    assert matches.matches[0]["text"] == "literal .*"
    files = backend.download_files(["/root.md", "/missing"])
    assert files[0].content == b"line one\nliteral .*\nline three"
    assert files[1].error == "file_not_found"
    assert backend.write("/root.md", "bad").error
    assert backend.edit("/root.md", "line", "bad").error
    assert backend.delete("/root.md").error
    assert backend.upload_files([("/root.md", b"bad")])[0].error == "permission_denied"
    assert backend.read("/root.md").file_data["content"].startswith("line one")


def test_async_protocol_preserves_invocation_scope_across_shared_backend():
    scope = ContextVar("filesystem_test_scope")

    class ScopedBackend(ReadOnlyTextBackend):
        def files(self):
            return {"/notes.md": create_file_data(scope.get())}

    backend = ScopedBackend()

    async def read(value):
        token = scope.set(value)
        try:
            return await backend.aread("/notes.md")
        finally:
            scope.reset(token)

    async def run():
        return await asyncio.gather(read("athlete one"), read("athlete two"))

    results = asyncio.run(run())
    assert [r.file_data["content"] for r in results] == ["athlete one", "athlete two"]


def test_failed_storage_and_exceeded_bounds_never_appear_as_empty_files(monkeypatch):
    class UnavailableBackend(ReadOnlyTextBackend):
        def files(self):
            raise OSError("storage unavailable")

    with pytest.raises(OSError, match="storage unavailable"):
        UnavailableBackend().ls("/")
    backend = SystemSkillsBackend({"/a.md": "content"})
    monkeypatch.setattr("arete.agent.backends.text.MAX_TEXT_FILES", 0)
    with pytest.raises(ValueError, match="file limit"):
        backend.glob("*")
