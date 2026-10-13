"""Guard both orderings of PR closure versus preview deployment, without network."""

import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CI = (ROOT / ".github/workflows/ci.yml").read_text()
CLEANUP = (ROOT / ".github/workflows/preview-cleanup.yml").read_text()
DEPLOY_STEP = CI.split("      - name: Deploy the preview\n", 1)[1].split(
    "      - name:", 1
)[0]
DEPLOY_SCRIPT = textwrap.dedent(
    DEPLOY_STEP.split("        run: |\n", 1)[1].split("        env:\n", 1)[0]
)


class PipelineFailureTests(unittest.TestCase):
    def test_workflows_that_pipe_a_check_fail_with_it(self):
        # GitHub's default shell is `bash -e`: `curl -f … | tee` then exits
        # with tee's status and a 503 deployed production (2026-10-12).
        for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
            text = path.read_text()
            if not re.search(r"\S \| tee ", text):
                continue
            with self.subTest(workflow=path.name):
                self.assertIn("defaults:\n  run:\n    shell: bash\n", text)


class ProductionWorkflowTests(unittest.TestCase):
    def test_production_moves_only_onto_a_build_that_answered_healthy(self):
        # Deploying with the domain checked the old release after a rollback:
        # three broken builds reported green (2026-10-13).
        text = (ROOT / ".github/workflows/deploy-production.yml").read_text()
        deploy = text.index("vercel deploy --prod --skip-domain")
        check = text.index('"$URL/api/health"')
        promote = text.index("/promote/$id")
        served = text.index('"$serving" != "$id"')
        self.assertLess(deploy, check)
        self.assertLess(check, promote)
        self.assertLess(promote, served)


class PreviewWorkflowTests(unittest.TestCase):
    def test_deploy_and_cleanup_share_a_non_cancelling_per_pr_lock(self):
        preview = CI.split("  preview:\n", 1)[1]
        groups = []
        for job in (preview, CLEANUP):
            block = re.search(r"    concurrency:\n((?:      .+\n)+)", job)
            self.assertIsNotNone(block)
            groups.append(block[1])
            self.assertIn("github.event.pull_request.number", block[1])
            self.assertIn("cancel-in-progress: false", block[1])
        self.assertEqual(groups[0], groups[1])

    def test_a_label_never_cancels_the_commit_s_checks_in_flight(self):
        block = re.search(r"^concurrency:\n((?:  .+\n)+)", CI, re.M)
        self.assertIsNotNone(block)
        cancel = re.search(r"cancel-in-progress: (.+)", block[1])
        self.assertIsNotNone(cancel)
        self.assertIn("github.event.action != 'labeled'", cancel[1])
        self.assertIn("github.event_name == 'pull_request'", cancel[1])

    def test_closed_pr_skips_deployment_and_open_pr_publishes(self):
        for state, gh_exit, expected_exit, deploys in (
            ("OPEN", "0", 0, True),
            ("CLOSED", "0", 0, False),
            ("MERGED", "0", 0, False),
            ("UNKNOWN", "0", 1, False),
            ("OPEN", "1", 1, False),
        ):
            with (
                self.subTest(state=state, gh_exit=gh_exit),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                stubs = {
                    "gh": '#!/bin/sh\nprintf "%s\\n" "$TEST_STATE"\nexit "$TEST_GH_EXIT"\n',
                    "vercel": '#!/bin/sh\ntouch "$TEST_DEPLOYED"\nprintf "%s\\n" "https://preview.invalid"\n',
                }
                for name, content in stubs.items():
                    executable = root / name
                    executable.write_text(content)
                    executable.chmod(0o755)
                output, deployed = root / "output", root / "deployed"
                result = subprocess.run(
                    ["bash", "-e", "-o", "pipefail", "-c", DEPLOY_SCRIPT],
                    env={
                        **os.environ,
                        "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                        "PR": "110",
                        "VERCEL_TOKEN": "test-token",
                        "GITHUB_OUTPUT": str(output),
                        "TEST_DEPLOYED": str(deployed),
                        "TEST_STATE": state,
                        "TEST_GH_EXIT": gh_exit,
                    },
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, expected_exit, result.stderr)
                self.assertEqual(deployed.exists(), deploys)
                if deploys:
                    self.assertEqual(
                        output.read_text(), "url=https://preview.invalid\n"
                    )
                else:
                    self.assertFalse(output.exists())

    def test_skipped_deployment_cannot_prune_or_publish_a_preview_link(self):
        for name in (
            "Remove the PR's superseded previews",
            "Link the preview on the pull request",
        ):
            step = CI.split(f"      - name: {name}\n", 1)[1].split("      - name:", 1)[
                0
            ]
            self.assertIn("        if: steps.deploy.outputs.url != ''\n", step)
        self.assertIn("GH_TOKEN: ${{ github.token }}", DEPLOY_STEP)
        self.assertIn("GH_REPO: ${{ github.repository }}", DEPLOY_STEP)


if __name__ == "__main__":
    unittest.main()
