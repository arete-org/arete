"""Read-only published skills, independent of client-supplied graph files."""

from deepagents.backends.protocol import FileData
from deepagents.backends.utils import create_file_data

from arete.agent.backends.text import ReadOnlyTextBackend

SYSTEM_SKILLS_ROUTE = "/skills/system/"


class SystemSkillsBackend(ReadOnlyTextBackend):
    def __init__(self, files: dict[str, str]):
        self._files = {path: create_file_data(text) for path, text in files.items()}

    def files(self) -> dict[str, FileData]:
        return self._files
