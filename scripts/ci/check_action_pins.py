"""Fail on a remote GitHub Action not pinned to its full commit SHA."""

import argparse
import re
from pathlib import Path

MAX_WORKFLOW_FILES = 200
MAX_LINES_PER_FILE = 5_000
USES_PATTERN = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)")
SHA_PINNED = re.compile(r"^[^@]+@[0-9a-f]{40}(\s+#.*)?$")

# Local actions (./...) and container actions (docker://...) are not fetched
# from a mutable ref, so pinning does not apply.
OUT_OF_SCOPE = ("./", "docker://")


def find_unpinned_uses(path: Path) -> list[tuple[int, str]]:
    lines = path.read_text().splitlines()
    if len(lines) > MAX_LINES_PER_FILE:
        raise ValueError(f"{path}: exceeds {MAX_LINES_PER_FILE} lines")
    violations = []
    for line_number, line in enumerate(lines, start=1):
        match = USES_PATTERN.match(line)
        if not match:
            continue
        reference = match.group(1)
        if reference.startswith(OUT_OF_SCOPE):
            continue
        if SHA_PINNED.match(reference):
            continue
        violations.append((line_number, line.strip()))
    return violations


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflows-dir", type=Path, default=Path(".github/workflows"))
    args = parser.parse_args()
    workflow_files = sorted(args.workflows_dir.glob("*.yml"))
    if len(workflow_files) > MAX_WORKFLOW_FILES:
        raise ValueError(f"{args.workflows_dir}: exceeds {MAX_WORKFLOW_FILES} files")
    failures = []
    for path in workflow_files:
        for line_number, line in find_unpinned_uses(path):
            failures.append(f"{path}:{line_number}: not pinned to a commit SHA: {line}")
    for failure in failures:
        print(failure)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
