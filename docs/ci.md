# CI and code review

## Local review

After `make install`, use the same selection policy as a pull request:

```sh
make review-plan                     # Explain; run nothing
make check-changed                    # Run the affected checks
make check-changed BASE=origin/main   # Override the comparison branch
make check                           # Complete local verification
```

The local commands compare the merge base with the current checkout, including
staged, unstaged and untracked files (gitignored personal data stays excluded).
They use the locally available base ref; fetch it first when it is stale.
`check-changed` includes browser tests for frontend changes; install Chromium
once with `cd frontend && npx playwright install chromium`.

For a PR, CI compares the tested merge commit with its **first parent**, the exact
base GitHub merged into. For a push to `main`, it compares the entire event range
(`before` to `HEAD`), including multi-commit pushes. Deleted and moved files keep
their old paths in the diff. A bad base fails the job; it never becomes an empty
successful selection.

The `lint` job always tests the policy itself, publishes a Markdown explanation
and uploads `ci-plan.json` as the `ci-plan` artifact for 14 days. The test job
executes that exact file list; the main preview workflow consumes that same
run's deployment decision and verifies its SHA. No changed-file API pagination
or model judgment is involved.

## Selection policy

| Changed surface | Checks | Preview |
|---|---|---|
| README, AGENTS, docs, generated OpenWiki | Selection-policy tests | No |
| Backend Python | Ruff, mypy, affected pytest files | Yes |
| Test file only | Ruff, mypy, changed test and importing tests | No |
| Shared schema, config, app entrypoint, fixtures, test data/helpers, deleted Python, non-Python backend assets | Ruff, mypy, full pytest | For application changes |
| Frontend | ESLint, all Vitest tests, build, Playwright | Except tests/test config |
| CI scripts, workflows, hooks, Makefile | Full checks | No |
| OpenWiki scripts | Node transport tests | No |
| Lockfiles, build configuration, unknown paths | Full checks | Yes |

On PRs, `scripts/ci/affected_tests.py` parses Python without importing the app.
It follows reverse imports through source and test helpers, including local and
relative imports, package initializers and dotted module names in mock targets.
Shared fixtures attach dependencies to their consumers, including fixture
parameters, `usefixtures` and autouse fixtures. Source changes also run the
architecture, API boot, athlete SQL and script-loading contracts. A change with no discoverable test consumer,
a non-literal dynamic import/fixture lookup or nested fixture configuration
falls back to the full suite. Invalid Python and oversized inputs fail explicitly.

This is conservative static impact analysis, not a proof of runtime coverage.
Reflection and external contracts cannot be inferred from imports alone. Shared
inputs deliberately run everything; keep integration coverage when changing
cross-surface contracts. Backend changes run **full pytest on main**, and manual
CI dispatch still runs all checks. Frontend test selection remains whole-suite:
browser flows cross routes and need a separate coverage policy before narrowing.

Pytest uses two workers with `--dist loadfile --max-worker-restart=0`: each worker
has its own temporary database, and tests in one module stay together. The 20
slowest phases (`setup`, `call`, `teardown`) appear in logs, both in CI and with
`make check`. Measure these before widening fixture scope: sharing a database
fixture can make order-dependent tests pass locally and fail in isolation.
The affected-check runner bounds each command at 22 minutes, below the test
jobs' 25.

In CI the selected files run in three parallel `test (K/3)` jobs
(`--shard K/3`): each file stays whole in one shard, and `scripts/ci/shard_tests.py`
balances the shards on the per-file durations of `scripts/ci/test_durations.json`
(a file missing from it weighs the median). The required `test` check passes only
when every shard passed. The full suite took 14 min 46 s in one job; three
shards bring it to about a third. When the shards' logged durations drift apart,
refresh the table: `uv run pytest tests -n 2 --dist loadfile --junitxml=report.xml`,
then `python3 scripts/ci/shard_tests.py report.xml`.

## Browser environment

The frontend job runs in the official Playwright Noble image. The lint job reads
the exact `@playwright/test` version from `frontend/package-lock.json` and supplies
the matching image tag; a dependency bump changes the image automatically. No
second version constant or browser cache key needs updating. Chromium, WebKit and
their system libraries are already installed, so this job makes no apt downloads.

`npm ci` has a five-minute step limit. A one-minute check confirms the installed
Playwright can find both bundled browser executables before running tests. The
same job still installs Python 3.12 through uv and runs the planning browser
journey against its disposable DuckDB-backed API. The job limit remains 25 minutes.
Record container initialization and total frontend job durations on the PR before
reducing that limit; a local browser run does not measure GitHub's image pull.

## Deployment review

Deployment eligibility uses the same path policy as CI. A documentation-only
merge no longer schedules a Vercel build or invalidates a healthy application
preview. Production still requires a READY, healthy preview, an ancestor SHA,
and no changed deployable input between that SHA and the release. Changes to
code, migrations, dependencies or unknown build inputs still block production
until the preview succeeds. See [the deployment runbook](deployment.md).

A missing/expired plan artifact fails preview selection explicitly. Re-run CI
on the intended commit to regenerate it; do not guess from the latest branch
state. PR previews continue to require the `preview` label.
