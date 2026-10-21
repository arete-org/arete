---
type: architecture
title: System Architecture
description: High-level overview of Arete's system design, component interactions, and data flow
tags: [architecture, arete, system-design]
verified:
  - by: openwiki/0.7.1
    at: 2026-10-21T06:33:32.768Z
sources:
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-9c8823505d1c81e6e435944e
    resource: repo://src/arete/coaching.py
generated: { by: "openwiki/0.7.1", at: "2026-10-09T21:28:29.291Z" }
---

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
on first access and cached once per profile. Only this composition root may
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

The execution envelope is five minutes, 8 main graph model calls, 32 tool calls,
and four simultaneous tool executions per invocation. Interactive chat may add one
optional next-message completion (512 output tokens, five seconds, zero SDK retries). Framework recursion is a
separate 100-step backstop. A model call gives up after 60 s, or 30 s without a
streamed chunk, with two SDK retries; on OpenRouter the request carries a
fallback list of at most three models. Tools and failed runs are never
automatically replayed. Already-started
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
session's numbers, RPE and notes) and the model answers in one request. The
server files the feedback's ledger entry itself (`services/memory.append_entry`,
dated heading, never twice), so neither mission can mutate training data or
forget to write. Every profile receives the current date. Chat writes the
journal through one tool, `append_journal` (server-dated heading, deduplicated,
bounded); its filesystem middleware only reads (`read_file`).

Model-generated loaded state and client page metadata cannot change these policies.

The context builder combines the harness/filesystem contribution, mission
instructions, the current date for chat, the catalog of toolkits still loadable,
loaded instructions, a bounded journal excerpt and, for chat, the open page: its
data read by the server once per run (`context/sections.py`, through
`services/pages.py`) and its URL parameters labelled as untrusted client data. A
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
Cards consume these events before `done`, independently of truncated tool previews.
Optional LangSmith tracing remains invocation-scoped, including stream
cancellation cleanup, dynamic tool spans and browser thread IDs. Provider usage logs
retain reported cache/input/output details and model timing without logging the
athlete's prompts. Opt-in LangSmith traces include full inputs, outputs and tool
results, as described in the README. Missing usage remains unknown, not zero.
Each invocation also logs one `Agent run:` line (`RunStats` on the run context):
model calls, tool calls, model time, time to first token and served models.

These bounds are not a cumulative token/spend quota: SDK retries have their own
limit and share the run deadline. Arete has no delegated
children to budget; a provider-side fallback stays within one model call. Conversation
history stays in browser storage; Calendar's approval registry is described below.

## Document imports and outbound workouts

Conversation messages remain browser-owned. Document originals, extracted blocks,
import drafts and outbound Garmin operation records are deliberately durable in
DuckDB/MotherDuck (migration 13). `services/documents.py` and `services/imports.py`
own these lifecycles. API chat hydration builds an invocation-local StateBackend
view at `/attachments/`; the context builder receives only a bounded manifest.
The readonly filesystem composes that view with the existing ledger backend.
The model can propose a draft but has no confirmation tool; pending imports block
ordinary coach planning writes. Human confirmation commits selected sessions once.

`services/prescriptions.py` owns versioned steps and provenance. Garmin conversion
lives in `garmin/workouts.py`; `services/garmin_export.py` owns both interactive
and daily export, reconciliation and removal with durable reservations and no
ambiguous write replay. Chat can create coach prescriptions without a document;
explicit prescriptions remain excluded from automatic daily adaptation/export.
Legacy sessions use deterministic conversion, and existing Garmin identifiers must
be verified before adoption. Updates require the current revision and mark the
<!-- openwiki: broken internal link [conversational-workouts.md] file "conversational-workouts.md" does not exist. Fix the href or restore the target, then delete this comment. -->
export dirty without transmitting it. See [conversational workouts](conversational-workouts.md)
for UI, limits and verification.
<!-- openwiki: broken internal link [document-imports.md] file "document-imports.md" does not exist. Fix the href or restore the target, then delete this comment. -->
Only `GarminClient` touches the remote service. See [document imports](document-imports.md)
for resource bounds, frontend worker assets, unsupported conversions and acceptance.

## Google Calendar

When explicitly configured, the composition root adds Calendar to the chat's
resolved capabilities/preloads and supplies its service through invocation
context. The declarative background profiles remain tool-less. A resolved
profile is server-owned and cannot be supplied through browser page metadata.

`calendar.py` composes the provider adapter and repository without importing the
agent stack; API endpoints use it without paying coaching cold-start costs.
`services/calendar.py` owns permissions, bounded reads, proposals, and execution.
The provider adapter uses Vercel Connect for credentials and Google Calendar for
operations. Only the HTTP decision endpoint approves writes; the model has reads
and proposal tools. The browser's approval executes the stored arguments directly.

Migration 17 persists connection selections, consent hashes, and a one-shot action
registry, not conversation history. A `calendar_action` SSE event carries only
an action ID. Browser storage keeps that ID; cards reload the authoritative
proposal and outcome from the API. Settings changes invalidate pending actions,
ETags protect existing events, and ambiguous writes are never replayed.
<!-- openwiki: broken internal link [google-calendar.md] file "google-calendar.md" does not exist. Fix the href or restore the target, then delete this comment. -->
See [Google Calendar setup](google-calendar.md) for activation and live testing.
