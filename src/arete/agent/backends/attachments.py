"""Hydrate attachments into the native state's public filesystem paths."""

from deepagents.backends.protocol import FileData
from deepagents.backends.utils import create_file_data

ATTACHMENTS_ROUTE = "/attachments/"


def attachment_key(path: str) -> str:
    assert path.startswith(ATTACHMENTS_ROUTE), "Attachment outside its mount"
    return path


def attachment_files(files: dict[str, str]) -> dict[str, FileData]:
    # The default StateBackend owns attachments and ephemeral harness artifacts.
    return {
        attachment_key(path): create_file_data(text) for path, text in files.items()
    }
