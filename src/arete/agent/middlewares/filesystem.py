"""Configure native filesystem tools over any Deep Agents backend."""

from collections.abc import Mapping
from typing import Literal

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.filesystem import (
    FilesystemMiddleware,
    FilesystemPermission,
    GlobSchema,
    GrepSchema,
    ReadFileSchema,
)
from pydantic import BaseModel, Field


class PortableGlob(GlobSchema):
    path: str = "/"


class PortableGrep(GrepSchema):
    path: str = "/"
    glob: str = "**/*"
    # A filename alone wastes a model round when the attachment path is known.
    output_mode: Literal["files_with_matches", "content", "count"] = Field(
        default="content",
        description="Matching lines by default, with file and line numbers.",
    )
    max_count: int = Field(default=100, ge=1, le=100)


class BoundedRead(ReadFileSchema):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=200)


def build_filesystem_middleware(
    backend: BackendProtocol,
    *,
    permissions: list[FilesystemPermission],
    tool_descriptions: Mapping[str, str] | None = None,
    offload_tool_results: bool = True,
) -> FilesystemMiddleware:
    """Keep framework execution; only request bounds and schemas are app-specific."""
    middleware = FilesystemMiddleware(
        backend=backend,
        tools=["read_file", "ls", "glob", "grep", "edit_file", "delete"],
        custom_tool_descriptions=tool_descriptions,
        tool_token_limit_before_evict=(20_000 if offload_tool_results else None),
        human_message_token_limit_before_evict=50_000 if offload_tool_results else None,
        grep_max_count=100,
        # Use the public permission API; deny rules also remain enforced by backends.
        permissions=permissions,
    )
    schemas: dict[str, type[BaseModel]] = {
        "glob": PortableGlob,
        "grep": PortableGrep,
        "read_file": BoundedRead,
    }
    for tool in middleware.tools:
        if tool.name in schemas:
            tool.args_schema = schemas[tool.name]
    return middleware
