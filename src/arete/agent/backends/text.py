"""Read-only text snapshots through Deep Agents' public backend protocol."""

from abc import abstractmethod

from deepagents.backends.protocol import (
    BackendProtocol,
    DeleteResult,
    EditResult,
    FileData,
    FileDownloadResponse,
    FileInfo,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from deepagents.backends.utils import (
    compile_grep_include_glob,
    file_data_to_string,
    grep_matches_from_files,
    slice_read_response,
    validate_path,
)

MAX_TEXT_FILES = 1_000
MAX_TEXT_BYTES = 20 * 1024 * 1024
MAX_TRANSFER_FILES = 1_000
DENIED = "permission denied: this backend is read-only"


class ReadOnlyTextBackend(BackendProtocol):
    """Share public read/search semantics without borrowing StateBackend internals.

    Sources return a fresh bounded snapshot; graph state never shadows its data.
    The protocol supplies async workers with context propagation for sync methods.
    """

    @abstractmethod
    def files(self) -> dict[str, FileData]:
        """Return absolute virtual paths and UTF-8 text, never local disk paths."""

    def _snapshot(self) -> dict[str, FileData]:
        files = self.files()
        if len(files) > MAX_TEXT_FILES:
            raise ValueError("Text backend file limit exceeded")
        if (
            sum(len(file_data_to_string(f).encode()) for f in files.values())
            > MAX_TEXT_BYTES
        ):
            raise ValueError("Text backend byte limit exceeded")
        return files

    @staticmethod
    def _info(path: str, data: FileData) -> FileInfo:
        return FileInfo(
            path=path,
            is_dir=False,
            size=len(file_data_to_string(data).encode()),
            modified_at=data.get("modified_at", ""),
        )

    def ls(self, path: str) -> LsResult:
        try:
            prefix = validate_path(path).rstrip("/") + "/"
        except ValueError as exc:
            return LsResult(error=str(exc))
        entries: dict[str, FileInfo] = {}
        for name, data in self._snapshot().items():
            if not name.startswith(prefix):
                continue
            relative = name[len(prefix) :]
            if "/" in relative:
                directory = prefix + relative.split("/", 1)[0] + "/"
                entries[directory] = FileInfo(path=directory, is_dir=True, size=0)
            else:
                entries[name] = self._info(name, data)
        return LsResult(entries=[entries[name] for name in sorted(entries)])

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        try:
            path = validate_path(file_path)
        except ValueError as exc:
            return ReadResult(error=str(exc))
        data = self._snapshot().get(path)
        if data is None:
            return ReadResult(error=f"File '{path}' not found")
        return slice_read_response(data, offset, limit)

    def grep(self, pattern, path=None, glob=None, *, max_count=None) -> GrepResult:
        return grep_matches_from_files(
            self._snapshot(), pattern, path or "/", glob, max_count=max_count
        )

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        try:
            root = validate_path(path or "/").rstrip("/")
            # Anchor the shared native matcher: *.md is one directory, **/*.md recurses.
            matches = compile_grep_include_glob("/" + pattern.lstrip("/"))
        except ValueError as exc:
            return GlobResult(error=str(exc))
        entries = []
        for name, data in self._snapshot().items():
            if name == root:
                relative = name.rsplit("/", 1)[-1]
            elif name.startswith(root + "/"):
                relative = name[len(root) + 1 :]
            else:
                continue
            if matches(relative):
                entries.append(self._info(name, data))
        return GlobResult(matches=sorted(entries, key=lambda entry: entry["path"]))

    def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error=DENIED)

    def edit(self, file_path, old_string, new_string, replace_all=False) -> EditResult:
        return EditResult(error=DENIED)

    def delete(self, file_path: str) -> DeleteResult:
        return DeleteResult(error=DENIED)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        if len(files) > MAX_TRANSFER_FILES:
            raise ValueError("Text backend transfer limit exceeded")
        return [
            FileUploadResponse(path=path, error="permission_denied")
            for path, _ in files
        ]

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        if len(paths) > MAX_TRANSFER_FILES:
            raise ValueError("Text backend transfer limit exceeded")
        files = self._snapshot()
        return [
            FileDownloadResponse(
                path=path, content=file_data_to_string(files[path]).encode()
            )
            if path in files
            else FileDownloadResponse(path=path, error="file_not_found")
            for path in paths
        ]
