# Coaching stack: responsibilities and dependencies

Arete gives each behavior one owner, with one coaching runtime, browser chat,
three background missions and one shared Slack administrator graph. Browser-owned
conversations, HTTP endpoints, tool names,
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
│   ├── capabilities/        One catalog, native tools and execution policy
│   ├── tools/               Model schemas and domain-service adapters
│   ├── middlewares/         Framework interception/completion hooks
│   ├── backends/            Deep Agents memory filesystem adapter and permissions
│   ├── profiles/            Declarative chat, briefing and feedback configurations
│   └── prompts/             Versioned general/mission instructions
├── services/                Metrics, analytics, planning, settings, pages, coaching, memory
├── observability/           Provider usage, model-boundary and HTTP request timing
└── api/                     HTTP contracts and SSE projection
```

Existing `garmin/`, `strava/`, `strength/`, `features/` and `dataio/` remain domain
modules: moving them would not improve a dependency boundary. The services layer
reuses them. Business code imports neither the HTTP routes nor agent frameworks.

## Composition and execution

`coaching.py` resolves configuration and supplies the concrete model and memory
adapter to the factory. Graph creation is serialized
on first access and cached per athlete, profile and model rollout flag (32 graphs per profile).
Memory roots are captured at construction, so sharing a compiled graph across
athletes would expose the wrong ledger. `services/athlete_scope.py` carries the
trusted identity through HTTP, workers, tools and scheduled jobs; clients cannot
select it. See [multi-athlete storage and rollout](multi-athlete.md). Only this composition root may
import the factory. The runtime receives an already-compiled graph; it never
compiles another agent. Briefing and feedback services receive typed callbacks
rather than reaching back into the factory.

The browser sends human/assistant history. Native graph state owns invocation
messages. `runtime/context.py` owns
server-selected profile, request metadata, deadline and concurrency gate. Clients,
semaphores and credentials do not enter conversation state.

Production sync entrypoints run in AnyIO workers and bridge model execution onto
the server event loop. This avoids sharing the SDK's cached async HTTP connections
across short-lived event loops. Async callers use `invoke_agent` directly.

The execution envelope is five minutes, 24 main graph model turns (the last binds
no tools and asks for an answer stating any incomplete work), 96 tool calls,
and four simultaneous tool executions per invocation. Up to four Jev memory
decisions share the 24-call budget, each bounded to 10 seconds without retries;
the last call remains reserved for an answer. There is no auxiliary suggestion call. Framework recursion is a
separate 200-step backstop. A model call gives up after 60 s, or 30 s without a
streamed chunk. Native LangChain `ModelFallbackMiddleware` tries the configured
candidates in order (at most three, including the primary). The composition root
constructs each fallback candidate with zero SDK retries and no provider-side fallback list,
so one graph turn costs at most three requests, 72 per run. Completions with neither visible text nor a valid tool call are
rejected inside that same fallback boundary, including reasoning-only output
that exhausts the token allowance. Responses ending in `length` (including
concatenated streaming metadata such as `lengthlength`) are also rejected, even
with visible text or parsed tool calls. Their usage remains in telemetry and
their tool calls never execute. With no usable candidate the run fails
explicitly; no empty answer is committed. Each attempt retains its usage and is
measured separately. Context validation precedes
fallback, cancellation propagates, and no tool or entire run is replayed. With a pinned model and no alternatives, the existing two SDK retries remain;
these share the deadline and appear as one boundary call in telemetry.
ToolRetryMiddleware permits one retry
after 250 ms for ConnectionError/TimeoutError from catalog-declared read-only
tools. Both attempts count toward the 96-tool execution budget and share the
run deadline; no additional model call is required. Returned domain errors are
marked as error ToolMessages with their complete payload preserved. Writes,
Garmin reconciliation (which changes local operation state), validation failures
and failed runs are never automatically replayed. Already-started
synchronous operations cannot be forcibly cancelled or rolled back.

### Admin model rollout

Settings → Administration exposes the instance-wide `glm_flash` feature flag,
off by default. `GET/PUT /admin/feature-flags` require the server's admin role;
the PUT requires a strict boolean and rejects unknown arguments. Migration 41
creates `app.feature_flags`, independent of athlete preferences. Enabling requires
`LLM_PROVIDER=openrouter` and an API key. Local mode without sign-in uses the
instance owner, matching the backend's existing authorization.

The composition root reads the flag once per invocation. Enabled, it overrides
`LLM_MODEL` and its fallbacks with `z-ai/glm-5.3-flash`, reasoning effort `low`,
providers sorted by latency, and same-model provider fallback under a hard OpenRouter tariff
cap of $0.15/M input and $0.50/M output tokens. There are zero SDK retries and no
fallback to a different model. This is an experimental route, not a reliability
guarantee or a total-spend cap. The existing 4096 output-token, context, tool and
run limits still apply. Disabled, the configured route and zero-price cap return.
Changing to a non-OpenRouter provider makes the flag inactive.

The persisted value is read across workers, with no process-local flag cache.
Each compiled graph keeps its route and tracing metadata, so ongoing requests
remain consistent while the next invocation sees the toggle. For local validation,
run `make dev`, enable **Coach GLM Flash (payant)** in Administration, then ask
“Liste mes séances prévues cette semaine, sans rien modifier.” Verify GLM in the
trace, disable the switch, and repeat to verify the configured model returns.
Use a database copy for live evaluations that can write training data.

`ProviderAffinityMiddleware` adds OpenRouter's top-level `session_id` inside
each model attempt, including fallbacks, without mutating cached clients. It is
the SHA-256 of a versioned tuple of trusted athlete id, profile and thread id
(or the invocation id for jobs without a thread). The same conversation keeps
its key across user turns; different athletes, profiles and conversations do not
share it. No new conversation state or local provider cache is introduced.
Both free and paid OpenRouter policies use `provider.sort: "latency"` without
`provider.order`, which would override sticky routing. Other providers receive
neither this identifier nor OpenRouter-specific routing settings. Pricing caps,
reasoning and existing request settings are preserved. This is best-effort
provider affinity, not a promise of cached tokens or a latency bound; check usage
telemetry for actual cache reads. See [OpenRouter sticky routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
and [provider sorting](https://openrouter.ai/docs/guides/routing/provider-selection).

## Capability and context ownership

The capability catalog owns tools, instructions and read-only classifications.
Discovery, binding, policy checks and structural tests consume the same catalog.
Tools call services; they do not import HTTP handlers. New tools are unavailable
to background missions until explicitly classified as read-only.

Chat binds analytics, planning, strength and Garmin tools natively at graph construction.
Calendar is added only by server configuration. No discovery/load tool or loaded
state exists: every current profile either has its tools immediately or has none.
The native ToolNode validates arguments, injects ToolRuntime and executes tools.
Capability middleware checks server policy again, counts attempts, invalidates page
context after writes and emits progress; it never invokes a tool itself.
The briefing and the session feedback bind no tool:
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
forget to write. Every profile receives the current date: the athlete's, in
the timezone of their settings (`services/settings.athlete_today`), which every
server path meaning "today" shares (plan decisions, briefing, weekly review,
metric windows, the daily batch's marker). Chat adds new journal
entries through `append_journal` (server-dated heading, deduplicated,
bounded). Its filesystem also exposes `edit_file` for targeted corrections/removal
and `delete` for forgetting an entire current ledger (`notes.md` or `sessions.md`).
Archives and `/attachments/` remain read-only, with an explicit deny for every
other write path. New entries still use `append_journal`; arbitrary file creation
is not exposed. Migration 43 makes the database journal authoritative behind
the Deep Agents backend. All consumers read through `services/memory.py`;
transactional writes check revisions and report conflicts without replay.
A one-time import reads the MotherDuck mirror or local DuckDB ledger files.
Deletion leaves a tombstone, so an old copy cannot resurrect forgotten content.
Stop legacy file-writing processes before the first import; there is no automatic
fallback to those copies after import. Client messages and page metadata cannot
change these policies.

System skills live in `agent/skills/system/<name>/SKILL.md`, versioned with Git.
Migration 38 creates the shared `app.system_skills` table (no athlete data).
On chat graph construction, `services/system_skills.py` publishes the bundle
idempotently and reads it back from the database. Its content digest identifies
the release, so overlapping deployments cannot replace each other's instructions.
The graph holds a read-only snapshot at `/skills/system/`; both filesystem
permissions and the backend deny edits, deletion, creation and uploads. Graph
state cannot shadow those files. Native Deep Agents skills discovery runs once per invocation; its adapter rejects
incomplete discovery instead of silently omitting malformed server files. Only names,
descriptions and paths enter the system catalog. Attachment bodies likewise remain out of SYSTEM: the manifest lists paths and sizes, with content read through filesystem tools. Skill bodies enter conversation
messages through real `read_file` tool results, never through lexical retrieval or
system-prompt preloading. An attachment adds an explicit instruction to consult
`document-planning`; it does not itself load the body or grant any permission.

The composer lists `GET /agent/skills` when the athlete types `/`, preserving keyboard
selection and the ordinary browser draft. Up to three leading `/skill-name` commands
resolve against trusted metadata. Unknown names fail explicitly. Read bodies and
references only as needed, reusing results already present in the invocation.
The browser persists user/assistant history, not tool results: a later user turn
must read a relevant skill again. No thread persistence is introduced.
The bundle remains bounded to 32 skills of 32 KiB each; filesystem reads are bounded
to 200 lines per call and complete requests are budgeted without silent truncation.

The context builder combines the harness/filesystem contribution, mission
instructions, the current date for chat, the skill catalog and authorized toolkit instructions, a bounded journal excerpt and, for chat, the attachment manifest and open page: its
data read by the server at the first model boundary (`context/sections.py`, through
`services/pages.py`) and its route/URL parameters labelled as untrusted client data.
The Log selection includes the selected strength session or the cardio detail digest.
The Planning read adds the sessions done since its window's start (at most 15).
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
keeps the whole thread locally). Durable facts and the transactional journal are
long-term memory; `data/agent/memory` is only a legacy import source. Summarizing per request cost a model request on every turn of a
long thread, since nothing persists the summary between requests.

## Native training operations

The planning tools are list, inspect, create, update and delete. The update takes
`session_id`, `revision` and a typed `changes` object. Omission preserves fields;
zero or empty clears optional scalar fields; explicit null is refused. Prescription
replacements clear stale scalar targets and structured workouts reject conflicting
target edits. Browser and coach prescription edits share repository transactions,
revision checks and Garmin reservation checks. Domain rules remain in services and
repositories, not in tool adapters.

`save_workout` parses and saves completed strength work in one call. Unknown exercises
or unparsed lines reject the entire coach save and report corrections. The Log page
retains its explicit preview behavior. Session/exercise/set persistence is transactional.
A skill describes how to interpret documents; planning owns creation; Garmin owns
export. Google Calendar still requires approval through its existing HTTP/UI cards.

## Completion, transport and observability

Empty conversations use fixed, page-aware starters (`frontend/src/lib/coachPrompts.ts`).
Answers make no auxiliary completion and never fill the composer automatically.
Manual drafts and existing browser histories are preserved. Old clients may send
`supports_suggestions`; it is ignored. New clients ignore retired suggestion events
during rolling upgrades and never turn them into drafts.

The shared `agent/runtime/streaming.py` projection turns graph chunks into bounded
message and tool events. `api/agent.py` serializes them into the existing SSE protocol;
the Slack composition passes them to its transport callback. Workout events carry session ID/revision, tool call,
thread and durable operation state. The domain service publishes through an injected
callback; the runtime supplies correlation and the API projects `workout_update`.
Only catalog-declared workout actions emit these cards: planning lists and session
inspection remain model data, never interactive cards. The capability middleware
enforces this for returned results and progress callbacks. Cards consume these events
before `done`, independently of truncated tool previews.
Optional LangSmith tracing remains invocation-scoped, including stream
cancellation cleanup, native tool spans and browser thread IDs. Run metadata
names the scoped athlete (`athlete_id`), so model requests can be counted per
athlete. Run logs include skill read count, latency and approximate result tokens separately
from model calls. Provider usage logs
retain reported cache/input/output details and model timing without logging the
athlete's prompts. Opt-in LangSmith traces include full inputs, outputs and tool
results; setup and exported data are described in the
[deployment runbook](deployment.md#langsmith-agent-tracing). Missing usage remains
unknown, not zero.
Each invocation also logs one `Agent run:` line (`RunStats` on the run context):
model calls, tool calls, model time, time to first token and served models.
`first_result_ms` measures the first successful domain tool result, or completion
of an answer when no domain tool succeeds. Preparatory file reads and narration do
not count as a useful domain result; it is a latency proxy, not a quality score.

Every HTTP request logs one `HTTP request:` line (`observability/http.py`, the
outermost pure-ASGI middleware): status, total time to the last body byte, database
statements and their time, auth/mirror-hydrate/handler/mirror-flush phases and
whether it was the process's first request. The path is logged without its query
string, never a statement's text. `dataio/db.py` wraps each connection it hands out
so `execute`/`executemany` count in a request-local ContextVar, which AnyIO worker
threads inherit. A response whose length is known also carries `Server-Timing`
(`auth`, `hydrate`, `db` with its statement count, `app`, `total`); a stream is only
logged, so it is never buffered.

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

`services/slack.py` also owns the invocation-local Slack stream: session status,
batched text/task updates, and final message replacement. It receives plain event
dictionaries and never imports the agent framework. `coaching.run_slack_coach`
uses the shared runtime stream and projection; a completed tool-free model update
supplies the canonical final answer, while token events remain provisional.
Private channel replies select their DM destination before any progress is sent.
The stream starts on the first text or tool event without a placeholder; the
original user message receives the logo reaction. Finalization replaces provisional
content. Migration 42 records destination thread IDs in the existing delivery
ledger so interrupted output cannot be consumed as valid thread history, even
without a visible marker. The per-athlete reservation remains held
through status cleanup. No new model call, persistence layer or background queue
is introduced.

## Documents, direct session creation and outbound workouts

Conversation messages remain browser-owned. Document originals, extracted blocks
and outbound Garmin operation records are durable in DuckDB/MotherDuck (migration 13).
`services/documents.py` owns documents. API chat hydration builds an invocation-local
StateBackend view at `/attachments/` before the first model call and rejects missing
or unfinished selected files. The context builder derives a bounded source manifest
from that same state, with sizes and paths for reading the complete extraction. Browser attachment references survive the message request window.
The filesystem composes that read-only view with the existing ledger backend.

`create_planned_session` writes directly through `services/planning.py`, using typed
dates, sport/type enums, bounded targets, a `Prescription` object and optional typed
source references. Source quotes are checked against documents in the server-selected
thread before persistence. Attachments do not block planning or Garmin tools. There
are no import tools, approval cards, import endpoints or import SSE events. Historical
`coach_imports` rows remain inert; existing migrations and saved sessions are retained.

`services/prescriptions.py` owns versioned steps and provenance. The tool schema adapter
unrolls the existing two-repeat-level bound so provider conversion preserves the
nested argument types without changing the HTTP schema. Strength still uses the grammar. Garmin conversion lives in
`garmin/workouts.py`; `services/garmin_export.py` owns interactive and daily export,
reconciliation and removal with durable reservations and no ambiguous write replay.
Explicit prescriptions remain excluded from automatic daily adaptation/export.
Legacy sessions use deterministic conversion, and existing Garmin identifiers must
be verified before adoption. Updates require the current revision and mark the
export dirty without transmitting it; a status change alone (done, skipped) keeps
the export state, since Garmin holds no status. See [conversational workouts](conversational-workouts.md).
Only `GarminClient` touches the remote service. See [documents](document-imports.md)
for resource bounds, frontend worker assets, unsupported conversions and acceptance.

## Session page, kept streams and sync feedback

The System page's **Tout l’historique** Garmin option starts one browser-owned
import across sequential SSE requests of 20 activities. `garmin/client.py` fetches
one SDK page per request; `garmin/sync.py` reuses the usual FIT, matching and save
workflow. Each continuation re-reads the preceding activity ID to detect shifting
Garmin offsets and stops explicitly if the archive changes. Already imported IDs
are checked against the athlete's entire visible archive, excluding Strava IDs;
the check is no longer limited to the latest 1,000 sessions.

`frontend/src/lib/garminSync.ts` owns pagination and aggregates counts. The UI
shows an indeterminate progress bar because the total is unknown until the final
page. Bounds are 20,000 activities, 1,001 requests (including a possible empty
final probe), four hours overall and the existing 20-minute per-request timeout.
Every page is paced by the existing three-second Garmin delay, even when its
activities are all skipped. Limits, failed streams and cancellation stop the
import without replay; committed sessions remain. Leaving the page aborts the
browser operation. A manual restart scans from the beginning and skips known
activities. This is not a detached job and requires keeping the page open.

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

Chat can run the sync button's import itself (`sync_garmin_activities`,
`services/garmin_sync.py`): at most 20 activities, one run per athlete and
process, stopped between activities 60 s before the run deadline, never
replayed. It returns the imported sessions, and as a write it drops the cached
page so the next model call reads it again. It writes no sync feedback.

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
capabilities and compiles a calendar factory into the policy
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

## Proactive coaching

`services/coach_today.py` projects the existing briefing, pending planning
proposals and session follow-ups for `GET /coach/today`. Displaying or responding
to these cards makes no model request. Scheduled sync and relevant writes prepare
deduplicated records. A proposal never changes the plan until the athlete accepts:
the service checks the session revision, status and Garmin reservations, then
updates the same session and the decision in one transaction. Structured
prescriptions stay in chat. The former immediate adaptation endpoint refuses writes.

`services/coach_followup.py` owns one question per day and per session, its
48-hour expiry, snooze/skip state and revision-checked RPE response. References
in HTTP/SSE and browser storage contain identifiers; the server reloads the
authorized record. Recent responses contribute to chat and the weekly review,
without treating the coach's interpretation as athlete evidence.

The panel exposes sourced memory through one receipt after a successful write.
Files attach through the composer; a paperclip counter opens their details
without adding a document section or replacing the draft. Four versioned skills
cover athlete learning, session debriefs, adjustments and follow-up; their bodies
are read only when needed.

## Personal memory

Migration 20 versions athlete facts and distinguishes explicit declarations,
coach hypotheses and legacy evidence. Active, currently valid facts are mandatory
context; missing reads and oversized contexts fail explicitly. Settings and the
coach use optimistic revisions, and deleting a fact removes its history.

Chat adds bounded BM25 retrieval of existing facts, journals and session text
through the central context builder. Document blocks remain accessible through
filesystem tools rather than being injected again as retrieved system context. Reads run in
workers, with a fresh corpus at each model boundary and no extra model request.
Optional traversal follows only authoritative source links and remains disabled
pending behavior evaluations. See [personal memory](personal-memory.md) for
contracts, bounds, migration compatibility and the synthetic evaluation harness.

`FactMemoryMiddleware` (`agent/middlewares/fact_memory.py`) binds the durable-fact
tools and adapts runtime provenance and budget hooks. `JournalMiddleware`
(`agent/middlewares/journal.py`) binds only dated `append_journal` operations.
The native `FilesystemMiddleware` receives any `BackendProtocol`; its configuration
helper owns only bounded read/search schemas, with no journal or skill dependencies.
The composition root mounts the DB-backed `LedgerBackend`, thread-local attachment
`StateBackend` and immutable `SystemSkillsBackend` through `CompositeBackend` and
passes that same filesystem to skills discovery. Ledger and skill text backends
implement the public backend protocol, including typed results and inherited async
workers, without overriding private `StateBackend` methods. Their read-only base
rejects mutations; only the ledger explicitly implements transactional edits/deletes.
The profile selects `fact_memory_tools`, `journal_tools` and `filesystem_tools`
independently; the capability gate checks them at execution too. No filesystem or
memory middleware appends personal context: the central context builder still owns
facts, journal excerpts, retrieval and token accounting.

This follows the [Deep Agents backend contract](https://docs.langchain.com/oss/python/deepagents/backends#custom-backends)
and native filesystem middleware composition, checked against pinned Deep Agents
0.7.4. The pinned middleware accepts permissions through `_permissions`; the helper
isolates that version-specific setting. Automatic history/tool eviction stays off
because the context builder accounts for the complete request.

New-fact writes use a bounded Jev decision to detect semantic duplicates or
contradictions among up to seven complete candidates. `services/fact_memory.py`
owns reconciliation; `agent/models/jev.py` owns the Decisions API adapter and
`agent/runtime/fact_memory.py` owns provenance, budget and telemetry. Composition
injects the client, without changing the cached chat route. This paid memory route
is controlled by `MEMORY_JEV_ENABLED`, separately from GLM, with an explicit price
cap. Exact duplicates and explicit revision-checked updates need no Jev call.
Failed classification performs no write; a changed fact snapshot invalidates a
decision without replay. See the memory document for thresholds and limitations.

## Data export and year in review

`services/data_export.py` owns what leaves the database in the athlete's
download: an allowlist of tables plus the journal files, never a credential
table (`tests/test_data_export.py` also rejects token-like columns). Bodies are
built in memory and refused above 4 MB, under Vercel's response limit.
`services/year_review.py` derives a calendar year from the shared TSS estimate
and fitness series, with no model request. Both are plain HTTP reads
(`api/data_export.py`, `api/year_review.py`); the coach never receives them.

## Slack product and private administration

Slack administrators have a measured, bounded Jev classification step before
delivery selection. `services/jev.py` is the reusable OpenRouter Decisions service:
request construction, typed Choice/Noul/Score responses, common usage/error logs,
one request with zero retries, a 15 s deadline,
at most 32 questions with 64 criteria each, a 256 KiB request and 64 KiB response.
`JevService.build_request()` snapshots state, questions, session identity and the
bounded provider policy; `decide()` validates, sends and traces that same payload.
It has no Slack or agent dependency; callers own questions, token accounting and
how decisions affect behavior. It never constructs an agent or grants permission.
The surface adapter sends three Choice questions together to `typesafe/jev-1.13`,
independently of the coach's model/GLM flag. This explicitly paid classifier has
its own $0.042/M input and $0/M output price cap, with no provider fallback.
The complete request must fit the smaller of the deployment window and 32,000
tokens (the conservative published Decisions limit), with output/safety reserves;
history is never trimmed. Decisions exposes no temperature or max_tokens setting.

`middlewares/surface.py` is a thin pre-invocation adapter;
`runtime/surface.py` owns the decision and accounting. `coaching.py` selects one
cached Slack graph per athlete and effective model flag, independent of intent.
`ProfilePolicyMiddleware` resolves an invocation-local policy through
`runtime/policy.py`: personal coaching, product coordination, private administrator
reads, or a tool-free clarification. The graph keeps one Chiron identity; these
policies select instructions, context and tools, not another agent.

The context builder filters tool schemas before accounting and binding. Capability
middleware checks the same policy again at execution, including filesystem and
journal tools that remain registered in the shared graph. Product, private and
ambiguous turns neither inject nor retrieve personal context or coaching skills.
Ambiguity reaches the agent for a contextual answer/question, rather than returning
a fixed role-selection message. Classification failure still aborts without an action.
A trusted preflight budget hook charges classification against the model-turn limit;
graph-private counters are not accepted as invocation input.
The Slack composition opens one `arete_coach` trace around dispatch, so the
`@traceable` classifier (`classify_slack_intent`, including its typed decision)
and the streamed graph/tools share one root. The Jev service uses
`@traceable(run_type="llm")`, named `slack_surface` for this caller and
`jev_decision` otherwise; it exports the request, typed answers, served model,
token usage and reported cost. Failed/cancelled requests close their spans with
an error. Credentials and HTTP clients never enter trace inputs. The parent stays open across private
destination selection and delivery cleanup. Tracing remains optional; provider
and Slack clients are excluded from the decorated functions' exported inputs.

The capability catalog declares Slack writes separately from training writes.
`services/slack_identity.py` owns verified account bindings and current admin
checks; `services/slack_product.py` owns bounded member lookup, external-operation
receipts and scheduling; `services/admin_athlete_data.py` authorizes and audits a
read before temporarily entering its target athlete's scope. Tools adapt these
contracts and never select a graph or provider. Cached graphs hold no Slack client.

Transport receives a prepared producer before it chooses the output destination.
Private reads force an administrator DM before any model answer/tool progress;
a durable thread ownership marker prevents a later topic change from restoring
outbound tools or granting another participant access. Slack remains the source
of conversation history. The new operation receipts contain outgoing bodies,
not copies of conversations. Existing non-admin Slack and browser coaching,
background missions, Calendar approvals and training-write policies are preserved.
