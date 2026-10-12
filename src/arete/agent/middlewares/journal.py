"""Native journal tools for notes.md and sessions.md, with read-only source mounts."""

from typing import Literal

from deepagents.middleware.filesystem import (
    FilesystemMiddleware,
    GlobSchema,
    GrepSchema,
    ReadFileSchema,
)
from pydantic import BaseModel, Field

from arete.agent.backends.journal import JOURNAL_PERMISSIONS, build_journal_backend
from arete.agent.backends.skills import SystemSkillsBackend
from arete.agent.tools.journal import append_journal

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


class JournalMiddleware(FilesystemMiddleware):
    """Register journal operations once; persistence remains in services.memory."""

    def __init__(self, *, system_skills: SystemSkillsBackend | None = None):
        super().__init__(
            backend=build_journal_backend(system_skills=system_skills),
            tools=["read_file", "ls", "glob", "grep", "edit_file", "delete"],
            custom_tool_descriptions={
                **LEDGER_TOOL_DESCRIPTIONS,
                "read_file": LEDGER_TOOL_DESCRIPTIONS["read_file"]
                + " Lis aussi les documents normalisés sous /attachments/ et les skills sous /skills/system/. Maximum 200 lignes par appel ; conserve les références de source.",
            },
            tool_token_limit_before_evict=None,
            human_message_token_limit_before_evict=None,
            grep_max_count=100,
            _permissions=JOURNAL_PERMISSIONS,
        )
        # Keep native execution and provider-portable schemas, not copied tools.
        schemas: dict[str, type[BaseModel]] = {
            "glob": PortableGlob,
            "grep": PortableGrep,
            "read_file": BoundedRead,
        }
        for tool in self.tools:
            if tool.name in schemas:
                tool.args_schema = schemas[tool.name]
        self.tools = [*self.tools, append_journal]
