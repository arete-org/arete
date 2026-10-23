"""Ledger operations and permissions; archives, attachments and skills are read-only."""

from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    WriteResult,
)
from deepagents.backends.utils import create_file_data
from deepagents.middleware.filesystem import FilesystemPermission

from arete.agent.backends.text import ReadOnlyTextBackend
from arete.services.memory import (
    NOTES_LEDGER,
    PROFILE_LEDGER,
    SESSIONS_LEDGER,
    delete_file,
    edit_file,
    list_files,
)

MEMORIES_ROUTE = "/memories/"

# Permissions default to allow in Deep Agents: the trailing deny is essential.
JOURNAL_PERMISSIONS = [
    FilesystemPermission(operations=["write"], paths=["/skills/**"], mode="deny"),
    FilesystemPermission(
        operations=["write"],
        paths=[
            f"{MEMORIES_ROUTE}{name}"
            for name in (PROFILE_LEDGER, NOTES_LEDGER, SESSIONS_LEDGER)
        ],
        mode="allow",
    ),
    FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
]


LEDGER_TOOL_DESCRIPTIONS = {
    "read_file": "Lit les fichiers du journal, des pièces jointes et des skills. "
    "Dans /memories/, le journal contient profile.md, sessions.md, notes.md ou une "
    "archive mensuelle sessions-AAAA-MM.md. 100 lignes par défaut; offset et "
    "limit pour paginer. Dans sessions.md les entrées récentes sont à la fin: "
    "lis la fin du fichier pour les trouver. Les lignes arrivent numérotées, "
    "ne recopie jamais ces numéros.",
    "edit_file": "Corrige ou retire un passage de /memories/profile.md, /memories/notes.md ou /memories/sessions.md. "
    "old_string doit correspondre exactement au texte existant, sans numéros "
    "de ligne; new_string vide retire le passage. Préserve les autres entrées "
    "et leurs dates. Pour une nouvelle entrée, utilise append_journal.",
    "delete": "Supprime entièrement /memories/profile.md, /memories/notes.md ou /memories/sessions.md uniquement "
    "si tout son contenu doit être oublié. Pour retirer un passage, utilise "
    "edit_file. Les archives et les pièces jointes restent en lecture seule.",
}


class LedgerBackend(ReadOnlyTextBackend):
    """Native search/read semantics over authoritative DB content, never graph files."""

    def files(self):
        return {"/" + f.name: create_file_data(f.content) for f in list_files()}

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
