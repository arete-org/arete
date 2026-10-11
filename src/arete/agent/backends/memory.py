"""Deep Agents filesystem adapter, restricted to the coaching ledger."""

from typing import Literal

from deepagents.backends import CompositeBackend, StateBackend
from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    FileUploadResponse,
    WriteResult,
)
from deepagents.backends.utils import create_file_data
from deepagents.middleware.filesystem import (
    FilesystemMiddleware,
    FilesystemPermission,
    GlobSchema,
    GrepSchema,
    ReadFileSchema,
)
from pydantic import BaseModel, Field

from arete.agent.backends.attachments import ATTACHMENTS_ROUTE
from arete.agent.backends.skills import SYSTEM_SKILLS_ROUTE, SystemSkillsBackend
from arete.services.memory import (
    NOTES_LEDGER,
    SESSIONS_LEDGER,
    delete_file,
    edit_file,
    list_files,
)

# Permissions default to allow in Deep Agents: the trailing deny is essential.
MEMORY_PERMISSIONS = [
    FilesystemPermission(operations=["write"], paths=["/skills/**"], mode="deny"),
    FilesystemPermission(
        operations=["write"],
        paths=[f"/{NOTES_LEDGER}", f"/{SESSIONS_LEDGER}"],
        mode="allow",
    ),
    FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
]


LEDGER_TOOL_DESCRIPTIONS = {
    "read_file": "Lit un fichier du journal: sessions.md, notes.md ou une "
    "archive mensuelle sessions-AAAA-MM.md. 100 lignes par défaut; offset et "
    "limit pour paginer. Dans sessions.md les entrées récentes sont à la fin: "
    "lis la fin du fichier pour les trouver. Les lignes arrivent numérotées, "
    "ne recopie jamais ces numéros.",
    "edit_file": "Corrige ou retire un passage de /notes.md ou /sessions.md. "
    "old_string doit correspondre exactement au texte existant, sans numéros "
    "de ligne; new_string vide retire le passage. Préserve les autres entrées "
    "et leurs dates. Pour une nouvelle entrée, utilise append_journal.",
    "delete": "Supprime entièrement /notes.md ou /sessions.md uniquement "
    "si tout son contenu doit être oublié. Pour retirer un passage, utilise "
    "edit_file. Les archives et les pièces jointes restent en lecture seule.",
}


class LedgerBackend(StateBackend):
    """Native search/read semantics over authoritative DB content, never graph files."""

    def __init__(self):
        pass

    def _read_files(self):
        return {"/" + f.name: create_file_data(f.content) for f in list_files()}

    def _send_files_update(self, update):
        raise PermissionError("permission denied: use the journal service")

    def edit(self, file_path, old_string, new_string, replace_all=False) -> EditResult:
        try:
            count = edit_file(file_path, old_string, new_string, replace_all)
            return EditResult(path=file_path, occurrences=count)
        except (ValueError, PermissionError) as exc:
            return EditResult(error=str(exc))

    def delete(self, file_path: str) -> DeleteResult:
        try:
            delete_file(file_path)
            return DeleteResult(path=file_path)
        except (ValueError, PermissionError) as exc:
            return DeleteResult(error=str(exc))

    def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error="permission denied: use append_journal")

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [FileUploadResponse(path=p, error="permission_denied") for p, _ in files]


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


def build_memory_filesystem(
    *, system_skills: SystemSkillsBackend | None = None
) -> FilesystemMiddleware:
    """Editable current ledgers and read-only archives/invocation documents."""
    middleware = FilesystemMiddleware(
        backend=CompositeBackend(
            default=LedgerBackend(),
            routes={
                ATTACHMENTS_ROUTE: StateBackend(),
                **({SYSTEM_SKILLS_ROUTE: system_skills} if system_skills else {}),
            },
        ),
        tools=["read_file", "ls", "glob", "grep", "edit_file", "delete"],
        custom_tool_descriptions={
            **LEDGER_TOOL_DESCRIPTIONS,
            "read_file": LEDGER_TOOL_DESCRIPTIONS["read_file"]
            + " Lis aussi les documents normalisés sous /attachments/ et les skills sous /skills/system/. Maximum 200 lignes par appel ; conserve les références de source.",
        },
        tool_token_limit_before_evict=None,
        human_message_token_limit_before_evict=None,
        grep_max_count=100,
        _permissions=MEMORY_PERMISSIONS,
    )
    # Some free providers reject anyOf/null; adapt schemas without forking tools.
    schemas: dict[str, type[BaseModel]] = {
        "glob": PortableGlob,
        "grep": PortableGrep,
        "read_file": BoundedRead,
    }
    for tool in middleware.tools:
        if tool.name in schemas:
            tool.args_schema = schemas[tool.name]
    return middleware
