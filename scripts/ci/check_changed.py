"""Show or run the same affected checks locally as on a pull request."""

import argparse
import json
import subprocess
from pathlib import Path

from select_checks import build_plan, changed_paths, git_output, render_summary
from shard_tests import parse_shard, shard_files

# Below the test job's 25-minute timeout (ci.yml), leaving room for setup.
CHECK_TIMEOUT_SECONDS = 1320


def run_plan(
    plan: dict, *, tests_only: bool = False, shard: tuple[int, int] | None = None
) -> None:
    commands = []
    if not tests_only:
        commands.append(
            [
                "python3",
                "-m",
                "unittest",
                "discover",
                "-s",
                "scripts/ci",
                "-p",
                "test_*.py",
            ]
        )
    if plan["backend"]:
        if not tests_only:
            commands.extend(
                [
                    ["uv", "run", "ruff", "check", "src", "tests", "scripts/ci"],
                    [
                        "uv",
                        "run",
                        "ruff",
                        "format",
                        "--check",
                        "src",
                        "tests",
                        "scripts/ci",
                    ],
                    ["uv", "run", "mypy", "src/arete"],
                ]
            )
        paths = plan["pytest_paths"]
        if not paths or any(
            not p.startswith("tests/") or ".." in Path(p).parts for p in paths
        ):
            raise ValueError("Backend plan requires explicit pytest paths under tests/")
        if shard:
            paths = shard_files(paths, shard, Path.cwd())
            print(f"Shard {shard[0]}/{shard[1]}: {len(paths)} test files", flush=True)
        # An empty shard runs nothing: pytest without paths would run them all.
        if paths:
            commands.append(
                [
                    "uv",
                    "run",
                    "pytest",
                    *paths,
                    "--tb=short",
                    "-n",
                    "2",
                    "--dist",
                    "loadfile",
                    "--max-worker-restart=0",
                    "--durations=20",
                ]
            )
    if not tests_only:
        if plan["transport"]:
            commands.append(["node", "--test", "scripts/openwiki/transport.test.mjs"])
        if plan["frontend"]:
            commands.extend(
                [
                    ["npm", "--prefix", "frontend", "run", task]
                    for task in ("lint", "test", "build", "test:browser")
                ]
            )
    for command in commands:
        print("+ " + " ".join(command), flush=True)
        subprocess.run(command, check=True, timeout=CHECK_TIMEOUT_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--tests-only", action="store_true")
    parser.add_argument("--shard", type=parse_shard, help="K/N: run one CI shard")
    parser.add_argument(
        "--count-only",
        action="store_true",
        help="with --plan and --shard: print `files=<n>` for GITHUB_OUTPUT",
    )
    args = parser.parse_args()
    if args.plan:
        plan = json.loads(args.plan.read_text())
        head = git_output("rev-parse", "HEAD").decode().strip()
        if plan["head"] != head:
            raise ValueError("CI plan belongs to another commit")
        if args.count_only:
            if not args.shard:
                raise ValueError("--count-only needs --shard")
            paths = plan["pytest_paths"] if plan["backend"] else []
            print(f"files={len(shard_files(paths, args.shard, Path.cwd()))}")
            return
    else:
        base = git_output("merge-base", args.base, "HEAD").decode().strip()
        paths = changed_paths(base, worktree=True)
        plan = build_plan(paths, base=base)
    print(render_summary(plan), flush=True)
    if args.run:
        run_plan(plan, tests_only=args.tests_only, shard=args.shard)


if __name__ == "__main__":
    main()
