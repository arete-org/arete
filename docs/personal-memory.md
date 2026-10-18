# Personal memory

Arete keeps active personal facts in every model request and retrieves older
source passages with BM25. Conversations remain in browser storage. This is a
context contribution, not a new agent or a separate permission system.

## Ownership and persistence

`services/athlete_facts.py` owns facts, validity and optimistic concurrency.
Migration 20 adds evidence classification, source references, inclusive
`valid_until`, revision numbers and historical snapshots. Existing facts are
`legacy`, including those originally entered in Settings: the migration does not
invent confirmation or reconstruct lost revisions. Migration 20 also applies the
idempotent game schema so local/preview databases that ran this branch’s former
memory migration 19 receive both features without resetting existing game state.

`evidence` is independent of `source` (the original writer):

- `explicit`: a declaration by the athlete. New Settings entries and text
  corrections are explicit. The coach supplies an exact quotation from the latest human message when
  recording an explicit declaration. The runtime checks that quotation and adds
  hashed thread/message references; this establishes where the text appeared, not
  whether the proposed fact is entailed by it. Browser history remains client-owned.
- `hypothesis`: a coach inference. Repetition does not confirm it. Settings has an
  explicit confirmation action. This is the tool's conservative default.
- `legacy`: existing evidence whose origin cannot be established retrospectively.

All active facts valid on the server's current date reach the context, grouped by
these three classifications. Future and expired facts remain stored and searchable.
The complete request budget rejects an oversized mandatory context rather than
silently dropping the oldest constraints. Reads are capped at 10,000 facts and a
fact at 1,000 revisions, with explicit failures at the bounds.

An update atomically checks the revision, stores the previous snapshot and
increments the current revision. The history includes both versions and their
recording timestamps; it does not infer when an old statement ceased to be true
in the world. Deletion removes the fact and all its snapshots. No failed write is
retried automatically.

## HTTP and tools

`GET /athlete-facts` adds `evidence`, `source_ref`, `valid_until`, `revision` and
`created_at` to the existing fields. `GET /athlete-facts/{id}/history` returns the
current version followed by older snapshots. Missing facts return 404.

PATCH accepts the new fields and `expected_revision`. DELETE accepts
`expected_revision` as a query parameter. Stale revisions return 409; invalid
values return 422. For compatibility, omission of the revision means **revision
1**, not “overwrite any version”. Older clients can update an untouched row but
must reload/update their client to modify a newer version. The current browser
and coach tool send the displayed revision. PATCH with `valid_until: null` clears
an expiry. Dates are inclusive, so an exception valid through October 10 is still
applicable on October 10.

`remember_fact` retains its name, evidence, revision and validity dates. For an
explicit declaration, `source_ref` is now the exact quotation to validate. A temporary exception is a separate fact, not a rewrite of a
standing preference. Unresolved contradictions call for clarification when they
affect a decision. These prompt rules guide advice; only domain validation can
make a constraint an enforced prohibition on writes.

## Jev-assisted writes

`services/fact_memory.py` owns new-fact reconciliation. `remember_fact` still
writes one typed fact per call; updates with a fact ID use the existing revision
contract. First facts, exact duplicates and writes without comparable candidates
need no classifier request. Journals, Settings writes and tool-free missions do
not call Jev.

For a new fact with comparable existing evidence:

1. Load the athlete's bounded fact collection (10,000 maximum). Exclude resolved
   facts, other evidence classifications and non-overlapping validity periods.
   Temporary exceptions remain separate from standing facts.
2. Rank with BM25Plus using the existing tokenizer, with same-kind/recent facts
   breaking ties. Send up to seven **complete** facts, with opaque numeric IDs.
   Source quotations, conversation history and credentials are not classifier data.
3. Ask pinned `typesafe/jev-1.13` for one Choice: create, duplicate of a specific
   candidate, or contradiction with a specific candidate. Python controls which
   duplicate options are eligible by kind, evidence and validity.
4. Reuse a named duplicate only at probability ≥0.9. A contradiction at ≥0.7
   returns `needs_clarification` without writing; the agent must resolve it before
   updating the existing fact by ID/revision. Otherwise create the new fact.
   These thresholds are initial policy choices, not measured calibration.
5. At commit, check the complete fact ID/revision snapshot under the same athlete
   mutation lock used by creation, correction and deletion. A concurrent change
   raises a conflict with no automatic replay. An old decision cannot recreate a
   deleted fact or silently suppress a correction.

Receipts distinguish `created`, `updated`, `already_present` and
`needs_clarification`. Only actual writes set `saved=true` and produce a memory
update card. Duplicate receipts return the real unchanged fact and source.

`FactMemoryMiddleware` registers the fact tools; `JournalMiddleware` registers
only `append_journal`. Native `FilesystemMiddleware` operates over the injected
`CompositeBackend` for journal files, attachments and skills. Its configuration
accepts any `BackendProtocol`, while the composition root owns mounts and permissions.
`fact_memory_tools`, `journal_tools` and `filesystem_tools` select these independently.
The central context builder remains the sole owner of memory injection and token
accounting.

The composition root injects `agent/models/jev.py`; runtime owns provenance,
deadlines, request accounting and the optional `classify_memory` LangSmith span.
The [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
uses `/api/alpha/decisions`, not chat completions. It exposes neither temperature
nor a generative output-token limit. Arete caps the complete request and response
at 16 KiB each, one request per classification, four per run, 10 seconds per request
within the run deadline, and zero retries/fallbacks. Each attempt consumes the
shared 24-call turn budget, reserving the final answer. `Agent run:` includes
`memory_decision_calls`/`memory_decision_ms`, and decision logs retain usage/cost
when returned. This does not add a model call to recall.

`MEMORY_JEV_ENABLED=true` is the deployment default and requires
`OPENROUTER_API_KEY` when classification is needed. Jev is a **paid route separate
from the chat GLM flag**, capped at $0.05/M input and $0/M output. Disabling it
explicitly selects deterministic-only memory; provider errors never silently
select that path. Restart the service after changing deployment configuration.
No async HTTP connection pool is shared across event loops.

The shortlist can miss paraphrases or contradictions outside its seven candidates.
All fact text in that shortlist is sent to TypeSafe via OpenRouter. Probability
thresholds do not prove semantic equivalence; full recall and temporal behavior
remain governed by the typed fact store and context builder.

Normal tests mock HTTP and cover complete payloads, thresholds, malformed replies,
timeouts, cancellation, shared budgets, provenance, concurrency and the
remember/use/correct/expire/forget lifecycle.

## Retrieval

`services/personal_context.py` exposes `search_personal_context(query, thread_id,
current_date, limits)`. It returns sourced hits, their traversal paths, corpus and
match counts, an explicit selection-limit flag and elapsed time. An unavailable
source raises an error, never an empty success.

The corpus contains current/historical facts, journal entries and monthly
archives, actual/planned/strength session text, and ready document blocks from
the current thread. Metrics remain the analytics services' responsibility.
Document provenance quotes are excluded from planning text; only references to
blocks authorized in the current thread can be traversed.

BM25Plus uses `k1=1.5`, `b=0.75`, `delta=0`. Unlike common BM25Okapi configurations,
this retains positive scores when a term occurs in most documents. Unicode
normalization folds accents/case but preserves negation, numbers and units.
Passages include source metadata and dates, without LLM-generated summaries.

Named bounds:

- 10,000 passages, 20 MiB of source/indexed text, 1,000 journal-directory entries.
- 800 characters per passage; complete sources are split, never silently cut off.
- 16,000 query characters and 256 unique query terms.
- Eight lexical seeds, two graph hops, 24 visited passages.
- At most 2,048 estimated tokens for the retrieved contribution, further reduced
  to the remaining complete-request budget. Whole selected passages are omitted
  with counts when they cannot fit; mandatory facts/history are preserved.

Graph traversal follows explicit references: fact → previous revision,
actual → planned session, strength → actual session, prescription → authorized
source block, and journal → typed session reference. Server feedback now records
`actual:N` or `strength:N`. Dates/names alone never establish an edge.
**Graph expansion is disabled in production.** Enablement requires behavior-level
evidence, not just better source recall.

The context builder runs synchronous reads in an AnyIO worker. Each model
boundary rebuilds a disposable corpus, including after memory writes; there is
no process-global index to become stale after correction or deletion. The database
corpus uses one read transaction. Existing filesystem journal synchronization is
unchanged. No automatic reload/replay of an agent run is introduced.

Briefing/feedback remain tool-free and receive their existing facts and recent
journal. Chat retrieval adds zero model calls. `Agent run:` logs include
`memory_searches`, `memory_ms` and the last contribution's `memory_tokens`.
Detailed search logs contain counts/timing, not source text.

## Verification

Source isolation, concurrency, expiry, deletion, schema migration, runtime
integration and failures have separate service/API/browser tests.

Migration is additive and runs through normal initialization; no production data
or deployment is touched by the offline tests. Run `make check` before shipping.
