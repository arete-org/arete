# Coaching stack: responsibilities and dependencies

Arete gives each behavior one owner, with one coaching runtime and three
server-selected profiles. Browser-owned conversations, HTTP endpoints, tool names,
DuckDB tables and ledger paths remain compatible. There are no placeholder layers
for delegation, MCP, authentication or providers Arete does not use.

```text
arete/
├── coaching.py              Application composition for HTTP and scheduled work
├── agent/
│   ├── factory.py           Compile explicit dependencies into one graph
│   ├── runtime/             Invocation context, conversation state, policy, limits, events
│   ├── context/             Ordered sections, open-page data and request accounting
│   ├── models/              Deployment envelope, route selection, provider adapter
│   ├── capabilities/        One catalog, discovery and execution resolution
│   ├── tools/               Model schemas and domain-service adapters
│   ├── middlewares/         Framework interception/completion hooks
│   ├── backends/            Deep Agents memory filesystem adapter and permissions
│   ├── profiles/            Declarative chat, briefing and feedback configurations
│   └── prompts/             Versioned general/mission instructions
├── services/                Metrics, analytics, planning, settings, pages, coaching, memory
├── observability/           Provider usage and model-boundary timing
└── api/                     HTTP contracts and SSE projection
```

Existing `garmin/`, `strava/`, `strength/`, `features/` and `dataio/` remain domain
modules: moving them would not improve a dependency boundary. The services layer
reuses them. Business code imports neither the HTTP routes nor agent frameworks.

## Composition and execution

`coaching.py` resolves configuration and supplies the concrete model and memory
adapter to the factory. Graph creation is serialized
on first access and cached per athlete and profile (32 athletes per profile).
Memory roots are captured at construction, so sharing a compiled graph across
athletes would expose the wrong ledger. `services/athlete_scope.py` carries the
trusted identity through HTTP, workers, tools and scheduled jobs; clients cannot
select it. See [multi-athlete storage and rollout](multi-athlete.md). Only this composition root may
import the factory. The runtime receives an already-compiled graph; it never
compiles another agent. Briefing and feedback services receive typed callbacks
rather than reaching back into the factory.

The browser sends human/assistant history. `runtime/state.py` owns invocation
messages and loaded capabilities. `runtime/context.py` owns
server-selected profile, request metadata, deadline and concurrency gate. Clients,
semaphores and credentials do not enter conversation state.

Production sync entrypoints run in AnyIO workers and bridge model execution onto
the server event loop. This avoids sharing the SDK's cached async HTTP connections
across short-lived event loops. Async callers use `invoke_agent` directly.

The execution envelope is five minutes, 24 main graph model turns (the last binds
no tools and asks for an answer stating any incomplete work), 96 tool calls,
and four simultaneous tool executions per invocation. Interactive chat may add one
optional next-message completion (512 output tokens, five seconds, zero SDK retries). Framework recursion is a
separate 200-step backstop. A model call gives up after 60 s, or 30 s without a
streamed chunk. Native LangChain `ModelFallbackMiddleware` tries the configured
candidates in order (at most three, including the primary). The composition root
constructs each fallback candidate with zero SDK retries and no provider-side fallback list,
so one graph turn costs at most three requests, 72 per run before the optional
suggestion. Completions with neither visible text nor a valid tool call are
rejected inside that same fallback boundary, including reasoning-only output
that exhausts the token allowance. With no usable candidate the run fails
explicitly; no empty answer is committed. Each attempt retains its usage and is
measured separately. Context validation precedes
fallback, cancellation propagates, and no tool or entire run is replayed. The
optional suggestion keeps provider-side fallback inside its single bounded call.
With a pinned model and no alternatives, the existing two SDK retries remain;
these share the deadline and appear as one boundary call in telemetry.
ToolRetryMiddleware permits one retry
after 250 ms for ConnectionError/TimeoutError from catalog-declared read-only
tools. Both attempts count toward the 96-tool execution budget and share the
run deadline; no additional model call is required. Returned domain errors are
marked as error ToolMessages with their complete payload preserved. Writes,
Garmin reconciliation (which changes local operation state), validation failures
and failed runs are never automatically replayed. Already-started
synchronous operations cannot be forcibly cancelled or rolled back.

## Capability and context ownership

The capability catalog owns tools, instructions and read-only classifications.
Discovery, binding, policy checks and structural tests consume the same catalog.
Tools call services; they do not import HTTP handlers. New tools are unavailable
to background missions until explicitly classified as read-only.

Chat preloads analytics, planning, strength and Garmin capabilities: loading one cost a
model request per turn, and requests are the free tier's budget. The on-demand
loading machinery (catalog, `load_toolkit`, load-before-execute) stays for
profiles that do not preload. The briefing and the session feedback bind no tool:
`services/briefing.py` and `services/session_feedback.py` compute their facts
(load, form, recovery, today's plan, recent sessions, yesterday's briefing; or the
session's numbers, RPE and notes) and the model answers in one request. An
athlete with nothing to coach on (no load over 28 days, no form model, no
readiness and no session planned that day; for the weekly review, a week with
nothing planned, done or missed)
gets the rule text without a model request; facts that could not be read still
go to the model. The on-demand briefing is produced once per athlete and day
under a per-athlete lock, so athletes never wait for each other's run. The
server files the feedback's ledger entry itself (`services/memory.append_entry`,
dated heading, never twice), so neither mission can mutate training data or
forget to write. Every profile receives the current date. Chat adds new journal
entries through `append_journal` (server-dated heading, deduplicated,
bounded). Its filesystem also exposes `edit_file` for targeted corrections/removal
and `delete` for forgetting an entire current ledger (`notes.md` or `sessions.md`).
Archives and `/attachments/` remain read-only, with an explicit deny for every
other write path. New entries still use `append_journal`; arbitrary file creation
is not exposed. Appends, rotation, edits and deletion share a bounded process-local
lock so overlapping turns in one server cannot overwrite each other's writes.
Model-generated loaded state and client page metadata cannot change these policies.

System skills live in `agent/skills/system/<name>/SKILL.md`, versioned with Git.
Migration 38 creates the shared `app.system_skills` table (no athlete data).
On chat graph construction, `services/system_skills.py` publishes the bundle
idempotently and reads it back from the database. Its content digest identifies
the release, so overlapping deployments cannot replace each other's instructions.
The graph holds a read-only snapshot at `/skills/system/`; both filesystem
permissions and the backend deny edits, deletion, creation and uploads. Graph
state cannot shadow those files. Native Deep Agents skills discovery runs once
per invocation; an adapter rejects incomplete discovery instead of silently
dropping malformed skills. Its native `before_agent` hook then invokes a local
LangChain retriever once, with callbacks forwarded into the run trace. Skills opt
into preloading through `metadata.preload-keywords` and may require attachments
with `metadata.preload-requires: attachments`. BM25 ranks these server-declared
activation terms against the latest human message (accent-insensitive); document
contents and older messages do not activate instructions. This lexical selection
adds no model/embedding request or external I/O, but can miss paraphrases.
The complete catalog stays available by name, description and read-only path,
including skills without activation metadata and retrieval misses.

The composer lists the catalog through `GET /agent/skills` when the athlete types
`/`, with filtering and keyboard/mouse selection before sending. It inserts a
leading `/skill-name` command into the ordinary persisted draft, so thread changes,
reloads and explicit retries retain it without a second browser-state contract.
Only commands in the latest human message select skills. The server resolves
names against native discovery and prioritizes their complete bodies over BM25
matches, bypassing relevance but never permissions or budgets. Unknown names and
explicit selections that exceed the count/token limits fail visibly instead of
being silently reduced to metadata. Listing builds no model and needs no model key.

At most three complete skill files and 2,048 estimated tokens are preloaded;
budget omissions are explicit and their files remain readable on demand. The
context builder places this stable contribution before the profile's current date
and dynamic evidence, includes it in complete-request accounting, and never
reselects during the run. This preserves the skill prefix for provider caching;
it does not guarantee a cache hit. Selection belongs to the invocation context,
never shared graph state or client-supplied files. Skills grant no permissions and
are unavailable to background missions. The bundle allows at most 32 skills of
32 KiB each. Publication adds no model request; the first bundled skill covers
reading a requested day or week in an attached training plan.

The context builder combines the harness/filesystem contribution, mission
instructions, the current date for chat, the catalog of toolkits still loadable,
loaded instructions, a bounded journal excerpt and, for chat, the open page: its
data read by the server at the first model boundary (`context/sections.py`, through
`services/pages.py`) and its route/URL parameters labelled as untrusted client data.
The Log selection includes the selected strength session or the cardio detail digest.
Domain actions invalidate this invocation-local cache for the next model call; reads
reuse it. There is no page-context tool. A
question about the screen therefore needs no tool call. The journal is read again
for each model call, so writes within a turn are visible on the next call; older
entries remain accessible through filesystem tools. Contributions do not mutate
stored messages. A final guard counts messages, system text and tool schemas,
reserves 4,096 output tokens and a safety margin, and rejects requests that still
exceed the envelope.

`LLM_CONTEXT_TOKENS` declares the deployment window (default 65,536, minimum 8,192).
Set it to the actual server/model limit. It is a configured constraint, not a claim
about a dynamically routed provider. Counting is approximate. There is no
server-side compaction: the browser sends the last 30 messages of a thread (it
keeps the whole thread locally) and the journal in `data/agent/memory` is the
long-term memory. Summarizing per request cost a model request on every turn of a
long thread, since nothing persists the summary between requests.

## Completion, transport and observability

Empty conversations use fixed, page-aware starters (`frontend/src/lib/coachPrompts.ts`).
After an interactive answer, `AutoSuggestionMiddleware` invokes one tool-free
completion through `runtime/autosuggestion.py`, using the complete latest user/coach
exchange assembled and budgeted by the context builder. It emits one `suggestion`
custom event before `done`; non-streaming chat exposes the same optional field.
Streaming clients opt in with `supports_suggestions: true`; older cached clients
receive no unfamiliar event and incur no auxiliary model call. Invalid optional
draft events are logged and omitted without failing the answer. The 300-character
limit counts Unicode code points in both Python and the browser.
The browser inserts the suggestion as an editable draft only on successful completion
and only if the athlete has not edited the originating thread's draft meanwhile.
Drafts use the existing browser storage; generated text never enters message history
until the athlete sends it. There are no follow-up cards during a conversation.
The auxiliary call shares the run trace (a `coach_autosuggestion` LLM child span)
and is included in total model calls, timing and `suggestion_calls` telemetry.
OpenRouter reasoning is disabled for this short completion so it cannot consume
the entire output reservation before writing the draft. The exchange is serialized
as user data; a trailing assistant message would be interpreted as a prefill by some providers.
It has five seconds and no SDK retries; provider failures or invalid/oversized output
are logged and leave the answer intact. Near the run deadline it is skipped.
Briefings, feedback and reviews never request a suggestion.

Runtime tool events are projected into the existing SSE protocol by
`api/agent_streaming.py`. Workout events carry session ID/revision, tool call,
thread and durable operation state. The domain service publishes through an injected
callback; the runtime supplies correlation and the API projects `workout_update`.
Only catalog-declared workout actions emit these cards: planning lists and session
inspection remain model data, never interactive cards. The capability middleware
enforces this for returned results and progress callbacks. Cards consume these events
before `done`, independently of truncated tool previews.
Optional LangSmith tracing remains invocation-scoped, including stream
cancellation cleanup, dynamic tool spans and browser thread IDs. Run metadata
names the scoped athlete (`athlete_id`), so model requests can be counted per
athlete. Provider usage logs
retain reported cache/input/output details and model timing without logging the
athlete's prompts. Opt-in LangSmith traces include full inputs, outputs and tool
results, scrubbed by `observability/scrubbing.py` before the client sends
them. It redacts by default rather than naming each leak path: every string
value is replaced by `[REDACTED:<n> chars]` unless its key is one of a short
structural allowlist (a run/tool/message's own name, type, id, tool/trace
id, model identification, status; token usage and timings are already
numbers, never redacted). This covers message content (system, human, AI,
tool, any profile: chat, briefing, feedback, review), tool call/result
arguments, attachments and other graph state carried as plain dicts, and any
object of a type the walker does not recognize, redacted by its class name
rather than passed through unexamined. A run's error string reaches
LangSmith through a different path the client's `hide_inputs`/`hide_outputs`
cannot touch, so `_ScrubbingTracer` (`observability/tracing.py`) keeps only
its exception type and redacts the rest, since an error can echo its own
input. Setup and exported data are
described in the
[deployment runbook](deployment.md#langsmith-agent-tracing). Missing usage remains
unknown, not zero.
Each invocation also logs one `Agent run:` line (`RunStats` on the run context):
model calls, tool calls, model time, time to first token and served models.

Completed chat answers carry their `trace_id` and a signed feedback receipt
in both HTTP and SSE `done`. The runtime supplies that UUID as the graph's
`RunnableConfig.run_id`; it is distinct from the browser thread and child model
message IDs. Browser storage preserves the receipt with that answer.
`api/agent_feedback.py` validates votes and single emoji graphemes;
`observability/feedback.py` owns the LangSmith writes. The receipt binds the root,
thread, authenticated account, athlete, endpoint and project, without introducing
server-side conversation persistence. The tracing key signs the receipt and stays
server-side; rotating it invalidates previous receipts.

Feedback uses `user_score` (1 for useful, 0 for not useful) and `reaction` (the
emoji in `value`, no numeric score), each with a deterministic ID per root.
Updates and removal target those same IDs. A separate synchronous SDK client
confirms writes before the UI marks them saved: no background queue, no SDK or
HTTP retry, 1 s connect / 4 s read timeouts, at most four requests for creation
(existing feedback, project, server info, write). It adds no model requests.
Uncertain writes block new submissions until the athlete explicitly reads the
remote state; a reload converts an in-flight local write to uncertain. Historical
answers without a receipt, untraced and interrupted answers expose no controls.
The emoji is a standard textual feedback, not a promise to reproduce a private
LangSmith UI reaction API. See the [LangSmith feedback guide](https://docs.langchain.com/langsmith/attach-user-feedback)
and [Figma proposal](https://www.figma.com/design/lnwgvzmvsutjFsuZiQ6Mzz?node-id=2-11).

These bounds are not a cumulative token/spend quota. Model fallback attempts
share the run deadline and do not consume additional graph turns, but each counts
in the run's model-call telemetry. Arete has no delegated children to budget. Conversation
history stays in browser storage; Calendar's approval registry is described below.

## Enforcement

`tests/test_architecture.py` checks dependency direction, including function-local
imports, and validates profile/capability consistency. Graph tests cover policy
checks, load-before-execute, concurrent invocation isolation, call/deadline limits,
context schema accounting and completion events. Service/API tests cover domain
behavior and wire compatibility. Trace regression tests cover cancellation, parent spans, metadata and export
failures. Live model evaluations remain opt-in.

## Slack transport

`api/slack.py` verifies Slack signatures and accepts plain text from one workspace,
in direct messages or any channel it was invited to; the Clerk gate lists it as a public
path because the signature is its credential. It acknowledges first, then runs an
attached ASGI background task. `services/slack.py` resolves the author: a full
member's confirmed Slack address must match a verified Arete login, through
`services/slack_athletes.py`, and the task then runs in that athlete's scope,
which owns mirror hydration and flush; the general mirror middleware bypasses
this endpoint to protect Slack's receipt deadline. The service owns bounded
history (other channel members labelled), responses, the per-athlete public-reply
consent and durable delivery reservations; it receives `coaching.run_slack_coach`
as its producer, which passes the answer's visibility as `AgentContext.slack_visibility`
for the context builder's `surface` section. Slack threads own their history;
browser state is unchanged. Migrations 37 and 40 store delivery IDs, consent and one
run reservation per athlete, not conversation text. Failed ambiguous runs stay
reserved for operator review and are never replayed. See [Slack setup](slack.md)
for limits, installation, crash behavior and recovery.

## Document imports and outbound workouts

Conversation messages remain browser-owned. Document originals, extracted blocks,
import drafts and outbound Garmin operation records are deliberately durable in
DuckDB/MotherDuck (migration 13). `services/documents.py` and `services/imports.py`
own these lifecycles. API chat hydration builds an invocation-local StateBackend
view at `/attachments/` before the first model call and rejects missing or unfinished
selected files. The context builder derives a bounded source preview from that same
state, with explicit partial flags and paths for reading the complete extraction.
Browser attachment references survive the message request window.
The filesystem composes that read-only view with the existing ledger backend.
The model can propose a draft but has no confirmation tool; pending imports block
ordinary coach planning writes. Human confirmation commits selected sessions once.

`services/prescriptions.py` owns versioned steps and provenance. Garmin conversion
lives in `garmin/workouts.py`; `services/garmin_export.py` owns both interactive
and daily export, reconciliation and removal with durable reservations and no
ambiguous write replay. Chat can create coach prescriptions without a document;
explicit prescriptions remain excluded from automatic daily adaptation/export.
Legacy sessions use deterministic conversion, and existing Garmin identifiers must
be verified before adoption. Updates require the current revision and mark the
export dirty without transmitting it. See [conversational workouts](conversational-workouts.md)
for UI, limits and verification.
Only `GarminClient` touches the remote service. See [document imports](document-imports.md)
for resource bounds, frontend worker assets, unsupported conversions and acceptance.

## Session page, kept streams and sync feedback

Migration 31 keeps each FIT activity's per-second streams in
`app.activity_streams` (one row per session, one LIST column per channel,
`garmin/streams.py`) and the coach's word on a cardio session in
`app.session_feedback`. Garmin sync, FIT upload and `POST /garmin/sync/reprocess`
fill the streams. `services/activity_detail.py` reads one session for
`GET /analytics/sessions/{id}/detail` (the `/log/sessions/:id` page) and, as a
compact digest without any stream, for the chat's read-only
`get_activity_detail`; Strava rows never reach the model. Analytics come from
`garmin/time_series.py`: decoupling, pace fade, cadence variability, power and
the work intervals of a structured workout (FIT lap intensity).

Migration 32 stores what the streams and the start say about a session's
conditions, once, so no page or card rescans a stream: `app.activity_terrain`
(grade-adjusted pace on Minetti's energy cost of running on a slope, best
climbing speed over 5 to 60 min, time per descent grade band;
`features/terrain.py`) and `app.activity_weather` (Open-Meteo at the start's
hour and place, `services/weather.py`). `services/session_conditions.py` fills
both after a Garmin sync (scheduled or HTTP) and a FIT upload: the weather
requests share a 20 s budget and nothing there can fail the import. Sessions
kept before migration 32 get their terrain from `POST /analytics/terrain/backfill`,
50 at most per call, from the stored streams and without network. The pace
trend reads the GAP of hilly runs; the Terrain section adds the climbing curve
(period against all-time record) and the descent card; the coach's digest gets
GAP, climbing bests and weather.

The daily sync hands the sessions Garmin imported to
`coaching.write_sync_feedback`: one feedback request for up to five sessions,
numbered sections split by `services/session_feedback.py`. A missing, failed or
misnumbered answer leaves each session its rule text. The server files the
journal entries and stores the texts; the feedback profile still binds no tool.

## Optional athlete RPG

`services/gamification.py` owns deterministic XP, cosmetic currency and purchases.
Activity repositories capture evidence inside the session transaction; explicit
projection writes auditable ledger deltas. The model cannot grant rewards or spend
currency. The account preference defaults off, with a deployment kill switch.
Chiron reuses the existing coach runtime and selected conversation documents.
See [gamification system design](gamification-design.md) for rollout, transaction
contracts, limits and the distinction between shipped behavior and Figma scope.
## Identity

`api/auth.py` owns who is calling: a pure ASGI middleware (like the mirror's,
so the coach's stream is not buffered) and the `/auth/config` and `/auth/me`
routes. Off by default; with `ARETE_AUTH=clerk` every non-public request
carries a Clerk session token or the instance's API key, verified in a worker
thread. `services/users.py` owns the accounts table, the rule that attaches an
account to an athlete (its own, or athlete 1 for the first verified owner
address) and the roles: the owner administers by right and names
administrators. `api/admin.py` exposes the accounts behind `require_admin`, and
naming an administrator behind `require_owner` (both in `api/auth.py`); the
scheduler owns releasing a sync lease. Services never import `arete.api.auth`. `services/google_tokens.py` reads the signed-in user's Google
token from Clerk for Calendar, and
`services/oauth_state.py` signs the Strava OAuth state the callback demands.

## Google Calendar

With sign-in on, the composition root adds Calendar to the chat's resolved
capabilities/preloads and compiles a calendar factory into the policy
middleware. Each run gets the caller's own service, built from the Clerk user id
the API stamps on the invocation context from the verified identity; the API key
and background profiles get none. A resolved profile is server-owned and cannot
be supplied through browser page metadata.

`calendar.py` composes the provider adapter and repository without importing the
agent stack; API endpoints use it without paying coaching cold-start costs.
`services/calendar.py` owns permissions, bounded reads, proposals, and execution.
The provider adapter takes the Google token from Clerk (`services/google_tokens.py`)
and calls Google Calendar. Only the HTTP decision endpoint approves writes; the
model has reads and proposal tools. The browser's approval executes the stored
arguments directly.

Migration 17 persists connection selections and a one-shot action registry, keyed
by account and environment, not conversation history. A `calendar_action` SSE
event carries only an action ID. Browser storage keeps that ID; cards reload the
authoritative proposal and outcome from the API. Settings changes invalidate
pending actions, ETags protect existing events, and ambiguous writes are never
replayed.

The training plan sync (`services/calendar_plan.py`, migration 34) is a separate,
standing authorization from Settings, without the model. Plan writers note a
change in a request-scoped flag (`dataio/plan_changes.py`); `PlanSyncMiddleware`
runs a bounded sync after the response and the daily sync runs one too, both
through `calendar.sync_training_plan`, which rebuilds the provider from the Clerk
user id stored on the connection.
See [Google Calendar setup](google-calendar.md) for activation and live testing.

## Personal memory

Migration 20 versions athlete facts and distinguishes explicit declarations,
coach hypotheses and legacy evidence. Active, currently valid facts are mandatory
context; missing reads and oversized contexts fail explicitly. Settings and the
coach use optimistic revisions, and deleting a fact removes its history.

Chat adds bounded BM25 retrieval of existing facts, journals, session text and
thread-scoped document blocks through the central context builder. Reads run in
workers, with a fresh corpus at each model boundary and no extra model request.
Optional traversal follows only authoritative source links and remains disabled
pending behavior evaluations. See [personal memory](personal-memory.md) for
contracts, bounds, migration compatibility and the synthetic evaluation harness.

## Data export and year in review

`services/data_export.py` owns what leaves the database in the athlete's
download: an allowlist of tables plus the journal files, never a credential
table (`tests/test_data_export.py` also rejects token-like columns). Bodies are
built in memory and refused above 4 MB, under Vercel's response limit.
`services/year_review.py` derives a calendar year from the shared TSS estimate
and fitness series, with no model request. Both are plain HTTP reads
(`api/data_export.py`, `api/year_review.py`); the coach never receives them.
