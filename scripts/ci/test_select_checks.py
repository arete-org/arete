"""Keep path routing conservative, including deletions and failed diffs."""

import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from select_checks import (
    CHECKS,
    MAX_CHANGED_FILES,
    build_plan,
    changed_paths,
    main,
    select_checks,
)


class SelectionTests(unittest.TestCase):
    def test_docs_do_not_boot_application_checks(self):
        self.assertEqual(
            select_checks(
                ["README.md", "AGENTS.md", "docs/architecture.md", "openwiki/index.md"]
            ),
            set(),
        )

    def test_known_surfaces_select_complete_suites(self):
        cases = {
            "src/arete/api/agent.py": {"backend", "preview"},
            "src/arete/agent/prompts/instructions.md": {"backend", "preview"},
            "src/arete/services/chart_contract.json": {
                "backend",
                "frontend",
                "preview",
            },
            "tests/data/dictations.jsonl": {"backend"},
            "frontend/src/App.tsx": {"frontend", "preview"},
            "frontend/package-lock.json": {"frontend", "preview"},
            "frontend/browser-tests/documents.spec.ts": {"frontend"},
            "frontend/src/App.test.tsx": {"frontend"},
            "frontend/playwright.config.ts": {"frontend"},
            "scripts/openwiki/transport.mjs": {"transport"},
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(select_checks([path]), expected)

    def test_mixed_changes_preserve_every_affected_suite(self):
        self.assertEqual(
            select_checks(["tests/test_api.py", "frontend/src/App.tsx", "docs/a.md"]),
            {"backend", "frontend", "preview"},
        )

    def test_shared_and_unknown_inputs_run_everything(self):
        for path in (
            "pyproject.toml",
            "uv.lock",
            "asgi.py",
            "vercel.json",
            "new-package/code.py",
        ):
            with self.subTest(path=path):
                self.assertEqual(select_checks([path]), CHECKS)

    def test_tooling_runs_checks_without_deploying(self):
        for path in (
            "Makefile",
            ".github/workflows/ci.yml",
            "scripts/ci/select_checks.py",
        ):
            self.assertEqual(select_checks([path]), CHECKS - {"preview"})

    def test_large_diff_fails_instead_of_truncating(self):
        with self.assertRaises(ValueError):
            select_checks(["README.md"] * (MAX_CHANGED_FILES + 1))

    def test_diff_preserves_spaces_newlines_and_deleted_paths(self):
        paths = ["src/deleted.py", "docs/new name.md", "frontend/new\nname.ts"]
        result = subprocess.CompletedProcess([], 0, ("\0".join(paths) + "\0").encode())
        with patch("select_checks.subprocess.run", return_value=result):
            self.assertEqual(changed_paths("HEAD^1"), sorted(paths))

    def test_bad_base_and_timeout_never_publish_green_outputs(self):
        for error in (
            subprocess.CalledProcessError(128, "git diff"),
            subprocess.TimeoutExpired("git diff", 30),
        ):
            with self.subTest(error=error):
                output = io.StringIO()
                with (
                    patch("sys.argv", ["select_checks.py", "--base", "missing"]),
                    patch("select_checks.subprocess.run", side_effect=error),
                    contextlib.redirect_stdout(output),
                    self.assertRaises(type(error)),
                ):
                    main()
                self.assertEqual(output.getvalue(), "")

    def test_git_deletion_and_move_to_docs_still_select_original_suites(self):
        with contextlib.ExitStack() as stack:
            directory = stack.enter_context(tempfile.TemporaryDirectory())
            stack.callback(os.chdir, os.getcwd())
            os.chdir(directory)

            def git(*args):
                subprocess.run(
                    [
                        "git",
                        "-c",
                        "user.name=CI test",
                        "-c",
                        "user.email=ci@example.invalid",
                        "-c",
                        "commit.gpgsign=false",
                        *args,
                    ],
                    check=True,
                    capture_output=True,
                    timeout=10,
                )

            git("init")
            for name in ("src/removed.py", "frontend/moved.ts"):
                path = Path(name)
                path.parent.mkdir()
                path.write_text("original contents\n")
            git("add", "src/removed.py", "frontend/moved.ts")
            git("commit", "-m", "fixture base")
            Path("src/removed.py").unlink()
            Path("docs").mkdir()
            Path("frontend/moved.ts").rename("docs/moved.md")
            git("add", "src/removed.py", "frontend/moved.ts", "docs/moved.md")
            git("commit", "-m", "fixture changes")
            self.assertEqual(
                select_checks(changed_paths("HEAD^1")),
                {"backend", "frontend", "preview"},
            )

    def test_main_docs_stay_cheap_but_main_backend_runs_full_tests(self):
        with patch("select_checks.git_output", return_value=b"a" * 40):
            docs = build_plan(["README.md"], full_tests=True)
            self.assertFalse(docs["backend"])
            self.assertFalse(docs["preview"])
            self.assertEqual(docs["pytest_paths"], [])
            backend = build_plan(["src/arete/service.py"], full_tests=True)
            self.assertTrue(backend["preview"])
            self.assertEqual(backend["pytest_paths"], ["tests/"])

    def test_local_plan_includes_uncommitted_and_untracked_paths(self):
        with patch(
            "select_checks.git_output",
            side_effect=[b"src/edited.py\0tests/staged.py\0", b"tests/new.py\0"],
        ) as git:
            self.assertEqual(
                changed_paths("base", worktree=True),
                ["src/edited.py", "tests/new.py", "tests/staged.py"],
            )
        self.assertNotIn("HEAD", git.call_args_list[0].args)
        self.assertIn("--exclude-standard", git.call_args_list[1].args)

    def test_manual_runs_select_every_check_without_a_diff(self):
        output = io.StringIO()
        with (
            patch("sys.argv", ["select_checks.py", "--all"]),
            patch("select_checks.subprocess.run") as git,
            contextlib.redirect_stdout(output),
        ):
            main()
        git.assert_not_called()
        self.assertEqual(
            set(output.getvalue().splitlines()), {f"{check}=true" for check in CHECKS}
        )


if __name__ == "__main__":
    unittest.main()
