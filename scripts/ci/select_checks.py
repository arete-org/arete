"""Route CI by changed paths; unknown surfaces deliberately run every check."""

import argparse
import json
import subprocess
from pathlib import Path

CHECKS = frozenset({"backend", "frontend", "transport", "preview"})
MAX_CHANGED_FILES = 10_000
GIT_TIMEOUT_SECONDS = 30
DOC_FILES = frozenset({"README.md", "AGENTS.md", "CLAUDE.md", "LICENSE"})
FRONTEND_TEST_CONFIGS = frozenset(
    {"frontend/playwright.config.ts", "frontend/vitest.config.ts"}
)


def select_checks(paths: list[str]) -> set[str]:
    if len(paths) > MAX_CHANGED_FILES:
        raise ValueError(f"CI diff exceeds {MAX_CHANGED_FILES} files")
    selected: set[str] = set()
    for path in paths:
        if path in DOC_FILES or path.startswith(("docs/", "openwiki/")):
            continue
        if path.startswith("src/"):
            selected.update(("backend", "preview"))
            # The browser imports this service-owned contract at build time.
            if path == "src/arete/services/chart_contract.json":
                selected.add("frontend")
        elif path.startswith("tests/"):
            selected.add("backend")
        elif path.startswith("frontend/"):
            selected.add("frontend")
            # Test-only edits need the complete UI gate, but do not change the
            # deployed application and need no remote build or preview comment.
            if not (
                path.startswith("frontend/browser-tests/")
                or path.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
                or path in FRONTEND_TEST_CONFIGS
            ):
                selected.add("preview")
        elif (
            path.startswith(("scripts/ci/", ".github/", ".githooks/"))
            or path == "Makefile"
        ):
            selected.update(CHECKS - {"preview"})
        elif path.startswith("scripts/openwiki/"):
            selected.add("transport")
        else:
            # Build inputs, CI policy, dependencies and new directories must
            # never silently bypass verification because a mapping is missing.
            selected.update(CHECKS)
    return selected


def git_output(*args: str) -> bytes:
    return subprocess.run(
        ["git", *args], check=True, stdout=subprocess.PIPE, timeout=GIT_TIMEOUT_SECONDS
    ).stdout


def changed_paths(base: str, *, worktree: bool = False) -> list[str]:
    # No rename detection: moving code to docs must retain its deleted path.
    refs = [base] if worktree else [base, "HEAD"]
    paths = (
        git_output("diff", "--name-only", "--no-renames", "-z", *refs, "--")
        .decode()
        .split("\0")[:-1]
    )
    if worktree:
        paths += (
            git_output("ls-files", "--others", "--exclude-standard", "-z")
            .decode()
            .split("\0")[:-1]
        )
    return sorted(set(paths))


def build_plan(
    paths: list[str], *, base: str = "", full: bool = False, full_tests: bool = False
) -> dict:
    from affected_tests import affected_tests

    selected = CHECKS if full else select_checks(paths)
    tests, reason = [], "no backend changes"
    if "backend" in selected:
        if full or full_tests:
            tests, reason = ["tests/"], "full verification (main or manual run)"
        else:
            tests, reason = affected_tests(paths, Path.cwd())
    return {
        **{check: check in selected for check in sorted(CHECKS)},
        "base": base,
        "head": git_output("rev-parse", "HEAD").decode().strip(),
        "changed_paths": paths,
        "pytest_paths": tests,
        "pytest_reason": reason,
    }


def render_summary(plan: dict) -> str:
    checks = (
        ", ".join(check for check in sorted(CHECKS) if plan[check]) or "policy only"
    )
    return "\n".join(
        [
            "## Affected checks",
            f"Base: `{plan['base'] or 'full run'}`; HEAD: `{plan['head']}`",
            f"Checks: **{checks}**",
            f"Pytest: {plan['pytest_reason']}",
            f"Selected test files: {len(plan['pytest_paths'])} (tests/ = full suite)",
            "```json",
            json.dumps(
                {"changed": plan["changed_paths"], "pytest": plan["pytest_paths"]},
                indent=2,
            ),
            "```",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--base")
    mode.add_argument("--all", action="store_true")
    parser.add_argument("--full-tests", action="store_true")
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    paths = [] if args.all else changed_paths(args.base)
    # The lightweight boolean API is also used by deployment guards.
    selected = CHECKS if args.all else select_checks(paths)
    if args.plan or args.summary:
        plan = build_plan(
            paths, base=args.base or "", full=args.all, full_tests=args.full_tests
        )
        if args.plan:
            args.plan.parent.mkdir(parents=True, exist_ok=True)
            args.plan.write_text(json.dumps(plan, indent=2) + "\n")
        if args.summary:
            with args.summary.open("a") as output:
                output.write(render_summary(plan) + "\n")
    for check in sorted(CHECKS):
        print(f"{check}={str(check in selected).lower()}")


if __name__ == "__main__":
    main()
