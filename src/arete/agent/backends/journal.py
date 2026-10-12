"""Ledger operations and permissions; archives, attachments and skills are read-only."""

from deepagents.backends import CompositeBackend, StateBackend
from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    FileUploadResponse,
    WriteResult,
)
from deepagents.backends.utils import create_file_data
from deepagents.middleware.filesystem import FilesystemPermission

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
JOURNAL_PERMISSIONS = [
    FilesystemPermission(operations=["write"], paths=["/skills/**"], mode="deny"),
    FilesystemPermission(
        operations=["write"],
        paths=[f"/{NOTES_LEDGER}", f"/{SESSIONS_LEDGER}"],
        mode="allow",
    ),
    FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
]


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


def build_journal_backend(
    *, system_skills: SystemSkillsBackend | None = None
) -> CompositeBackend:
    return CompositeBackend(
        default=LedgerBackend(),
        routes={
            ATTACHMENTS_ROUTE: StateBackend(),
            **({SYSTEM_SKILLS_ROUTE: system_skills} if system_skills else {}),
        },
    )
