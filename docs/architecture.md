# Coaching stack: responsibilities and dependencies

Arete gives each behavior one owner, with one coaching runtime, browser chat,
four background missions and one shared Slack administrator graph. Browser-composed, server-archived
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
│   ├── profiles/            Declarative chat, briefing, feedback, review and evening configurations
│   └── prompts/             Versioned general/mission instructions
├── services/                Metrics, analytics, planning, settings, pages, coaching, memory
├── observability/           Provider usage, model-boundary and HTTP request timing
└── api/                     HTTP contracts and SSE projection
```

Existing `garmin/`, `strength/`, `features/` and `dataio/` remain domain
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
Composition never runs on that loop: the rollout-flag read, the graph lock and a
compile would stall every other request and stream, and `coaching.py` refuses
them there. Browser chat resolves the athlete clock, attachments and cached graph
in one worker hop per request; Slack and each automation segment likewise compose
(the latter also records its route) in a worker before streaming on the loop.

The execution envelope is five minutes, 24 main graph model turns (the last binds
no tools and asks for an answer stating any incomplete work), 96 tool calls,
and four simultaneous tool executions per invocation. Up to four Jev memory
decisions share the 24-call budget, each bounded to 10 seconds without retries;
the last call remains reserved for an answer. There is no auxiliary suggestion call. Framework recursion is a
separate 200-step backstop. A model call gives up after 60 s, or 30 s without a
streamed chunk. Native LangChain `ModelFallbackMiddleware` tries the configured
candidates in order (at most three, including the primary). The composition root
constructs each fallback candidate with zero SDK retries and no provider-side fallback list,
so one model attempt chain costs at most three requests. In browser chat, native
context-overflow recovery can repeat that chain once after compaction: at most
144 main-model requests over 24 graph turns, plus the bounded summary requests
described below. Completions with neither visible text nor a valid tool call are
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
Use a database copy when manually testing coaching writes.

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
Analytics includes the bounded, read-only `query_training` adapter over the
[typed training catalog](typed-training-retrieval.md): explicit dates, filters,
aggregates and evidence IDs, with daily and session grains kept separate.
Training queries use the typed catalog and do not accept agent-written SQL.
Calendar is added only by server configuration. No discovery/load tool or loaded
state exists: every current profile either has its tools immediately or has none.
Browser chat also binds the read-only `visualization` capability. `render_chart`
validates static HTML/SVG through `services/charts.py`; its JSON contract is shared
with the browser. It retains at most four immutable, 16 KiB chart receipts in the
invocation context, outside compactable conversation state. A native ToolMessage
contains a short model-visible receipt and the complete artifact. No database or
network operation is involved. Slack's compiled and derived coaching profiles,
automations and background missions do not expose this capability. The
`chart-rendering` system skill supplies the authoring format through `read_file`.
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
go to the model. `GET /tips/daily` only reads: without a stored briefing it
answers `pending` and never imports the agent stack. The dashboard then sends
`POST /tips/daily`, a long request it does not wait on, and polls the GET (5, 10,
20 s, then an "Actualiser" button that sends the idempotent POST again); each
day has its own read and request. The briefing is produced once per athlete and
day under a per-athlete lock and a `pending` row in `app.coach_briefings`, dated
in naive UTC, that stops another instance; a concurrent request answers
`pending` at once. A claim older than the run bound belongs to a stopped run: it
is settled with the rule text and a failed row, never by a second model request.
Each briefing stores the SHA-256 of the facts it was written from (migration 46).
The daily sync recomputes them without a model request and keeps a briefing the
dashboard asked for unless they changed; it waits up to a minute for one being
written. A rewrite is marked `updated_after_sync`; a failed rewrite keeps the
briefing it would have replaced. The dashboard leads with it and says when it was
written and, after a sync rewrite, when the sync replaced it; briefing times
are naive UTC, like the claim, since instances on other clocks share the
database. The athlete's useful/not-useful rating and
legacy short comment live on the briefing's row (migration 48): one per briefing,
idempotent, stored only, since no prompt reads them. `GET /tips/history` lists
previous days on demand. `GET /tips/briefings/{id}` reads the athlete's selected
usable briefing without loading the agent stack. Dashboard title/actions create a
fresh browser thread and store its `CoachReference` beside messages and drafts.
The full briefing and shared `FeedbackRating` controls appear inside Chiron;
opening makes no model request and leaves the previous draft/attachments intact.
Each explicit message includes this thread's `coach_ref`, which the context
builder resolves by id. Switching threads switches references; reload restores
both. The briefing is context, not an invented assistant message or trace receipt.
Existing comments remain readable, while further discussion uses the common composer. Athletes never wait for each other's run. The
server files the feedback's ledger entry itself (`services/memory.append_entry`,
dated heading, never twice), so neither mission can mutate training data or
forget to write. Every invocation captures one timezone-aware instant on the
athlete's clock (`services/settings.athlete_now`); its calendar date agrees with
`services/settings.athlete_today`, which every
server path meaning "today" shares (plan decisions, briefing, weekly review,
metric windows, the daily batch's marker). Reading that clock is a settings
query: async code passes it in through `read_athlete_clock` (an AnyIO worker),
and `AgentContext`'s default refuses to run on the event loop. The Slack surface
shows the same instant in the Slack profile's zone. Chat adds new journal
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
The catalogue also exposes a French `display_name` from native frontmatter
metadata (at most 80 characters, falling back to the stable slug). Ten bundled
methods include training trends, race preparation, return to training and strength
progression. Display metadata grants no tool and loads no body.
The browser persists user/assistant history, not tool results: a later user turn
must read a relevant skill again. Archives store the rendered browser history, not tool results or graph checkpoints.
The bundle remains bounded to 32 skills of 32 KiB each; filesystem reads are bounded
to 200 lines per call and complete requests are budgeted without silent truncation.

The context builder combines the harness/filesystem contribution, mission
instructions, the skill catalog and authorized toolkit instructions, a bounded journal excerpt and, for chat, the attachment manifest and open page: its
data read by the server at the first model boundary (`context/sections.py`, through
`services/pages.py`) and its route/URL parameters labelled as untrusted client data.
The Log selection includes the selected strength session or the cardio detail digest.
The Planning read adds the sessions done since its window's start (at most 15).
Domain actions invalidate this invocation-local cache for the next model call; reads
reuse it. There is no page-context tool. A
question about the screen therefore needs no tool call. The journal is read again
for each model call, so writes within a turn are visible on the next call; older
entries remain accessible through filesystem tools. Contributions do not mutate
stored message content. `RuntimeContextMiddleware` owns the clock: once before
each chat run, it stamps the new human message's `additional_kwargs.arete_sent_at`
from the invocation's athlete-local instant. It renders date, time, UTC offset
and tomorrow's date into copies of human messages after native summarization,
before the final budget guard. Its SYSTEM instruction is constant. If compaction
removed the current question, its summary receives the same turn-time reference.
The middleware has no invocation state on the cached graph.

HTTP returns `sent_at`; streaming returns the same value in `X-Arete-Sent-At`
before the first token, including when the run later fails. A header keeps older
SSE parsers compatible. The browser saves it as `sentAt` on the originating human
message and sends it back as `sent_at` on subsequent turns. Historical timestamps
are timezone-aware browser data, not permissions; the current timestamp always
comes from the server. Legacy messages stay undated. Replaying a saved offset
keeps historical prompt bytes unchanged across midnight and timezone changes.
An explicit retry replaces the question with a new turn and a new timestamp.

This uses LangChain's [transient message overrides](https://docs.langchain.com/oss/python/langchain/context-engineering#messages)
for rendering, without changing raw content or adding model requests. Timestamp metadata persists with the raw history in the browser and the conversation archive. Page, ledger and other existing contributions can still invalidate
their own prefix. The supplied time is the start of the turn, not a live clock.
Background profiles retain their date in SYSTEM through the same middleware.
A final guard counts messages, system text and tool schemas,
reserves 4,096 output tokens and a safety margin, and rejects requests that still
exceed the envelope.

`LLM_CONTEXT_TOKENS` declares the deployment window (default 65,536, minimum 8,192).
Set it to the actual server/model limit. It is a configured constraint, not a claim
about a dynamically routed provider. Counting is approximate. Browser chat uses
native Deep Agents summarization within an invocation; the browser still sends
the last 30 messages and archives its complete thread on the server after each settled exchange. The model profile
uses this configured window for the native 85% trigger and 10% retained tail.
Raw messages remain in graph state and compacted history remains readable under
`/conversation_history/`. Browser chat has no checkpointer: summaries and ephemeral files
are not carried into the next browser request, so long threads may summarize
again. Durable facts and the transactional journal are long-term memory;
`data/agent/memory` is only a legacy import source.

## Scheduled automations

The `automation` profile is composed in `coaching.py` with the personal training
capabilities and `ask_athlete`, without automation management, administrator or
Slack coordination tools. API handlers and chat tools adapt the same
`services/automations.py` contracts. A scheduled occurrence snapshots its definition
and revision; browser conversations remain local.

`services/automation_schedule.py` owns typed schedules and their timezone rules.
Session triggers use registration in Arete, not the activity's end time. Existing
activity events supply canonical identity; strength links are resolved directly
even when RPG projection is disabled. Activation excludes existing sessions.
The dispatcher keeps only the latest overdue recurring occurrence runnable and
records older ones as missed. Database claims and two shared worker slots prevent
the Docker and Vercel dispatchers from owning the same run concurrently.

LangChain 1.4.6's `HumanInTheLoopMiddleware(interrupt_mode="per_call")` intercepts
each business write before execution/retry middleware. `ask_athlete` accepts a
`respond` decision without mutating training records. Decisions are stored against
their interruption ID after owner, revision, state, expiry and JSON-schema checks;
only the dispatcher resumes the graph. Approved calls recheck capability policy
and a captured business-data snapshot. This snapshot is deliberately conservative:
unrelated changes can invalidate an approval, including another approved write
in the same run. A stale approval fails explicitly rather than using old data.

`agent/runtime/checkpoints.py` implements the public `BaseCheckpointSaver` contract;
all checkpoint I/O lives in `dataio/automation_checkpoints.py`. Migration 50 adds
athlete-owned definitions, runs, decisions, counters, receipts, checkpoints and
inbox references. Runtime clients, credentials and gates stay outside checkpoints.
Each write records a durable receipt before execution. An uncertain outcome stops
the run without automatic replay. Abandoned leases become interrupted. Completed
checkpoint chains expire after 30 days while product history stays available;
export and account deletion include the new athlete-owned records.

Limits survive every resume: 20 active definitions, five new runs per athlete/day,
eight model turns, 24 model requests including fallbacks, 24 tool calls, four
resumes, 48 hours waiting for a human, 120 seconds per segment and 240 active
seconds total. A dispatcher starts at most two segments within 270 seconds.
Pending work remains visible. Inbox read, archive and decision are separate
operations; push delivery failure leaves the mission outcome and inbox intact.

The UI shares inbox query state between the bell, home priorities and `/follow-up`.
Questions and approvals use the existing Chiron panel, preserving the conversation
draft. Semantic deduplication of free-form automation questions against legacy
check-ins, and a dedicated activation card in chat, remain follow-up work.

### Coordinated attention and grouped approvals

`services/coaching_attention.py` projects existing source records; source services
still own questions, answers and decisions. Migration 53 adds scoped attention
claims, local-day delivery counters and immutable planning change sets. These
tables participate in export/deletion, and contain no browser conversation state.

The independent admin flag `coaching_attention` and athlete preference
`coordinated_coaching` are both required for active delivery coordination. Off
means an observation projection and the existing source cards. A pass reads at
most 101 candidates, rejects excess above 100, ranks three visible items plus a
remaining count, and has a five-second deadline. Ranking needs no model call.
Pending decisions rank before availability questions, other questions and recaps.
Revisions, expiry, snoozes, late training and stored RPE determine eligibility.

`notifications.notify` and `inbox.publish` share one event identity and delivery
reservation. Quiet hours, opt-outs and device availability are checked first;
an atomic claim plus daily counter bounds outbound coaching to zero–three attempts
(default two) on the athlete's local date. Imports retain their existing transport
policy. Unknown push outcomes consume their reservation. Inbox read/archive and
delivery receipts never close a source question. The typed `ask_athlete` subject
is validated before native HITL: RPE goes through `coach_followup`, and an existing
routine question or recorded answer is reused. Free-form questions stay unclassified.

`services/planning.py` owns a one–seven-session preview/apply contract using the
same `SessionChanges` validation as a single edit. Previews expire within 48 hours
and at the relevant session's day boundary. Apply rechecks all source revisions
inside one transaction, commits all edits plus a receipt, and accepts a repeated
operation ID only as a receipt read. An explicit different operation conflicts;
no entire run or remote write is automatically replayed. The capability catalog
classifies previews as proposals, distinct from reads; budget and effect tracking
still apply, while native HITL asks once for the grouped apply. The UI shares the
same before/after review between Planning and a routine interrupt. Garmin export
remains explicit and Calendar keeps its existing reconciliation owner.

See [the unified experience](unified-experience.md) for Figma mappings, migration,
rollout switches, request envelope and verification boundaries.

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
A correction goes through `list_strength_sessions` then `update_workout`, which
replaces the session's exercises and sets in place under the same rule: the id,
date, Garmin link and game event stay, and records are recomputed.
A skill describes how to interpret documents; planning owns creation; Garmin owns
export. Google Calendar still requires approval through its existing HTTP/UI cards.

A Garmin strength activity no Muscu log completes becomes a draft awaiting its
loads (`strength/drafts.py`, migration 54's `app.strength_drafts`, one per
activity). The sync opens it from Garmin's `summarizedExerciseSets`, already in
the activity list (no extra request); Arete imports no load from it. Names go
through a reviewed table (`data/garmin_exercises.py`): only a Garmin name whose
catalog exercise is the same movement and equipment gets its id, a category
alone only from an allowlist and only without a finer name. Anything else stays
free text, listed beside the pre-filled `3x10` notation rather than written
into it, so neither the draft nor the parser's fuzzy matching guesses a near
exercise and sets false records. Only activities of the last seven days get a
draft on import, so a first full-history import does not flood the Journal; an
older unlinked strength activity gets one when the athlete taps « Ajoute tes
charges » (Journal's cardio list, or the session page, which reads the linked
log from the activity detail's `strength_log_id`), empty since Garmin's summary
was not kept; Garmin's names later fill an empty draft, never replace names.
A draft is not a session: only the Journal reads it, so until it is completed
the Garmin activity alone counts (load, gamification, week facts, missed-session
check, by that activity's own rules) and the muscle map and weekly volume have
no sets from it. The Journal lists 20 drafts with their total and a bounded
« Tout ignorer » (confirmed with its total); it leaves out a day that already has
an unlinked log, which is probably that session, and the cardio row and session
page say so beside « Ajoute tes charges » (`strength_unlinked_log_id`), linking
to that log, without hiding a genuine second session. There is no automatic expiry. Completing a draft parses
the notation with the grammar (no model) and saves the log linked to the
activity in one transaction, with its game evidence under the settled-rewards
rule of an automatic link; records follow as on any save. The draft row is
claimed by delete-and-rewrite, which conflicts with any other write of the
row (every draft write returns, see Concurrent writes): a stale tab
gets 409, never a second log; an interrupted save that left the draft pending
asks to retry (503). A log linked to the same activity by another request at
that very moment is not detected (two logs, both linked). Dismissing hides a
draft; asking again reopens it.

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
Chart artifacts use a separate, versioned `chart_card` event correlated by run and
tool call. SSE sends it only when `supports_chart_cards=true`; older clients keep
the tool activity and standalone textual answer. Non-streaming HTTP returns
`charts` from the invocation receipts, even if native compaction changed messages.
The browser stores chart parts with their owning thread, never sends their HTML
back as model history, and uses the existing explicit storage quota errors.
Conversation archives receive chart titles and summaries as text, excluding the
HTML and render-tool previews. Archive refreshes restore matching local chart
cards; automatic cache eviction preserves threads containing these local artifacts.
The chart component loads its sanitizer and embedded local fonts on demand. A
strict [DOMPurify allowlist](https://github.com/cure53/DOMPurify) and an opaque
[`sandbox=""` iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox) isolate the document;
its CSP permits only trusted inline styles and data fonts, with no scripts or
network resources. Theme tokens are injected by the host, never model-authored CSS.
Invalid documents show their summary and a visible error instead of a partial chart.
The native skill-read → chart → answer path is tested with the compiled factory and
simulated responses: `Agent run: calls=3 tools=2`, including one skill read and no
auxiliary model. Existing model, tool and time budgets remain unchanged.
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
history is composed in the browser and archived as described below; Calendar's approval registry is described below.

## Enforcement

`tests/test_architecture.py` checks dependency direction, including function-local
imports, and validates profile/capability consistency. Graph tests cover policy
checks, load-before-execute, concurrent invocation isolation, call/deadline limits,
context schema accounting and completion events. Service/API tests cover domain
behavior and wire compatibility. Trace regression tests cover cancellation, parent spans, metadata and export
failures.

### Concurrent writes

DuckDB detects a write-write conflict only between writes of one physical form.
On a keyed table (every `app` table) a plain `UPDATE`, `ON CONFLICT DO UPDATE` or
`INSERT OR REPLACE` changes the row in place, and conflicts only with another
in-place write of the same column; an `UPDATE … RETURNING`, an update of a key
column and a `DELETE` delete the row version (an update re-inserts it), and
conflict with any other such write. Across the two forms nothing is detected,
committed or still running: a compare-and-set whose snapshot predates an
in-place write overwrites it, and an in-place write over a deleted version
reports its row changed and is lost (ARE-150; DuckDB 1.4.2, still in 1.5.6).
So every runtime write ends with `RETURNING`: any two writers of a row then
conflict, the later one gets `duckdb.TransactionException`, which its service
maps to its refusal and the API to 409, and nothing is replayed,
except by `dataio.db.write_idempotent`: a bounded rerun (3 attempts) for a write
that is safe to repeat, such as the scheduler's final stamp, an inbox item's
delivery record and the calendar sync's lease release.
`tests/test_write_conflicts.py` enforces the rule (migrations, which run before
the app serves, are exempt) and pins the engine behavior: its `xfail(strict)`
tests pass once DuckDB fixes the cross-form case. `tests/write_race.py` commits
a competing write inside a path's snapshot window for per-site tests.

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

The browser composes conversation messages; the archive saves their settled snapshots. Document originals, extracted blocks
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
Explicit prescriptions remain excluded from automatic daily adaptation. The daily
run exports the day's sessions through this same circuit, whatever the source of
their steps (explicit, parsed, derived): at most three, one shared request/time
budget, no request for a copy already sent as is, nothing while an export is
unsettled. With that automatic push on, an applied or reverted proposal replaces a
copy in place, withdraws it for a rest or sends back what a rest withdrew: once,
after its commit, within the answer's own small budget; a session that does not
fit is not started. A write window that sent no request (budget, reservation or
permission refusal) ends `failed`; once a request left, `uncertain`. Removal also
serves a skipped session, adopting a copy that predates the export table; no
export row is written for a session the athlete cannot see.
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
`get_activity_detail`; Strava rows never reach the model. Strava's API agreement
(1 June 2026) forbids its data in an AI application, so no Strava number reaches
it either: the load series (`dataio/queries.LOAD_ROWS`, the TSS estimate) leave
Strava rows and the suffer score out, and migration 62 cleared the Strava values
an old merge had copied onto Garmin rows. Strava was then retired as a data
source (October 2026): no connection, sync or OAuth route remains, and
`tests/test_architecture.py` keeps any module from importing one again. The rows
it created stay readable and marked Strava on the athlete's pages; Garmin
importing the same workout takes such a row over with its own values and clears
the Strava-only ones (`garmin/sync.garmin_takeover`). Garmin sync and FIT
upload are the activity sources. Analytics come from
`garmin/time_series.py`: decoupling, pace fade, cadence variability, power and
the work intervals of a structured workout (FIT lap intensity).

The session page opens with its summary, before the tiles and the curves. The
detail payload carries it (`summary`, typed `SessionSummary` beside the service),
so the page makes no request of its own and no model is called: the rules'
sentence when no feedback is stored (`coaching_rules.cardio_rule_feedback`, or
`strength_rule_feedback` for a linked Muscu log), the linked log's tonnage,
working sets and top 1RM estimate against that lift's previous session, the
planned session the session is linked to (`planned_session_id`) with a verdict
on the adherence score's own full-points bands (`garmin/matcher.plan_verdict`:
duration and average heart rate within 10 % of the target are on plan, else the
furthest one says shorter, longer, harder or easier), and the
day after the session while it is today or tomorrow: its planned sessions, the
morning's standing proposals on them (today only), or the next open session
within a week. The browser picks the three numbers by sport and detected
structure (`pages/session/summaryNumbers.ts`) and words « Face au plan : … »,
linking the planned session's day in Planning, and « Demain : … ».

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

`GET /analytics/overview` stays one request (eight statements on one cursor).
It opens on four rule-based answers (`features/answers.py`, no model call):
« Suis-je prêt ? » (today's readiness, the one every surface shows, and the
fraîcheur zone, none without any load), « Est-ce que je progresse ? » (forme
de fond over the window, the pace trend or else a lift's e1RM; a window under
28 days reads the last 30 instead), « Où est le risque ? » (ACWR, monotony and
the forme de fond gained over 7 days, shown by the `risk` card) and « Qu’est-ce
qui marche ? » (the weeks with a session, split on training days, and the
forme de fond each group gained, shown by the `weeks` card: a description,
since that gain follows the load). Each sentence names its period and source.
The records (`features/records.py`) are all time, from the watch streams and
the strength log, never Strava: the fastest 1 km, 5 km, 10 km, half and marathon and the best e1RM per
exercise. Migration 65's `app.best_efforts` keeps each session's bests, one row
per run and distance (a window over the cumulative distance of its streams,
where a step faster than 6.5 m/s counts for nothing) or per log and exercise
(working sets, Epley up to 12 reps), written in the transaction that changes
their source (`dataio/best_efforts.py`): `GarminRepository.save_activity_streams`
(sync, FIT upload, reprocess) and `delete_actual_session`, and the strength
log's save, correction and deletion. **A path that writes or deletes
activities by other means calls `best_efforts.refresh_activity_records(ids)`
once after its commit.** The reads rank the rows (`record_rows`) and join the
live session, so a deleted one drops out; the migration backfilled every
athlete in chunks of 100 runs (0.4 s locally for 500 runs of 3,000 samples).
The year review reads the same rows for its year, against earlier years. The
coach's page reads get the answers and records without session names.

The daily sync hands the sessions Garmin imported to
`coaching.write_sync_feedback`: one feedback request for up to five sessions,
numbered sections split by `services/session_feedback.py`. A missing, failed or
misnumbered answer leaves each session its rule text. The server files the
journal entries and stores the texts; the feedback profile still binds no tool.

`services/garmin_sync.py` owns durable per-athlete import coordination and
freshness (migration 47) for app entry/foreground, manual imports, personal
coaching and scheduled catch-up. A refresh has 180 seconds, 20 new activities,
six pages and 50 paced provider requests. Successful checks are separate from
imported-session dates; capped scans retain validated continuation. Expired
ownership requires explicit reconciliation before another writer starts.
Personal coaching waits before graph execution, reserves two minutes for its
answer and contributes dated freshness limitations through the central context
builder without another model request. Chat's explicit sync tool uses the same
coordinator and returns exact imported IDs. Neither path writes daily feedback.
See [Garmin freshness and recovery](garmin-freshness.md) for the API, bounds and
operator recovery procedure.

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
token from Clerk for Calendar.

### Consent to health data processing

`services/consent.py` owns consent to the terms, the privacy policy and the
processing of health data (GDPR art. 9). It belongs to the athlete, whose data
and jobs it governs, and records the login that gave it, in the append-only
`app.athlete_consents` (migration 63): each acceptance adds a row with both
text versions, a withdrawal stamps the rows in force. It is current when a row
in force carries `TERMS_VERSION` and `PRIVACY_VERSION`; bumping either asks
everyone again. Required only with sign-in on; nobody is grandfathered.

Three places enforce it, never the routes one by one, all with one predicate
(`_IN_FORCE`: any row in force for the current texts counts, so a rollback to
older texts finds their consent again). The authentication middleware answers
403 with a French detail and the `X-Arete-Consent: required` header to every
route but `/auth/*` (the account deletion included) and `/export/*` (the right
of access survives a withdrawal) until the athlete has current consent.
Consent is never cached (GDPR art. 7(3)): it is read with the account when the
account is read, on its own when the account comes from the cache, so a
withdrawal recorded anywhere refuses the next request everywhere. The
browser's `authFetch` turns that header into a fresh `/auth/me`, so the
consent screen returns mid-session. The scheduler's candidate query (daily
sync, briefing, Sunday review, check-in, evening replanning and message) skips
an athlete without it, untouched, and consent is read again when each
athlete's work starts (the claim's own statement) and before each model
request. The automation dispatch records what comes due meanwhile as missed,
with the reason, and moves the schedule past now (a read only when nothing is
due); a session automation only answers activities registered after the
consent in force; and consent is read again before each run, so nothing fires
late after a new consent. The paths that bypass the middleware check it
themselves: the Slack resolution (no coach run; the French reply, once per
event, goes to a DM when asked in a channel) and the administrator's Slack
reads. The API key neither gives nor withdraws
consent; a withdrawal records the login that made it. The browser shows the
texts (`frontend/src/legal/*.md`, their versions in their header, which a
consent sends: a page older than the server is refused), two unticked boxes
and the export in place of the app until consent (`ConsentScreen`), drops its
query caches as a sign-out does while consent is missing, and Settings → À
propos shows the state and withdraws it. Processing (jobs, automations, Slack)
needs consent with sign-in on and also on any MotherDuck database without it:
a Docker stack without sign-in shares production's database and must honour a
withdrawal made there. Only a local file without accounts asks nothing.

The browser keeps an allowlist of query answers (dashboard, settings, goals and
the session windows containing today) in IndexedDB for 24 hours so a repeat visit
paints them while they revalidate (`frontend/src/lib/queryPersistence.ts`). Each
athlete has its own entry, restored only after the auth gate names the athlete;
a new build discards it, and signing out or a signed-out page deletes every entry
with the service worker's API cache (`lib/auth.ts`).

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

`GET /dashboard` (`api/dashboard.py`, `services/dashboard.py`) serves the home
page in one request: each slice keeps its owner and the shape of its former
endpoint, which all remain, read on one connection for the athlete's day, with
the load history read and modelled once for player stats, fitness and readiness.
It makes no Garmin request, model call or write; its briefing may be `pending`.
The page reads it as one query whose panels select their slice
(`frontend/src/lib/dashboard.ts`); the current read (never a cancelled one, nor
one older than a key's own answer) seeds the keys still read elsewhere, so the
coach card and the briefing's polling start from it rather than asking again.
A session write invalidates it with the rest (`invalidateAfterSession`), and a
change to data it carries without one (Garmin state, health, goals) with
`invalidateWithDashboard`. When it fails, the panels say so and offer a retry.
The form curve is its one lazy read: `GET /dashboard/form-curve` returns twelve
weeks of forme de fond, fatigue and forme (CTL/ATL/TSB) up to today from the
logged load only, so today's point is the dashboard's form, and, with a race
ahead, `plan_builder.project` after it (today's plan, if not done, counts from
tomorrow), the race-morning form, the last planned day (rest is assumed after
it, so the card shows its race-day band only when the plan reaches race week)
and the week's key session, all on one connection. It starts after the
dashboard answered, once the goal card or the curve is on screen. The curve
itself does not read it before any load was ever logged (the aggregate's
`has_load`; rounded CTL/ATL can read 0 after months off), while the goal card
still does, for its race. The goal card and the curve, with recharts, load in
their own chunk.

The morning check-in (`services/checkins.py`, migration 49) stores one row
per athlete and day: sleep and legs 1-5, an optional "motivation / stress"
1-5 and a short note (280 characters), 1 always the worst. `PUT
/checkins/{date}` replaces the day's answer (today or the 13 days before);
`GET /checkins?days=14` reads at most 14 days; `GET /dashboard` carries
today's (`checkin`, null until answered), so the card adds no request. It
weighs one band in the day's decision, downwards only
(`adaptation.declared_fatigue`): legs or sleep at 2 or less move the
readiness to the band below (80 / 60 / 40: keep, ease, recovery, rest), once
whatever the number of low answers; good answers never raise a band, no
answer changes nothing, and without a readiness there is still no decision.
The proposal's reason says it ("jambes lourdes déclarées", "nuit difficile
déclarée"). An answer before the day's scheduled run waits for it, which
reads it with the night's Garmin data; a low one after it runs the existing
preparation (`coach_today.prepare`) again, which decides the sessions the run
kept, as a proposal to validate: answering never changes the plan. One given
while the run goes on (after its decision, before it is stamped finished,
common on Docker where the push and the run share a tick) is read by the run
itself once stamped (`scheduler.settle_checkin`). `replanned` says whether a
new proposal came of it; a failed replan leaves the saved answer and the
day's decision as they were. A low answer corrected to a good one leaves its
proposal for the athlete to decline. The
briefing's facts list today's and yesterday's answers once given (a day
without one keeps its facts and digest); a briefing already written is not
rewritten for it outside the daily run's usual digest check, and the next
day's briefing reads it. No model reads the note on its own. One push a day
asks for it (kind `checkin`): `GET /cron/checkin` at 05:00 and 06:00 UTC,
before the sync's first window, claims the day in the same row before
sending, so a second window or the Docker tick never repeats it, and skips
an answered day or a parked athlete. A window outside 06:00-12:00 on the
athlete's clock, in their quiet hours, without Web Push keys or without a
subscribed device claims nothing, so the next one sends it: 07:00 in Paris in
both summer and winter with the default quiet hours. On a rest day the push
does not mention a session. The data export includes the answers. It opens `/?checkin=1`,
which shows the card even when put off for the day ("Plus tard" is
remembered on the device) and focuses it.

The week's review (ARE-60) is written on Sunday evening for the week ending
that day (`weekly_review.review_week`); any later daily run until the next
Sunday writes it if it was missed (`scheduler.write_weekly_review`). No cron
of its own: the daily sync's last window, 16:00 UTC, runs a pass after the
day's runs (`scheduler.run_sunday_reviews`) for the athletes whose Sunday
evening it is (`weekly_review.review_evening`): from 17:00 on their clock and
not before 16:00 UTC, outside quiet hours. Hobby fires that window within its
hour, so on Vercel, with the default quiet hours (21:30-07:00), it reaches
UTC+1 to UTC+4, and UTC+5 when it fires before 16:30: Paris at 18:00 in
summer and 17:00 in winter, but not London or Lisbon in winter, the Americas,
Dakar, Kolkata or Bangkok, who get it from their next daily run. Docker's
five-minute ticks reach every zone from UTC-12 to UTC+5. The pass first
refreshes Garmin (the morning's run missed the afternoon's sessions), then
writes the review in one model request at most, as before. Exactly once per
week: the row is claimed first (`pending`, never served nor exported; the
unique week key makes concurrent claims exclusive), a week written, claimed
or failed that day costs one read and no Garmin request, and only the run
that wrote it pushes « Ta semaine est prête » (kind `weekly_review`, quiet
hours respected, dropped like every push). A failed scheduled run keeps its
claim until the next day, so the next daily run retries it, never the same
evening; a claim older than ten minutes belongs to a stopped run. The
athlete's « Faire le bilan » writes the week on screen
(`weekly_review.requested_week`): on Sunday before the evening, last week's,
so the evening still reviews the ending week after its afternoon.
« Refaire le bilan » names the review it shows (`review_id`) and rewrites that
week, whatever the hour. The written review is never hidden: the new one is
composed first, then written over the same row (same id) only if it is
unchanged since the read (`created_at` as its version, which every rewrite
moves forward, and its answer), else 409; new proposals start unanswered and
the week is not announced again. A request stopped mid-way leaves the review
as it was. Two concurrent rewrites may both pay a model request; the second
gets 409. Every answer, « Accepter » and Planning's « Appliquer »
(`POST /plan/review/{id}/apply`) alike, must send the version its page read
(`created_at`; without it 422, so an older bundle fails safe) and is refused
(409) once the review was rewritten, since its indices name other proposals;
both reserve their proposals by compare-and-set on that version and the
answer fields, so a rewrite landing between the read and the reservation
applies nothing. A stopped claim that still holds a review's text is shown again as
written, never rewritten nor announced. A week with nothing planned or done is never announced, and
the later days' fallback does not write it (a new athlete's first push is
not « 0 séances sur 0 »). Proposal generation is unchanged.

« Ma semaine » (`/planning/semaine`) reads `GET /plan/review/week`: the
current review (on Sunday this week's once written, last week's until then)
and its week in numbers, read now, so a session imported since counts. The
push, Planning's title row and review panel, and a compact dashboard entry
lead there; the entry is the `weekly_review` field of `GET /dashboard` (no
request of its own): the review until the athlete accepts it, on its evening
and the next day whatever it proposes, then while a proposal is still open.
Past proposals are shown, not offered, and a review with no week left to
plan offers no « Accepter ». « Accepter » (`POST /plan/review/{id}/accept`)
reads the review once, refuses (422) an index the review never had, reports
one whose day went by since the page was read as stale, reserves the ticked proposals by compare-and-set on what it read (a concurrent answer, from another tab or a retry, gets 409 and
applies and sends nothing; an answer adding nothing to an answered review
sends nothing, `unchanged`), applies them (a changed session comes back
stale; reserved proposals not written are given back from the stored value,
retried once on a write conflict, so a concurrent answer's stay, and an
answer that wrote nothing leaves the review unanswered), then sends the coming week's key sessions to Garmin (the changed
ones, then intervals, tempo and long runs; at most four, 60 s, one attempt
each, under the automatic-push setting like the daily push) and syncs the
plan's calendar inline (`AFTER_PLAN_WRITE` budget). Each outcome is the
server's; a failed watch or calendar, or a review rewritten meanwhile, never
fails the written plan. Nothing is applied without the click. « Ajuster avec
le coach » attaches the review to the active browser thread as its
`coach_ref` (`review:<id>`), which the context builder resolves by id: the
browser sends the identifier only and the composer stays as it was.

« Modifier » on today's session (ARE-61, `services/renegotiation.py`)
renegotiates it in two taps, with no model request: the menu opens on
`GET /plan/today/sessions/{id}/options` (no dashboard request is added), which
lists each fixed reason with the options the rules compute, and a choice
(`POST …/renegotiate`) writes it. The coaching defaults, for the owner to
validate: « Je suis cuit » makes a tempo, intervals or long run endurance Z2,
an endurance run recovery Z1 and a recovery run shorter, each at 70 % of its
duration (rounded half up to 5 min, at least 20; 30 min without a duration),
and always offers rest too; « Pas le temps » keeps the session at 70 % of its
duration, except a tempo or intervals described in words, whose steps no rule
shortens, which becomes endurance Z2. Both offer to move it to the first day of
the next three with nothing planned, within the same ISO week (« Ma semaine »
counts stay honest), before the next race (a goal or a planned race), and, for
a hard session (tempo, intervals, long run, race or marked hard), with no hard
session or race the day before or after and never in the two days before a
race; a session already moved once is not offered another move, and without a
day rest is offered instead. « Douleur / gêne » offers rest or 20 min of
recovery Z1, never a move nor anything harder. A session with explicit steps
can only move or rest here, a race is never renegotiated, and « Autre… »
attaches the session to the active browser thread as its `coach_ref`
(`session:<id>`), which the context builder resolves with the rules' options;
the composer stays as it was.

A choice is the day's plan decision for that session (`move` joins the decision
kinds; a move keeps the session pending, so its new day's readiness still
weighs it), written with the session in one transaction and marked as the
athlete's (`readiness_source` `athlete`): the RPG never counts such a rest as a
prescribed one toward the week's goal. An open proposal must be answered first
and an applied decision reverted first; a declined or reverted one, or a
proposal snoozed past the day, is replaced in place, keeping one row per session
and day without a migration, and the morning's suggestion it replaced stays
in its `original.replaced` for the briefing and the coach (an earlier choice of
the athlete passes on the suggestion it had replaced; `readiness_source`
doubles as the origin until a dedicated column earns a migration). The menu's `version` covers
the session's revision, its decision and every option (a day planned since
changes a move): any change answers 409 and writes nothing. Inside the
transaction, a move's day is read again, and the session's revision guard
refuses a session changed since the menu; a write racing it on the same row
fails with DuckDB's write-write conflict, also a 409. The session is written
before the decision (with the decision first, a revision bump committed in
between was seen to pass). An athlete's choice stores the revision it wrote,
and « Rétablir » refuses (409) once the session changed since, so a later edit
is never undone; a move is reverted only on its own day and gives back its day
alone, a rest its status alone (a copy never withdrawn is left as it is).
Garmin follows after the commit and after a revert as for a proposal
(`follow_on_garmin`, now returning each outcome): with the automatic push on, a
copy Garmin holds is replaced in place (a move reschedules it) or withdrawn for
a rest, once, never replayed. Each answer reports it apart (`sent`,
`withdrawn`, `failed`, `not_started`, `unchanged` when Garmin holds no copy,
`disabled` for a copy the push, off, left as it was, `disconnected`), and a
Garmin failure never fails the written choice. The plan's calendar follows the
plan-change flag, as for a proposal.

A missed session is replanned the same evening (ARE-61 Part 2,
`services/missed_sessions.py`), with no model request and nothing applied
without the athlete. In their evening, outside quiet hours, a day whose planned
sessions are still pending or modified with no training dated that day gets one
proposal, after a Garmin refresh that only runs when such a session exists.
Training is a strength log or an activity of 20 minutes or more that is not a
walk or a hike (an unmatched one still counts: no false proposal; a short or
incidental one does not). On Vercel the `/api/cron/evening` window at 18:00
UTC dispatches it from 18:00 on the athlete's clock: Hobby fires it within the
hour, so it lands in Paris between about 20:00 and 21:00 in summer and 19:00
and 20:00 in winter, in London an hour earlier, in UTC+3 only when it fires
before quiet hours, and not in the Americas. Its order rotates daily, since
athletes the window has no time left for get nothing that day. Docker's ticks,
which run with the daily sync (`ARETE_AUTO_SYNC_HOUR` set), start at 20:00
local, after the after-work runs. Skipped, completed and race sessions are never missed, nor one
adapted or renegotiated today (a declined morning proposal or a reverted choice
leaves it missed, replaced in place and kept in `original.replaced`); a session
moved by « Modifier » is judged on its new day; a day whose morning proposal is
still open, or that already holds the day's replanning (answered or not, even
written over by « Modifier », which keeps it in `original.replaced`), gets
nothing, since the day's proposals are answered as one group and must not mix.
An activity synced after the proposal leaves it stale on the card: applying it
is refused, while « Non merci » still dismisses it.
The rules are `renegotiation.move_day`'s: a hard session moves to the first
free day of the next three, within the ISO week, before the next race and out
of its last two days, with no hard session either side, once (the second of two
missed hard sessions sees the first on its new day); an easy session, or one no
day receives, is dropped (`drop`: skipped, never counted as a prescribed rest).
Merging into another session is not offered: no rule rewrites two sessions'
targets or steps safely. The rows (`readiness_source` `missed`, pending) are
written in one transaction that reads the day first, so overlapping runs write
them once (the unique key refuses the loser) and only the writer pushes
`adapted_session`, through the athlete's preferences and quiet hours. The coach
card answers them with the morning's machinery: « Appliquer » moves the session
(its status kept, so the next day's readiness still weighs it) or skips it, one
revertable decision with its reason; the answer reports Garmin's outcome
(`respond_reporting`, the response's `garmin`) and the session's
compare-and-set now runs before the decision's claim. The proposal expires at
the athlete's midnight like the morning's. The week's review (ARE-60) owns the
sessions still ahead and never offers one on its own day, while the replanning
only proposes today's: they never offer the same session. A session one of
them changed leaves the other's proposal stale: the review's answer compares
the proposal's `before` fields, the replanning's the session revision. The
review's numbers count an applied `drop` as due and missed, so letting a
missed session go never raises the week's adherence.

The coach's evening message (ARE-64, `services/evening_message.py`) is
opt-in: Réglages › Coach turns it on (off by default, migration 52 adds
`coach_evening_enabled` and `coach_evening_hour`, which an older client cannot
reset) and picks the hour it may start from, 18:00 to 21:00 (20:00 by default)
on the athlete's clock, outside quiet hours. The `evening` profile binds no
tool: the server computes tomorrow's sessions, the forecast (one Open-Meteo
request at the athlete's last start place and hour), the morning's load, form,
readiness and check-in, today's training and replanning and a race within
seven days, and the model answers in one request: at most three sentences,
the last being its only question, refused otherwise (only the error's type is
stored, never provider text). An evening with no session tomorrow
and no notable signal (that race, a readiness under the rest band or a low
check-in, today's replanning of a missed session), or whose push could not
leave (notifications or the `evening` kind off, no Web Push keys, no device),
makes no request and writes nothing under the original delivery policy. With
coordinated coaching enabled, the evening's separate opt-in and chosen hour still
apply, but the message can remain available in-app when push cannot leave. An
outstanding RPE question is reused before generation, with no second question or
evening model request. Exactly once: `app.coach_evening_messages`
(one row per athlete and evening) is claimed before the request, so overlapping
windows and ticks pay once and only the writer pushes (kind `evening`,
« Chiron, pour demain » with the question); a failed or stopped run keeps its
row and is never replayed. The run stops by 280 s of its dispatch
(`SCHEDULE_RUN_SECONDS`, fallbacks included), before Vercel stops the function
at 300 s, and settles as failed; a claim the platform killed anyway is settled
as failed by the next pass (stopped claims are judged on the database's
clock). On Vercel (`VERCEL=1`) the daily briefing and the Sunday review share
that bound; Docker, with no function limit, keeps their own envelope. Vercel
dispatches the message from its own cron path, `/api/cron/evening-message`, at
18:00, 19:00 and 20:00 UTC (each fired within its hour, so the message arrives
in the evening, best effort, possibly later than the chosen hour, and never
in quiet hours, as the setting says): Paris gets 20:00 in summer and winter
alike, the Americas nothing. Docker's ticks reach every zone, but only with
the daily sync configured (`ARETE_AUTO_SYNC_HOUR`). Today's missed session is
replanned first, since the replanning may move it onto tomorrow: when
`missed_sessions.candidates` still holds, the message's pass runs the
athlete's replanning itself (`scheduler.replan_missed_evening`, one proposal
and one push a day whoever runs it; from 20:00 on Docker, its usual hour) and
writes the message in the same pass. A replanning that fails or runs out of
time does not hold the message back. An evening found with nothing to say is
surveyed again 20 minutes later at the soonest, so no Vercel window is skipped.
The push and its inbox item open `/follow-up?evening=<id>`: Chiron selects the
message's own thread (a new one the first time) whose `coach_ref` is
`evening:<id>`, shows the message as a reference card and leaves the composer
as it was. While the message is `answerable` (unanswered, until the end of
the day it is about), that thread's first message answers the question with
no model request: `POST /coach/evening/{id}/answer` keeps it once on the row
and files it once in `notes.md` through `memory.append_entry` (its dated
heading is the guard). A failed filing is reported apart (`journaled` false,
said on the card) and retried when the message is read and by the next
briefing's facts, which quote the question and the answer. A closed question
(answered, past, gone) makes the composer chat as usual; so do later messages
in the thread. The export includes written messages and answers. Deleting a
conversation does not remove what the journal kept from it; the delete
dialog says so. Budget: one model request per opted-in athlete and
evening with something to say, none otherwise; see the PR for the estimate.

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

Onboarding confirms athlete-declared answers into `/memories/profile.md` through
the existing transactional ledger and CompositeBackend. The central journal
contribution includes this bounded profile whole; tools can correct or forget it.
Drafts remain local to the athlete's browser, while the confirmed Markdown is
server-side. No facts are duplicated and no model or plan runs on opening Chiron.
See [onboarding](onboarding.md) for the flow, limits and verification contract.

Migration 20 versions athlete facts and distinguishes explicit declarations,
coach hypotheses and legacy evidence. Active, currently valid facts are mandatory
context; missing reads and oversized contexts fail explicitly. Settings and the
coach use optimistic revisions, and deleting a fact removes its history.

Chat adds bounded BM25 retrieval of existing facts, journals and session text
through the central context builder. Document blocks remain accessible through
filesystem tools rather than being injected again as retrieved system context. Reads run in
workers, with a fresh corpus at each model boundary and no extra model request.
Optional traversal follows only authoritative source links and remains disabled
in production. See [personal memory](personal-memory.md) for contracts, bounds
and migration compatibility.

`FactMemoryMiddleware` (`agent/middlewares/fact_memory.py`) binds the durable-fact
tools and adapts runtime provenance and budget hooks. `JournalMiddleware`
(`agent/middlewares/journal.py`) binds only dated `append_journal` operations.
The native `FilesystemMiddleware` receives any `BackendProtocol`; its configuration
helper owns only bounded read/search schemas, with no journal or skill dependencies.
The composition root uses one `CompositeBackend` with one default `StateBackend`
for `/attachments/`, `/large_tool_results/` and
`/conversation_history/`. It mounts the DB-backed `LedgerBackend` at `/memories/`
and immutable `SystemSkillsBackend` at `/skills/system/`, and
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
isolates that version-specific setting. Browser chat uses the native
[context engineering](https://docs.langchain.com/oss/python/deepagents/context-engineering)
mechanisms and defaults: tool-result eviction at 20,000 tokens, human-message
eviction at 50,000 tokens, and `compute_summarization_defaults` for 85%/10%
summarization and old tool-argument eviction. Without a model profile, the native
helper falls back to a 170,000-token trigger and six recent messages; production
models carry the configured deployment window. Filesystem tools keep their
existing bounded schemas and permissions. The agent retrieves offloaded evidence
with native `grep` and paginated `read_file`; internal files are read-only to it.

Filesystem interception wraps error classification and UI event extraction so
those hooks receive complete results. The context builder assembles the request
before summarization; the final envelope guard runs afterward and raises the
standard `ContextOverflowError` if native overflow recovery is needed. The
summarization model uses the same configured route, output/temperature/timeout
settings and zero SDK retries: native summary retries are already bounded to
three attempts. Each of the 24 graph turns can summarize once, adding at most
72 summary requests under the same five-minute invocation deadline. Native
overflow recovery can also retry a model request after compaction; it never
replays a tool or an entire run. The shared stream projection filters native
`lc_source="summarization"` tokens from user-facing answers. Summary calls have native LangSmith LLM spans;
the existing `Agent run:` model-call counter measures main-model attempts only.
Slack retains inline results because its shared graph can disable filesystem
access per invocation; tool-free background missions do not compact history.

`ContextSummarizationMiddleware` only instruments the pinned native middleware:
it captures its complete decision count (system, messages and tool schemas) and
publishes `context_window_usage = {used_tokens, window_tokens}` in graph state
after the model returns. Capture uses a `ContextVar`, so cached graphs cannot
mix overlapping invocations. The three upstream hooks are covered by sync,
async and concurrency tests; thresholds, counting, retention, offloading and
overflow recovery remain native. No provider-usage correction or extra token
count is added for the UI. A model without a known window emits no percentage.

The native summary call emits custom `context_compaction` events with `start`
and `done` phases, including failure/cancellation via `finally`. Streaming adds
`values`; its projection exposes only changed counters, never the rest of state.
The existing browser thread store saves counters locally; compaction activity is
ephemeral, scoped to its originating thread and cleared on every stream closure.
Browser conversations still have no server checkpointer. The composer hides the gauge below 85%
unless `contextGaugeAlways` is present in the URL (even with value `false`).
No counters means no gauge. Compaction with counters is always visible. The
percentage updates after model calls and may retain the pre-compaction count
until the following model call. Only its display is capped at 100%; the tooltip
retains the actual measured count and configured deployment window.

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
table (`tests/test_data_export.py` also rejects token-like columns and checks
that **Réglages → Données** offers exactly the server's list). Bodies are
built in memory and refused above 4 MB, under Vercel's response limit; streams
and saved conversations are therefore exported only on request.
`services/account_deletion.py` erases the signed-in athlete for good
(`POST /auth/me/delete`, [multi-athlete](multi-athlete.md#erasing-an-account)).
`services/year_review.py` derives a calendar year from the shared TSS estimate
and fitness series, and its records from `app.best_efforts`, with no model
request. Both are plain HTTP reads
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

## Conversation archives and titles

Migration 51 adds `app.coach_conversations` and its athlete-scoped view. This is
an explicit change to the former browser-only contract. The browser still owns
the active history, unsent drafts, selected attachments and the 30-message model
window. No chat checkpointer or automatic injection of previous conversations is
added. `services/conversations.py` owns snapshots, search, deletion and titles;
`api/conversations.py` exposes them without importing the agent stack.

`useConversationArchive` imports existing local threads and saves complete settled
snapshots after one second of inactivity, one HTTP write at a time. It does not
write on every token. Closing the tab before the archive acknowledgement retains
the local copy; reopening retries its import. A closed browser does not guarantee
that the current response has reached the server archive. Failed/interrupted
answers remain visible but their text is excluded from search. Unsent drafts and
selected attachments remain local; sent attachment IDs, briefing references,
timestamps, workout cards and feedback receipts travel with their messages.

Each snapshot is bounded to 1,000 messages and 2 MB, with 64,000 characters per
message. Overflow fails explicitly. The local cache allows 100 unsaved/open threads;
from 30 cached threads it evicts only inactive, draft-free threads whose exact
payload digest has been acknowledged. The archive is paginated by 30, with a
100,000 offset bound. Opening a thread fetches its full bounded snapshot. Opening
or searching never calls a model. Search is literal case-insensitive text matching
on titles and complete settled message text, not semantic/vector retrieval.

Writes carry a revision and a deterministic SHA-256 write ID. Repeating an
acknowledgement-lost write returns its existing revision; a different payload with
the same write ID or a stale revision conflicts. Conflicts keep local work. The
explicit recovery action backs up that snapshot in an athlete/thread-scoped local
storage key before reading the server version, retaining the local draft and
selected documents. Deletion clears archive content and leaves a tombstone so
late snapshots/title tasks cannot recreate it, then deletes thread documents.

Only the browser chat profile binds `search_conversations` and `read_conversation`.
The capability catalog owns their permissions and source-handling instructions.
Search returns five dated, explicitly abbreviated excerpts plus conversation links;
read returns at most five complete messages and rejects results above 20,000
characters. Historical messages never authorize new actions; current domain data
must be read before a write. Slack and unattended missions do not gain access.

`ConversationTitleMiddleware.abefore_agent` starts one invocation-local task and
returns immediately. Composition supplies a separate client on the invocation's
resolved route: one request, 512 output tokens, temperature 0, ten seconds, no SDK
retry, no model fallback, existing free/paid provider price policy. Inputs above
4,000 characters retain the provisional title without a request. An atomic DB
claim permits at most one automatic attempt per conversation. This adds at most
one concurrent request and one recorded model call to the first relevant chat run.
The title never consumes or replaces the main answer stream.

The task saves a validated title before emitting the custom `thread_title` event
with `thread_id`. The projection forwards it independently of answer tokens;
the browser patches only the originating thread. A manual rename wins over both
an in-flight title generation and a late snapshot acknowledgement. The execution
runtime cancels and joins unfinished title work when the graph ends, times out or
is cancelled, so it never waits for a title before `done`. An unavailable,
truncated or cancelled title keeps the provisional label and is not retried.

`FollowUp` adds the Conversations tab and reuses `ThreadHistory` inside Chiron.
The editable [Figma proposal](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=271-3203)
extends the Suivi reference with Pierre/Prune desktop/mobile variants.
