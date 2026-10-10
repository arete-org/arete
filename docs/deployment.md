# Deployment, environments and access

How Arete reaches production, where each environment keeps its data, and what a
collaborator needs. The README stays about the product; this is the runbook.

## Environments

| Environment | URL | Database | Who deploys | Protected by |
|---|---|---|---|---|
| Production | https://arete-arete15.vercel.app (also `arete-two-woad`) | MotherDuck `md:arete` | **Deploy production** workflow, run by hand by anyone with write access | Clerk sign-in (`ARETE_AUTH=clerk`); the Vercel protection is off on production |
| Preview of `main` | https://arete-main-arete15.vercel.app | MotherDuck `md:arete_preview` | **Deploy preview** workflow, after green CI on `main` when deployable inputs changed | Vercel Authentication: a Vercel login, or the bypass key |
| PR preview | `https://arete-<hash>-arete15.vercel.app`, linked in a PR comment | `md:arete_preview` (shared with the main preview) | CI `preview` job, for a PR labelled `preview` once its checks pass | Vercel Authentication, same key |
| Local | `make dev`, `make docker` | a DuckDB file under `data/`, or what `ARETE_DB` says | — | nothing |

One Vercel project, two services (`vercel.json`): the FastAPI backend behind
`/api/*` and the Vite frontend. Vercel's Git integration deploys nothing
(`git.deploymentEnabled: false`): every deployment comes from a workflow, with
`vercel deploy --archive=tgz` and the `VERCEL_TOKEN` repository secret.
Each deployment stores a ~430 MB function against the Hobby plan's 10 GB, so
the workflows prune: one PR preview per PR, one main preview, the two newest
production deployments (the live one and its predecessor, for a rollback).
PR deployment and close/merge cleanup share a concurrency group: cleanup waits
for an active deployment to finish. A deployment that starts after the PR closes
skips publication, so cleanup cannot delete an in-flight build or leave a late
preview behind.

Environment variables live in the Vercel project, per environment. `ARETE_DB`
differs between Production and Preview, and `dataio/db.py` refuses to open
`md:arete` from a preview deployment. Names are listed in `.env.example`.

## LangSmith agent tracing

The shared coach already traces chat, briefings, feedback and weekly reviews.
Tracing is opt-in and independent of the inference provider: no Anthropic key
or model change is needed. Set these server-side variables in the local `.env`
or in the Vercel project's intended environment:

```dotenv
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=<LangSmith API key>
LANGSMITH_PROJECT=Arete
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```

Use the exact project name, not its UUID. Match the endpoint to the project's
region; set `LANGSMITH_WORKSPACE_ID` only when the key requires a workspace.
Keep the key in the ignored `.env` or Vercel's secret storage, never in source.
Restart the local backend after changing `.env`; recreate the Docker backend
to reload its environment. Vercel changes require a new deployment through the
normal preview/production workflow below.

Send a coach message, then open the `Arete` tracing project in LangSmith. Expect
one `arete_coach` root with nested model/tool calls and `task`, `provider` and
`model` metadata. Chat turns carry the browser's `thread_id`; an enabled reply
suggestion adds a `coach_autosuggestion` child. Full inputs, outputs, tool results,
page context and journal content read by the agent are exported when enabled.

If no trace appears, check the environment on the running deployment and look
for `LangSmith trace export failed` in its backend logs. A missing key fails
startup when tracing is enabled; exporter failures are logged without failing
the coach's answer. Set `LANGSMITH_TRACING=false` and restart/redeploy to disable
future exports. `uv run pytest tests/test_agent_tracing.py -q` checks span
parentage, thread isolation, cancellation and failures offline.

New completed chat answers expose 👍 / 👎 and an emoji picker. In LangSmith,
open that turn's `arete_coach` root and inspect `user_score` (0/1) and `reaction`
(the emoji stored in `value`). This uses the existing tracing credentials, with
no model call or additional setting. The browser keeps the root ID and a signed
receipt beside the answer; older answers cannot be retroactively associated.
The receipt is athlete/account/thread/project scoped. Rotating the LangSmith key
invalidates previous receipts. A failed feedback request offers **Vérifier le
retour enregistré** rather than replaying a possibly committed write.
The implementation follows the [feedback SDK guide](https://docs.langchain.com/langsmith/attach-user-feedback);
the emoji is textual feedback, not an undocumented LangSmith UI reaction endpoint.

## From a branch to production

1. **Pull request.** CI runs the checks the diff needs (`scripts/ci/select_checks.py`)
   on the branch merged into `main`. Backend tests follow reverse imports and
   shared fixture consumers; ambiguous inputs run the full suite. The `lint`
   summary and `ci-plan` artifact list the files, selected tests and reason.
   See [CI and code review](ci.md) to reproduce the plan locally. A PR with the
   `preview` label also gets a deployment when deployable inputs changed,
   commented on the PR and replaced on each push.
2. **Merge.** `main` only takes pull requests; `gh pr merge --auto --merge`
   merges once the checks pass, and nobody has to approve. The checks are not
   strict (a PR green on an older `main` still merges): GitHub's merge queue,
   which would re-run CI on the exact merge result, is only offered to
   repositories owned by an organisation. With two people the window is short,
   and a merge that breaks `main` shows up at once as a red "Deploy preview".
   Rebase or merge `main` into a long-lived branch before merging it.
3. **Preview of main.** A green CI run on `main` deploys to the fixed preview
   URL only when its verified `ci-plan` includes a deployable change. README,
   documentation, tests and CI tooling alone keep the existing healthy preview.
   Application/backend changes still run the full backend suite on `main`.
   The deployment's first request migrates `arete_preview`; the
   workflow checks `/api/health` and moves the fixed URL only onto a healthy
   build. A failed migration leaves the URL on the previous build and the
   workflow red.
4. **Production.** Run **Deploy production** (Actions → Deploy production →
   Run workflow, on `main`). The fixed preview must be READY and healthy, and
   its tagged commit must be an ancestor of the requested release with no
   deployable input changed since. A README-only merge can therefore ship
   immediately using the already verified application. Code, migrations,
   dependencies, build inputs and unknown files still require a new preview.
   Missing tags/history or divergent commits fail closed. Then the workflow
   deploys, checks `/api/health` and prunes.

Production deploys in batches, by hand, so that several merges can be tried on
the preview together. There is no reviewer gate: the preview is the gate.

## Migrations

The schema lives in `src/arete/dataio/init_duckdb.py`: the DDL for a fresh
database and an append-only list of numbered, idempotent migrations. Boot
(`lifespan`) runs the missing ones on the first request a deployment serves;
a current database costs one `SELECT`.

- **Backup first.** On a MotherDuck database, the boot clones it before the
  first pending migration (`CREATE DATABASE "<db>_bak_<UTC stamp>" FROM "<db>"`,
  a zero-copy clone, instant) and keeps the two newest clones. To roll back:
  `CREATE OR REPLACE DATABASE arete FROM arete_bak_<stamp>` from a MotherDuck
  session, then redeploy the previous production deployment from the Vercel
  dashboard.
- **Health tells the truth.** A failed migration does not stop the boot (the
  app answers with what it has), but `/api/health` answers 503 with
  `pending_migrations` until the schema is current. The deploy workflows stop
  on it; so does the uptime pinger.
- **Numbers are identifiers.** Every missing version runs, even below the
  latest, because branches merge in any order and both environments share the
  numbering. Never renumber a migration that any database has recorded: take a
  fresh number. Anything added to the DDL also needs a migration, since a
  current database skips the DDL.
- **Preview before production.** A migration reaches `arete_preview` with the
  main preview and `arete` only with the next production deploy; the gate above
  enforces the order.
- **Two instances at once.** Migrations are idempotent and a version recorded
  twice is a no-op, so two cold instances racing on the same deployment do not
  fail the boot.

## Access for a collaborator

The Vercel project is on the Hobby plan: one member, the owner. A collaborator
works from the GitHub repository (write access) and never needs the Vercel
dashboard:

- **Code and CI.** Push branches, open PRs, label `preview`, run **Deploy
  production**: all through GitHub.
- **Production.** Public URL, Clerk sign-in. A non-owner account gets its own
  private athlete (see `docs/multi-athlete.md`): empty until it connects Garmin
  or logs sessions. The owner's data is never visible to another account, as
  long as `ARETE_OWNER_EMAIL` lists only the owner's own addresses. The owner
  can name the collaborator administrator in Réglages → Administration, to see
  each athlete's state, deactivate or reactivate one and unblock its daily sync.
- **Previews.** Behind Vercel Authentication, which a non-member cannot pass
  with a login. The owner creates a *Protection Bypass for Automation* key in
  the Vercel dashboard (Settings → Deployment Protection), one per person, and
  shares it privately. The collaborator opens each new preview URL once with
  `?x-vercel-protection-bypass=<key>&x-vercel-set-bypass-cookie=true`: the page
  reloads without the parameters and a cookie keeps the URL open. The key never
  goes into a PR, an issue or a shared chat (the repository is public).
  Revoking the key in the dashboard ends the access; the CI key is separate.
- **Secrets the workflows use** (repository Actions secrets): `VERCEL_TOKEN`
  (the owner's Vercel token), `VERCEL_AUTOMATION_BYPASS_SECRET` (the CI key,
  for the preview health check), `OPENROUTER_API_KEY` (the wiki workflow);
  variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

## Keeping production warm

A function instance idles out after a few minutes, and the first request then
pays a cold start (about 2 s with the bundled MotherDuck extension). An
external pinger (cron-job.org or similar) calling
`https://arete-arete15.vercel.app/api/health` every 5 minutes keeps an instance
and the MotherDuck connection warm, and alerts on the 503 that a pending
migration or a lost database produces. No header is needed: production is not
behind Vercel Authentication.

## Daily sync

Vercel Cron calls `/api/cron/daily-sync` in six daily windows, 07:00 to 12:00
UTC (`vercel.json`): Hobby runs each cron once a day, within its hour, and only
on the production deployment. The endpoint answers 401 unless the environment
has `CRON_SECRET`, which Vercel sends as a bearer token. Each dispatch syncs the
athletes still owed today within the function's 300 seconds; the rules, and how
to park or force an athlete, are in `docs/multi-athlete.md`. A preview syncs
only when called by hand with that header.

## Local stack

`make dev` runs the API and Vite on a local DuckDB file. `make docker` builds
the production-like stack from `docker-compose.yml`; point its `ARETE_DB` at a
local file or at `md:arete_preview`, never at `md:arete`: a branch's boot would
migrate the production database from a laptop.
