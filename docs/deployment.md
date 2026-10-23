# Deployment, environments and access

How Arete reaches production, where each environment keeps its data, and what a
collaborator needs. The README stays about the product; this is the runbook.

## Environments

| Environment | URL | Database | Who deploys | Protected by |
|---|---|---|---|---|
| Production | https://arete-arete15.vercel.app (also `arete-two-woad`) | MotherDuck `md:arete_v2` | **Deploy production** workflow, run by hand by anyone with write access | Clerk sign-in (`ARETE_AUTH=clerk`); the Vercel protection is off on production |
| Preview of `main` | https://arete-main-arete15.vercel.app | MotherDuck `md:arete_preview_v2` | **Deploy preview** workflow, after green CI on `main` when deployable inputs changed | Vercel Authentication: a Vercel login, or the bypass key |
| PR preview | `https://arete-<hash>-arete15.vercel.app`, linked in a PR comment | `md:arete_preview_v2` (shared with the main preview) | CI `preview` job, for a PR labelled `preview` once its checks pass | Vercel Authentication, same key |
| Local | `make dev`, `make docker` | `make dev`: a DuckDB file under `data/`; `make docker`: `md:arete_preview_v2`; either: what `ARETE_DB` says | — | nothing |

One Vercel project, two services (`vercel.json`): the FastAPI backend behind
`/api/*` and the Vite frontend. Vercel's Git integration deploys nothing
(`git.deploymentEnabled: false`): every deployment comes from a workflow, with
`vercel deploy --archive=tgz` and the `VERCEL_TOKEN` repository secret.
Each deployment stores a ~490 MB function against the Hobby plan's 10 GB, so
the workflows prune: one PR preview per PR, one main preview, the two newest
production deployments (the live one and its predecessor, for a rollback).
PR deployment and close/merge cleanup share a concurrency group: cleanup waits
for an active deployment to finish. A deployment that starts after the PR closes
skips publication, so cleanup cannot delete an in-flight build or leave a late
preview behind.

Environment variables live in the Vercel project, per environment. `ARETE_DB`
differs between Production and Preview, and `dataio/db.py` refuses to open
from a preview deployment any MotherDuck database whose name lacks `preview`.
Names are listed in `.env.example`.

The `_v2` databases are physical copies (`COPY FROM DATABASE`) made on
17 October 2026. The originals, `arete` and `arete_preview`, were created during
MotherDuck's trial with 7-day snapshot retention, which zero-copy clones inherit
and the current plan refuses ("7 snapshot retention days invalid for plan
free"): the boot's backup clone failed before every migration. The copies have
the plan's retention. MotherDuck cannot rename a database, so `ARETE_DB` names
the copies; the originals stay untouched as backups.

## Sign-in in the browser

The browser decides whether to show Clerk's sign-in before it has heard from
the API: on a cold instance `GET /api/auth/config` took seconds, during which
Clerk had not even started downloading. Two build-time variables carry the
answer instead, set in the Vercel project for each environment whose server runs
`ARETE_AUTH=clerk`:

```dotenv
VITE_AUTH_ENABLED=true
VITE_CLERK_PUBLISHABLE_KEY=<the same value as CLERK_PUBLISHABLE_KEY>
```

- **Build-time.** Vite bakes them into the bundle when Vercel builds the
  deployment: changing them takes a new deployment, not a restart. Each
  environment takes the key of its own Clerk instance; moving Production to its
  own instance changes this key together with the server's.
- **Only `true` counts.** Unset (a self-hosted or Docker build) or any other
  value, the browser asks `/api/auth/config` as before. The build can add
  sign-in, never remove it, and the API refuses unauthenticated requests
  whatever the bundle says.
- **Mistakes.** `VITE_AUTH_ENABLED=true` without a key shows *AUTHENTIFICATION
  MAL CONFIGURÉE*. A key from another Clerk instance than the server's lets
  people sign in, then the server refuses the session; the browser only then
  asks `/api/auth/config`, sees the different key and shows the same error
  instead of signing out in a loop.

## Backend bundle and cold starts

The backend function weighs ~490 MB uncompressed (dependencies, `src/`, the
bundled MotherDuck extension and OCR data). Vercel's Python builder treats a
bundle over 225 MB that has a `uv.lock` specially: unless told otherwise, it
ships only part of it and runs a `uv sync` into `/tmp` on **every cold
start** (`Installing runtime dependencies...`, 13 wheels, ~3.5 s plus the
downloads; a cold `/api/auth/config` took 9.3 s against 160 ms warm).
Two settings turn that off, and both are needed:

- `services.backend.installCommand` in `vercel.json`
  (`uv sync --frozen --no-dev --no-install-project`): a custom install
  command disables the runtime install and installs exactly the lock into the
  builder's environment. `src/` is not installed as a package; `asgi.py` puts
  it on the path. `tests/test_api.py` guards the setting.
- `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` on the Vercel project, in **every**
  environment that builds (Preview and Production). Without it, a custom install
  command over 225 MB fails the build with `LAMBDA_SIZE_EXCEEDED`; with it the
  builder packs every dependency into a large function (beta, up to 5 GB,
  Fluid compute required). Large functions alone do not help: below 500 MB
  the builder still prefers the runtime install.

A custom install command also turns off the builder's bytecode
precompilation, so measure cold starts rather than assume them. To check a
deployment:

```bash
vercel --scope arete15 inspect <url> --logs | grep -iE "optimizing|large|bytecode|install"
vercel --scope arete15 logs --project arete --environment preview --json | grep -c "Installing runtime dependencies"   # expect 0
```

The build log must announce a large function and no "optimizing dependencies";
the runtime logs must never print `Installing runtime dependencies`. Do not
drop `uv.lock` from `.vercelignore` as a workaround: the builder would then
resolve versions itself instead of installing the reviewed lock.

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

**Production exports nothing by default.** Those traces carry athletes'
journal, health and Garmin-derived data, which the Garmin agreement forbids
sharing with third parties, so a process holding production data (Vercel
`VERCEL_ENV=production`, or any MotherDuck `ARETE_DB` whose name lacks
`preview`, such as a Docker stack pointed at `md:arete_v2`) ignores
`LANGSMITH_TRACING=true` and logs `LangSmith tracing off` at startup. Previews,
`make dev` and `make docker` on the preview database trace as above. To debug
production, open a bounded window, ISO 8601 instants with offsets, at most
7 days apart:

```dotenv
LANGSMITH_TRACING=true
LANGSMITH_PRODUCTION_WINDOW=2026-10-23T08:00:00Z/2026-10-24T08:00:00Z
```

Set it in the Vercel Production environment and redeploy. Each instance logs
`LangSmith exports production runs until <end>` when it starts exporting. No
run starts tracing after the end, without a redeploy; a run already in flight
finishes its trace, within its own deadline. Remove the variable afterwards.
Answers outside a window carry no feedback controls. With tracing requested on
production data, a malformed or longer window fails startup, like a malformed
`LANGSMITH_TRACING`; elsewhere the window is not read.

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
   commented on the PR and replaced on each push. A push cancels the PR's run
   in flight; a label never does: its run waits for the current one, so no
   required check is left `CANCELLED` on the commit. Dependabot only opens
   security PRs, without labels (`.github/dependabot.yml`), so each gets one run.
2. **Merge.** `main` only takes pull requests, through the merge queue (the
   repository belongs to the `arete-org` organisation, which GitHub requires
   for it). `gh pr merge --auto --merge` enqueues once the checks pass, and
   nobody has to approve. The queue re-runs CI on the exact result of merging,
   in order, so a PR green on an older `main` cannot break `main`, and a
   conflict surfaces before the merge. A merge that still breaks something
   shows up at once as a red "Deploy preview".
3. **Preview of main.** A green CI run on `main` deploys to the fixed preview
   URL only when its verified `ci-plan` includes a deployable change. README,
   documentation, tests and CI tooling alone keep the existing healthy preview.
   Application/backend changes still run the full backend suite on `main`.
   The deployment's first request migrates `arete_preview_v2`; the
   workflow checks `/api/health` and moves the fixed URL only onto a healthy
   build. A failed migration leaves the URL on the previous build and the
   workflow red. Failed health checks retain the JSON response and fetch the
   deployment's recent runtime errors. To inspect an existing preview without
   deploying, run **Deploy preview** manually with its Vercel URL or deployment
   ID. This uses the repository's Vercel credentials, verifies the preview
   belongs to this project, and reads health and runtime errors; it never moves
   the fixed URL. A degraded health response deliberately keeps this run red.
4. **Production.** Run **Deploy production** (Actions → Deploy production →
   Run workflow, on `main`). The fixed preview must be READY and healthy, and
   its tagged commit must be an ancestor of the requested release with no
   deployable input changed since. A README-only merge can therefore ship
   immediately using the already verified application. Code, migrations,
   dependencies, build inputs and unknown files still require a new preview.
   Missing tags/history or divergent commits fail closed. Then the workflow
   deploys without the domain (`--skip-domain`), checks the new deployment's
   `/api/health`, promotes it, checks the domain serves it and prunes. A broken
   build never takes traffic, and promoting restores the automatic domain
   assignment a rollback disables.

Production deploys in batches, by hand, so that several merges can be tried on
the preview together. There is no reviewer gate: the preview is the gate.

**Do not roll back across ARE-133** (the service worker that waits for the page
before taking over, `frontend/src/sw.ts`). Its `arete-sw-waits` marker cache
stays in browsers after a rollback: the next forward deploy would then wait
behind the older worker, whose pages can neither show « Nouvelle version
disponible » nor hand over on load. If a rollback is unavoidable, rename the
marker (`WAITS_MARKER`) in the next forward deploy so it replaces that worker
at once, as the first deploy of ARE-133 did.

**Rolling back across ARE-62 (migration 66) leaves health data unmanaged.** An
older release does not know `app.pain_entries` and `app.weight_entries`: its
account erasure leaves those rows behind and its export omits them, while the
tables keep what athletes recorded. Prefer rolling forward. If a rollback is
unavoidable, purge by hand the rows of any athlete erased meanwhile
(`DELETE FROM app.pain_entries WHERE athlete_id NOT IN (SELECT id FROM
app.athletes)`, likewise for `app.weight_entries`) before the next forward deploy.

## Migrations

The schema lives in `src/arete/dataio/init_duckdb.py`: the DDL for a fresh
database and an append-only list of numbered, idempotent migrations. Boot
(`lifespan`) runs the missing ones on the first request a deployment serves;
a current database costs one `SELECT`.

- **Backup first.** On a MotherDuck database, the boot clones it before the
  first pending migration (`CREATE DATABASE "<db>_bak_<UTC stamp>" FROM "<db>"`,
  a zero-copy clone, instant) and keeps the two newest clones. To roll back:
  `CREATE OR REPLACE DATABASE arete_v2 FROM arete_v2_bak_<stamp>` from a MotherDuck
  session, then redeploy the previous production deployment from the Vercel
  dashboard.
- **Health tells the truth.** A failed migration does not stop the boot (the
  app answers with what it has), but `/api/health` answers 503 with
  `pending_migrations` until the schema is current. The deploy workflows stop
  on it; so does the uptime pinger.
- **A pending migration is a symptom.** Health also returns `initialization`:
  `not_started`, `ready`, or `failed` with an operation (`connect`,
  `schema_check`, `bootstrap:<statement>`, `backup`, `migration:<version>`,
  `record:<version>`, or `ownership`) and exception type. A backup or bootstrap
  failure can leave version 50 pending without ever calling migration 50.
  The response never includes exception messages or SQL. An unhealthy probe
  re-emits the saved startup error in its request logs, where Vercel can attach
  it to an invocation; probes do not retry initialization or migrations.
  Retained error text is limited to 16,384 characters with an explicit
  truncation marker. A new lifespan clears the previous failure.
- **Numbers are identifiers.** Every missing version runs, even below the
  latest, because branches merge in any order and both environments share the
  numbering. Never renumber a migration that any database has recorded: take a
  fresh number. Anything added to the DDL also needs a migration, since a
  current database skips the DDL.
- **Preview before production.** A migration reaches `arete_preview_v2` with the
  main preview and `arete_v2` only with the next production deploy; the gate above
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

## Clerk session verification

With `ARETE_AUTH=clerk`, the API verifies each Clerk session token itself.
Without `CLERK_JWT_KEY` the Clerk SDK first fetches the instance's JWKS from
Clerk, on every new function instance and again every five minutes, which
delays the first request of a dashboard burst. With it, verification is
offline:

- **Where to copy it.** Clerk dashboard → *Configure* → *API keys* → *JWT
  public key*, the PEM block (`-----BEGIN PUBLIC KEY-----` … `-----END PUBLIC
  KEY-----`). Paste it whole in the Vercel variable; line breaks may stay or go.
- **One key per Clerk instance.** Each Vercel environment takes the key of the
  instance whose `CLERK_SECRET_KEY` it holds. Production and Preview use
  different keys as soon as they use different instances: moving Production to
  its own Clerk instance changes this key together with the two others.
- **Failure modes.** A key that does not load answers 503 on every protected
  route, logged as `Authentication enabled but unusable: CLERK_JWT_KEY
  illisible …`. A readable key from another instance refuses every session with
  401. Removing the variable restores the JWKS fetch.

## Keeping production warm

A function instance idles out after a few minutes, and the first request then
pays a cold start (see "Backend bundle and cold starts" above). An
external pinger (cron-job.org or similar) calling
`https://arete-arete15.vercel.app/api/health` every 5 minutes keeps an instance
and the MotherDuck connection warm, and alerts on the 503 that a pending
migration or a lost database produces. No header is needed: production is not
behind Vercel Authentication.

## Daily sync

Vercel Cron calls `/api/cron/daily-sync` in ten daily windows, 07:00 to 16:00
UTC (`vercel.json`): Hobby runs each cron once a day, within its hour, and only
on the production deployment. The endpoint answers 401 unless the environment
has `CRON_SECRET`, which Vercel sends as a bearer token. Each dispatch syncs the
athletes still owed today within the function's 300 seconds, none before 07:00
on their own clock nor during their quiet hours; the rules, and how to park or
force an athlete, are in `docs/multi-athlete.md`. On Sunday the 16:00 UTC
window also writes the week's review (« Ma semaine », `docs/architecture.md`);
no cron is added for it. A preview syncs only when called by hand with that header.

`/api/cron/checkin` runs at 05:00 and 06:00 UTC, with the same secret: it only
sends the morning check-in push (at most one per athlete and day, none once
answered, none in quiet hours, which hold it for the next window) and never
starts the daily sync, so the sync's windows behave as before.

`/api/cron/evening` runs at 18:00 UTC, with the same secret: it replans the
day's missed sessions for the athletes in their evening (from 18:00 on their
clock, outside quiet hours; Hobby fires it within the hour, so Paris gets it
around 20:00-21:00 in summer and 19:00-20:00 in winter, UTC+3 only before
quiet hours, the Americas not at all), one proposal and at most one push (kind
`adapted_session`) per athlete and day, and never starts the daily sync.
Docker's ticks run the same pass from 20:00 local, with the daily sync.

## Scheduled follow-ups

`/api/cron/automations` uses the same `CRON_SECRET` bearer protection and shared
dispatcher on Vercel and Docker. `vercel.json` adds one daily window in each of the
24 UTC hours. A deadline means the next dispatcher passage after that time, not
exact-time execution; the interface explains that an hourly window may make a
run nearly two hours late ([Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)). Preview deployments do not receive automatic cron runs.

Docker enables `ARETE_AUTOMATION_WORKER=true` in Compose and checks every five
minutes, independently of `ARETE_AUTO_SYNC_HOUR`. Outside Compose it is opt-in; leave
it unset for an API-only process. Both workers must use the same database for
their durable occurrence claims and global two-slot limit to coordinate.
Migration 50 is additive. Preserve the database on rollback: an ambiguous or
abandoned run is never replayed automatically, and human decisions remain durable.

## Local stack

`make dev` runs the API and Vite on a local DuckDB file. `make docker` builds
the production-like stack from `docker-compose.yml`, on `md:arete_preview_v2`
unless the shell or `.env` sets `ARETE_DB` (Compose reads both). A `.env` copied
from an older `.env.example` sets `data/arete.duckdb`: Docker then shares the
`make dev` file, so run one backend at a time or remove that line. Production's
`md:arete_v2` is an explicit opt-in, from `main` only and after Deploy
production: a branch's boot would migrate the production database from a
laptop, and the stack's scheduler would run the daily jobs against it. Outside
Vercel, the boot logs a warning on any MotherDuck database not named for
previews. The retired `md:arete` and `md:arete_preview` are refused everywhere.
