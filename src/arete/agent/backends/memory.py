"""Deep Agents filesystem adapter, restricted to the coaching ledger."""

from typing import Literal

from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from deepagents.backends.protocol import DeleteResult, EditResult
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
    ledger_lock,
    memory_root,
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


class LedgerBackend(FilesystemBackend):
    """Serialize corrections with appends so concurrent turns cannot lose entries."""

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        with ledger_lock():
            return super().edit(file_path, old_string, new_string, replace_all)

    def delete(self, file_path: str) -> DeleteResult:
        with ledger_lock():
            return super().delete(file_path)


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
    root = memory_root()
    with ledger_lock():  # a ledger write: serialized, and flushed by the mirror
        for name in (SESSIONS_LEDGER, NOTES_LEDGER):
            (root / name).touch(exist_ok=True)
    middleware = FilesystemMiddleware(
        backend=CompositeBackend(
            default=LedgerBackend(root_dir=root, virtual_mode=True, max_file_size_mb=5),
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
