"""Guard both orderings of PR closure versus preview deployment, without network."""

import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

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
    def test_health_failure_preserves_the_response_and_blocks_publication(self):
        # Exercise real curl and bash: -f discarded the only database diagnostic
        # and a pipeline without pipefail could publish a broken deployment.
        for workflow in ("deploy-preview.yml", "deploy-production.yml"):
            text = (ROOT / ".github/workflows" / workflow).read_text()
            step = text.split("      - name: Check the health of the deployment\n", 1)[
                1
            ].split("      - name:", 1)[0]
            script = textwrap.dedent(
                step.split("        run: |\n", 1)[1].split("        env:\n", 1)[0]
            )
            for status, body in (
                (200, '{"status":"ok","pending_migrations":[]}'),
                (503, '{"status":"degraded","pending_migrations":[50]}'),
            ):
                with (
                    self.subTest(workflow=workflow, status=status),
                    tempfile.TemporaryDirectory() as directory,
                ):

                    class Handler(BaseHTTPRequestHandler):
                        def do_GET(self, status=status, body=body):
                            self.send_response(status)
                            self.send_header("Content-Type", "application/json")
                            self.end_headers()
                            self.wfile.write(body.encode())

                        def log_message(self, *args):
                            pass

                    with HTTPServer(("127.0.0.1", 0), Handler) as server:
                        server.timeout = 5
                        thread = Thread(target=server.handle_request, daemon=True)
                        thread.start()
                        summary = Path(directory) / "summary"
                        # Only the retry schedule is disabled; keep the workflow's
                        # actual curl flags, output pipeline and shell behavior.
                        result = subprocess.run(
                            [
                                "bash",
                                "-e",
                                "-o",
                                "pipefail",
                                "-c",
                                'curl() { command curl "$@" --retry 0; }\n'
                                + script
                                + '\nprintf "published\\n"\n',
                            ],
                            env={
                                **os.environ,
                                "URL": f"http://127.0.0.1:{server.server_port}",
                                "BYPASS": "test-bypass",
                                "GITHUB_STEP_SUMMARY": str(summary),
                                "NO_PROXY": "127.0.0.1",
                            },
                            capture_output=True,
                            text=True,
                            timeout=10,
                            check=False,
                        )
                        thread.join(timeout=5)
                        self.assertFalse(thread.is_alive())
                    self.assertEqual(
                        result.returncode, 0 if status == 200 else 22, result.stderr
                    )
                    self.assertIn(body, result.stdout)
                    self.assertEqual(summary.read_text(), body)
                    self.assertEqual("published" in result.stdout, status == 200)

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
    def test_live_diagnosis_subscribes_before_boot_and_keeps_the_startup_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            curl = root / "curl"
            curl.write_text(
                textwrap.dedent("""\
                #!/usr/bin/env python3
                import os, sys, time
                from pathlib import Path
                root = Path(os.environ['TEST_ROOT'])
                if any('runtime-logs?' in arg for arg in sys.argv):
                    (root / 'subscribed').touch()
                    Path(sys.argv[sys.argv.index('--dump-header') + 1]).write_text('HTTP/2 200\\r\\n\\r\\n')
                    for _ in range(100):
                        if (root / 'booted').exists():
                            print('{"message":"Database initialization failed: migration error"}')
                            sys.exit(0)
                        time.sleep(0.01)
                    raise AssertionError('health never invoked')
                if any(arg.endswith('/api/health') for arg in sys.argv):
                    assert (root / 'subscribed').exists(), 'startup log would be lost'
                    (root / 'booted').touch()
                    print('{"pending_migrations":[50]}')
                    sys.exit(22)
                print('{"id":"dpl_test","projectId":"expected","target":null}')
                """)
            )
            curl.chmod(0o755)
            summary = root / "summary"
            result = subprocess.run(
                ["bash", str(ROOT / "scripts/ci/preview_logs.sh")],
                env={
                    **os.environ,
                    "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                    "TEST_ROOT": str(root),
                    "URL": "https://arete-example-arete15.vercel.app",
                    "VERCEL_PROJECT_ID": "expected",
                    "VERCEL_ORG_ID": "test-team",
                    "VERCEL_TOKEN": "test-token",
                    "BYPASS": "test-bypass",
                    "GITHUB_STEP_SUMMARY": str(summary),
                },
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(result.returncode, 22, result.stderr)
            self.assertIn(
                "Database initialization failed: migration error", result.stdout
            )
            self.assertEqual(
                json.loads(summary.read_text()), {"pending_migrations": [50]}
            )

    def test_service_token_logs_preserve_errors_and_reject_incomplete_responses(self):
        for response, history_exit, stream_exit, valid in (
            ({"rows": [{"logs": [{"message": "migration failed"}]}]}, 0, 0, True),
            ({"rows": [], "hasMoreRows": False}, 0, 0, True),
            ({"rows": [], "hasMoreRows": True}, 0, 0, False),
            ({"error": "not authorized"}, 0, 0, False),
            ({"error": "not authorized"}, 22, 0, True),
            ({"error": "not authorized"}, 22, 28, False),
        ):
            with (
                self.subTest(response=response),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                curl = root / "curl"
                curl.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, sys\nfrom pathlib import Path\n"
                    "if any('runtime-logs?' in arg for arg in sys.argv):\n"
                    ' print(\'{"message":"migration failed"}\')\n'
                    " sys.exit(int(os.environ['TEST_STREAM_EXIT']))\n"
                    "if '--output' in sys.argv:\n"
                    " Path(sys.argv[sys.argv.index('--output') + 1]).write_text(os.environ['TEST_LOG_JSON'])\n"
                    " sys.exit(int(os.environ['TEST_HISTORY_EXIT']))\n"
                    'print(\'{"id":"dpl_test","projectId":"expected","target":null}\')\n'
                )
                curl.chmod(0o755)
                result = subprocess.run(
                    ["bash", str(ROOT / "scripts/ci/preview_logs.sh")],
                    env={
                        **os.environ,
                        "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                        "URL": "https://arete-example-arete15.vercel.app",
                        "VERCEL_PROJECT_ID": "expected",
                        "VERCEL_ORG_ID": "test-team",
                        "VERCEL_TOKEN": "test-token",
                        "TEST_LOG_JSON": json.dumps(response),
                        "TEST_HISTORY_EXIT": str(history_exit),
                        "TEST_STREAM_EXIT": str(stream_exit),
                        "BYPASS": "",
                    },
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode == 0, valid, result.stderr)
                if history_exit:
                    self.assertIn(json.dumps(response), result.stderr)
                    self.assertEqual(result.returncode, stream_exit)
                    self.assertEqual(
                        json.loads(result.stdout), {"message": "migration failed"}
                    )
                elif valid:
                    self.assertEqual(json.loads(result.stdout), response)

    def test_manual_diagnosis_resolves_only_this_projects_previews(self):
        text = (ROOT / ".github/workflows/deploy-preview.yml").read_text()
        step = text.split(
            "      - name: Resolve a preview belonging to this project\n", 1
        )[1]
        script = textwrap.dedent(
            step.split("        run: |\n", 1)[1].split("      - name:", 1)[0]
        )
        for deployment, project, target, accepted in (
            ("https://arete-example-arete15.vercel.app", "expected", None, True),
            ("dpl_example", "expected", None, True),
            ("dpl_example", "other-project", None, False),
            ("dpl_example", "expected", "production", False),
            ("https://elsewhere.invalid/path?override=yes", "expected", None, False),
        ):
            with (
                self.subTest(deployment=deployment, project=project, target=target),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                curl = root / "curl"
                curl.write_text('#!/bin/sh\nprintf "%s\\n" "$TEST_DEPLOYMENT_JSON"\n')
                curl.chmod(0o755)
                output = root / "output"
                result = subprocess.run(
                    ["bash", "-e", "-o", "pipefail", "-c", script],
                    env={
                        **os.environ,
                        "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                        "DEPLOYMENT": deployment,
                        "VERCEL_PROJECT_ID": "expected",
                        "VERCEL_ORG_ID": "test-team",
                        "VERCEL_TOKEN": "test-token",
                        "GITHUB_OUTPUT": str(output),
                        "TEST_DEPLOYMENT_JSON": json.dumps(
                            {
                                "projectId": project,
                                "target": target,
                                "url": "arete-resolved-arete15.vercel.app",
                            }
                        ),
                    },
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                self.assertEqual(output.exists(), accepted)
                if accepted:
                    self.assertEqual(
                        output.read_text(),
                        "url=https://arete-resolved-arete15.vercel.app\n",
                    )

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

    def test_only_a_new_pr_commit_cancels_checks_in_flight(self):
        block = re.search(r"^concurrency:\n((?:  .+\n)+)", CI, re.M)
        self.assertIsNotNone(block)
        cancel = re.search(r"cancel-in-progress: (.+)", block[1])
        self.assertIsNotNone(cancel)
        # An opened event may arrive after labeled when a PR starts with preview.
        # A denylist of labeled alone still cancels checks for the same commit.
        self.assertEqual(
            cancel[1],
            "${{ github.event_name == 'pull_request' && "
            "github.event.action == 'synchronize' }}",
        )

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
