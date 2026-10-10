# Arete — coding-session instructions

Arete is a self-hosted, single-athlete training assistant: FastAPI + DuckDB,
React + Vite, Garmin/Strava sync, planning, strength logging and coaching.
Read [docs/architecture.md](docs/architecture.md) before changing the coaching stack.

## Architecture: give every behavior one owner

- `src/arete/coaching.py` is the application composition root. It resolves profiles
  and model configuration, supplies concrete dependencies to the factory, and
  connects API/scheduled work to domain services through callbacks.
- `agent/factory.py` only assembles and compiles. Lower layers must never import it
  or the composition root. Do not create agents inside tools, services or middleware.
- `agent/runtime/` owns invocation context, conversation state, policy, budgets and
  events. Keep clients, credentials, deadlines and concurrency primitives out of
  conversation state. Browser threads remain authoritative; do not introduce server
  persistence implicitly.
- `agent/context/` owns final request ordering, typed contributions (including the
  open page's data) and complete-request token accounting. Contribute context here instead of appending
  prompts independently in another middleware. Preserve the current objective and
  raw history; never silently truncate a request to fit.
- `agent/models/` owns model routes, configured limits and provider clients. Construct
  clients through the composition root; no network discovery at import time. Name
  model/output/temperature/timeout/retry settings explicitly.
- `agent/capabilities/` declares tools, instructions and execution metadata once.
  Discovery, model binding, authorization and structural tests use this catalog.
  Capability instructions stay beside their declaration. Loading is not authorization.
- `agent/tools/` validates/adapts model arguments and calls domain services. It must
  not import HTTP handlers, select models or implement domain workflows.
  `agent/middlewares/` only adapts framework interception/completion hooks to the
  actual policy or operation. Do not hide a second runtime in middleware.
- `agent/backends/` adapts Deep Agents filesystem permissions and operations.
  Reusable ledger I/O belongs in `services/memory.py`.
- `agent/profiles/` is declarative server configuration; `agent/prompts/` contains
  versioned general/mission instructions. A client-supplied profile or page payload
  cannot grant permissions.
- `services/` owns shared domain operations and their contracts. It may use the
  existing `features/`, `dataio/`, `garmin/`, `strava/` and `strength/` modules. It
  must not import FastAPI, LangChain, LangGraph, Deep Agents or agent composition.
- `api/` owns HTTP schemas and SSE projection; `observability/` owns measurements.
  Put schemas beside their owner. Avoid global `schemas/` or catch-all `shared/`.

Add a directory only when it removes an ambiguous dependency or gives an existing
responsibility a testable owner. Do not create empty architectural scaffolding.
`tests/test_architecture.py` enforces the dependency direction, including local imports.

## Runtime contracts to preserve

- Chat preloads its toolkits and may write training data; model requests, not
  tokens, are the free tier's budget, so do not reintroduce per-turn loading or
  auxiliary calls without measuring them (`Agent run:` log line). Briefings
  and feedback bind no tool: the server computes their facts and files the
  feedback's ledger entry; they cannot alter training plans or log workouts.
- New journal entries go through `services/memory.append_entry` (the chat's
  `append_journal` tool, the feedback): dated by the server, never twice. Chat
  may correct/remove existing content with `edit_file` or delete an entire
  `notes.md`/`sessions.md` with `delete`; archives and attachments stay read-only.
  Each prompt rule lives once: the shared core in `prompts/coach.py`, the rest in the
  profile or the toolkit that needs it (`tests/test_agent_prompts.py`).
- Each invocation has named call, concurrency and time limits. SDK retries and
  auxiliary calls must remain bounded. Never automatically replay a failed write
  or an entire run with an ambiguous outcome.
- `LLM_CONTEXT_TOKENS` is the deployment's configured window, not a guarantee from
  a provider router. Budget system text, schemas, history, page data and output.
- The admin-only `glm_flash` flag is global, persisted and off by default. Read
  it at invocation composition and key cached graphs by its effective value;
  never change a running graph's route. Paid requests require the explicit
  GLM price cap and low reasoning effort; disabling restores free-only routing.
  Reject truncated completions before executing their tool calls.
- OpenRouter provider affinity is request-local: hash the trusted athlete,
  profile and thread/run identity into `session_id`; never mutate cached clients.
  Sort providers by latency without a manual order, preserving price caps.
- Booting the app must not import the agent stack, Garmin's client or the
  workout grammars: `api/agent.py` and `api/ai_tips.py` import them inside their
  handlers, a cold serverless instance pays every top-level import before its
  first request (`tests/test_api.py` guards it). A table or column added to the
  DDL needs a migration: boots on a current schema skip the DDL. Every missing
  version runs, even below the latest, so never renumber a migration that any
  database (a preview included) has recorded: take a fresh number.
- Async model clients belong to the server event loop. Sync API/scheduler work uses
  AnyIO workers and `invoke_agent_sync`; never add a fresh `asyncio.run()` per job.
- Empty threads use fixed page-aware starters. Answers make no auxiliary suggestion
  call and never fill the composer automatically. Preserve manual drafts and keep
  HTTP, SSE, parser and browser-storage contracts aligned.
- System skills expose metadata in SYSTEM and bodies through native read_file tool
  results in MESSAGES. Attachments select document-planning for reading, not preloading.
  Skills grant no permissions. Toolkits bind native tools by server profile, without
  search/load tools or model-controlled loading state.
- Preserve optional LangSmith tracing across async invocation and stream closure.
  Preserve native tool callbacks and retain thread metadata. The
  context builder owns bounded journal injection and the current chat date.
- Keep state local to the invocation. Compiled graphs are cached and multiple tabs
  or scheduled jobs may overlap. Cancellation cannot undo a committed write or
  forcibly stop a synchronous tool already running in a thread.

## Commands and verification

| Need | Command |
|---|---|
| Complete CI-equivalent checks | `make check` |
| Backend tests | `make test` |
| Local API + frontend | `make dev` |
| Docker stack | `make docker` |
| Dependencies and git hooks | `make install` |

Run `make check` before declaring implementation complete. It runs lint, formatting
checks, mypy, backend/frontend tests and the frontend build. Mock external I/O in
normal tests. Add behavior tests for changed boundaries, failures and concurrency;
do not add tests that merely repeat an implementation. Live model evaluations in
`tests/test_agent_evals.py` are opt-in and must use a database copy.

## Data, workflow and conventions

- **Never `git add -A` or `git add .`.** Stage named paths; embedded workspaces and
  personal data must not be swept into a commit.
- Do not commit or push until the user has tested locally and explicitly authorized
  shipping. Each push needs its own authorization. Never rename the current branch
  unless requested. `main` only takes pull requests, never a direct or forced
  push, and a PR merges once CI passes (lint, test, typecheck, frontend). Open
  it with auto-merge armed: `gh pr create … && gh pr merge --auto --merge`.
- Use Conventional Commits with an English subject and a body explaining why.
- A PR body fills every section of `.github/pull_request_template.md`, in order,
  including when an agent passes `--body` or `--body-file` to `gh pr create`, which
  skips GitHub's prefill.
- The real data lives in the MotherDuck database `arete`, shared by Vercel and the
  Docker stack (`ARETE_DB=md:arete`). Read it through the HTTP API rather than
  scripts. A local DuckDB file (`make dev`, tests) allows one writer: a script that
  opens it while a backend runs makes the API answer 500.
- Deployment is described in `docs/deployment.md`. In short: a PR labelled
  `preview` gets a preview from CI when deployable inputs change; green CI on
  `main` with deployable changes deploys to https://arete-main-arete15.vercel.app (database
  `md:arete_preview`); production ships in batches through the manual **Deploy
  production** workflow, which requires a healthy ancestor preview with no
  deployable input changed since (documentation-only merges are allowed).
  The boot clones a MotherDuck database before migrating it, and
  `/api/health` answers 503 while a migration is pending. Vercel's Git
  integration deploys nothing. By hand, use `vercel deploy --archive=tgz`:
  `.vercelignore` is an allowlist, and loose uploads hit Vercel's 5000-file daily
  quota.
- `data/`, Garmin tokens, FIT files, `PROG_*.md` and `.context/` stay untracked.
  Secrets live in `.env`; use `.env.example` to discover configuration names.
- UI text is French. Code, comments and commit messages are English.
- Workout parsing uses the Lark grammars, not an LLM. A new spoken phrase needs a
  grammar change and an example in `tests/data/dictations.jsonl`.
- Heart-rate zones come from the athlete's threshold refreshed by Garmin sync.
  Reuse `features/hr_zones.py` and `garmin/threshold.py`.
- Be critical and concise. Verify claims against code or runs, reuse existing domain
  logic, and explain trade-offs. Bound new loops/retries/fan-out; assert programmer
  invariants and report operating errors explicitly.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
