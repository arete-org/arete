"""Split the selected test files across parallel CI jobs, each file whole.

A file stays in one shard: its module fixtures and test order hold, as with
xdist's ``--dist loadfile`` inside the shard. Shards are balanced on measured
per-file durations (``test_durations.json``, seconds on a developer machine,
only their ratios matter); a file missing from the table weighs the median.
Refresh the table when the shards drift apart (see ``main``).
"""

import argparse
import json
import statistics
import xml.etree.ElementTree as ElementTree
from pathlib import Path

DURATIONS = Path(__file__).with_name("test_durations.json")
MAX_SHARDS = 8


def parse_shard(value: str) -> tuple[int, int]:
    """``"2/3"`` -> ``(2, 3)``: the second of three shards, counted from 1."""
    index, _, count = value.partition("/")
    shard = (int(index), int(count))
    if not 1 <= shard[0] <= shard[1] <= MAX_SHARDS:
        raise ValueError(f"Shard must be K/N with 1 <= K <= N <= {MAX_SHARDS}")
    return shard


def expand_files(paths: list[str], root: Path) -> list[str]:
    """The plan's pytest paths as files: ``tests/`` expands to every test file."""
    files: set[str] = set()
    for path in paths:
        target = root / path
        if target.is_dir():
            files.update(
                p.relative_to(root).as_posix() for p in target.rglob("test_*.py")
            )
        else:
            files.add(path)
    return sorted(files)


def assign(
    files: list[str], count: int, durations: dict[str, float]
) -> list[list[str]]:
    """Longest files first, each to the lightest shard; deterministic."""
    default = statistics.median(durations.values()) if durations else 1.0
    weight = {f: durations.get(f, default) for f in files}
    shards: list[list[str]] = [[] for _ in range(count)]
    loads = [0.0] * count
    for f in sorted(files, key=lambda f: (-weight[f], f)):
        lightest = min(range(count), key=lambda i: (loads[i], i))
        shards[lightest].append(f)
        loads[lightest] += weight[f]
    return [sorted(shard) for shard in shards]


def shard_files(paths: list[str], shard: tuple[int, int], root: Path) -> list[str]:
    durations = json.loads(DURATIONS.read_text()) if DURATIONS.exists() else {}
    index, count = shard
    return assign(expand_files(paths, root), count, durations)[index - 1]


def durations_from_junit(report: Path) -> dict[str, float]:
    """Seconds per test file from a pytest ``--junitxml`` report."""
    totals: dict[str, float] = {}
    for case in ElementTree.parse(report).iter("testcase"):
        module = case.get("classname", "").split(".")
        # classname is ``tests.test_x`` or ``tests.test_x.TestClass``.
        name = next((m for m in module if m.startswith("test_")), None)
        if module[:1] == ["tests"] and name:
            path = f"tests/{name}.py"
            totals[path] = totals.get(path, 0.0) + float(case.get("time") or 0)
    return {path: round(seconds, 1) for path, seconds in sorted(totals.items())}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "junit",
        type=Path,
        help="report of `pytest tests -n 2 --dist loadfile --junitxml=REPORT`",
    )
    args = parser.parse_args()
    DURATIONS.write_text(json.dumps(durations_from_junit(args.junit), indent=1) + "\n")


if __name__ == "__main__":
    main()
