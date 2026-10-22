# Garmin freshness and recovery

`services/garmin_sync.py` coordinates app entry/foreground, personal coaching,
manual imports and the daily scheduler. Migration 47 adds one durable operation
record per athlete. Ordinary reads, including status, do not contact Garmin.

## Envelope and ownership

Activities are checked after 15 minutes; health after 60 minutes. A refresh has
180 seconds, 20 new activities, six pages of 20 activities, and 50 provider
requests. A continuation page also reads its preceding anchor. Requests are
paced three seconds apart, have at most a 15-second timeout bounded by the
remaining deadline, and have no automatic retries. Token refresh consumes the
same request budget. HTTP 429 stops the operation and persists a 15-minute
cooldown; it never sleeps for five minutes.

DuckDB transactions acquire ownership with a conditional update. Other callers
observe the active operation and share its outcome. Explicit history callers
that join another operation receive its committed IDs with an incomplete
result, so another range is never presented as their requested coverage.
Only sync-state metadata updates may retry a known DuckDB transaction abort,
at most three attempts; ambiguous database errors and import writes are not
replayed. Cancellation keeps the
owner until the synchronous worker or import iterator has unwound. Committed
sessions are returned by exact local IDs, including old sessions and Garmin
takeovers of legacy Strava rows (Strava was retired as a source in October 2026;
the takeover writes Garmin's values over the row). FIT parsing, streams, plan matching and strength
linking retain the existing import implementation. Within one refresh, the
presence answers read while selecting a page's batch are reused by the import
(only Garmin imports write Garmin IDs, under the lease), the legacy Strava
lookup is skipped when no Strava row remains, and gamification settings are
read once.

A lease that expires while still owned becomes `needs_reconciliation`. It is
never automatically stolen: a deadline cannot prove that a thread has stopped
writing. On-use refresh will return the recorded limitations until recovery.

## Freshness and coverage

The latest imported session is not the sync watermark. `activities_checked_at`
advances only when the bounded scan reaches its coverage boundary, including an
empty successful scan. Initial coverage is 30 days; subsequent checks revisit
seven days for delayed uploads. A capped scan retains its lower date, offset
and preceding Garmin ID, and reports `more_pending` in the ensure result and in
the stream's `done` event: the batch succeeded and the next refresh (app entry,
foreground, scheduler) continues it. Onboarding then reads « N activités
importées, la suite arrive automatiquement » and the app banner « Import Garmin
en cours de rattrapage »; any error keeps the incomplete/interrupted wording.
Onboarding does not chain batches itself. A changed anchor resets continuation without moving
the lower date. An import error keeps the failed page reachable; already
committed Garmin IDs deduplicate on the next check.

Undated manual imports use the same continuation and at most 20 new activities;
smaller requested limits and `download_fit` are honored. Their stream reports
the refresh's own progress: a fetching event per page, the importer's per-activity
events, then finalizing for health and enrichment. As with explicit imports,
closing the stream stops the refresh before its next step and keeps committed
sessions; it does not read the imported sessions back. Explicit date-range
and history requests keep their existing interface and the same durable owner
and request deadline. They do not claim current-window freshness. Older history
still uses the explicit history importer.

Health refresh reads today in the athlete's timezone, plus yesterday until one
read of it succeeded (its outcome is kept in `health_days`). The undated
activity import (onboarding, manual) reads no health: the next on-use refresh
does. The Garmin profile handle that health URLs need is cached with the
account record, so a sync makes no profile lookup once it is known; a new
login replaces it. The daily catch-up retains its four-day window and current
performance metrics. Each day
reports available, unavailable or failed measurements. A 4xx answer to one
signal (other than 401, 403 and 429) means Garmin has no such measurement:
that signal is unavailable and the other signals and `health_checked_at` still
advance. Failed requests (timeouts, 5xx) preserve previously stored values and
do not advance `health_checked_at`. Missing values
are not converted into zeros. Terrain/weather work shares the refresh deadline;
unfinished enrichment is reported separately from committed imports.

The status payload includes state, checks, coverage, stage, exact IDs, counts,
errors, health-day outcomes, provider calls and duration. Import summaries can
exist without FIT details: the import reports this limitation and the session
detail remains without those measurements. Successful coverage checks do not
assert that every historical session has streams or weather.

## Application and coaching

`POST /garmin/sync/ensure` waits for the bounded operation. The existing status
response adds `freshness`; existing fields and manual/history routes remain.
The authenticated browser calls ensure on entry and foreground, displays French
waiting/error status, and invalidates session, health, settings and status
queries afterward. Server ownership and freshness checks deduplicate tabs.

The runtime performs the same preflight before browser chat and personal Slack
coaching. Product/admin Slack and tool-free background missions do not run it.
It consumes no model request and stores no state in cached graphs. The existing
five-minute deadline reserves two minutes for the answer. The central context
builder receives last successful checks and limitations; stale page context is
discarded before the model reads it. Chat SSE exposes waiting/terminal sync
status so browser data is invalidated there too.

The daily scheduler still owns feedback, notifications and plan exports.
It also catches up to 20 Garmin sessions imported in the last 30 days that still
lack feedback, ordered by import time, and reports the total pending count.
This includes old activities newly imported on app use. The existing maximum of
five model-written feedbacks in one request remains; additional sessions use rules.
On-use refresh does not run that workflow. Summary logs contain operation state,
counts, duration, coverage and failure category, rather than athlete payloads.

## Recovering an abandoned worker

1. Stop the worker processes that could still own the operation. Do not infer
   this merely from the lease timestamp or a disconnected browser.
2. Read the athlete's sync status and record its `operation_id`. Wait until its
   state is `needs_reconciliation`.
3. As an administrator, call
   `POST /admin/athletes/{athlete_id}/garmin/reconcile` with
   `{"operation_id":"the-recorded-id","workers_stopped":true}`.
4. Resume refresh. Reconciliation preserves committed IDs and the coverage
   lower bound, clears the owner and restarts pagination with deduplication.

The endpoint rejects a mismatched operation, a lease that has not expired, or
missing confirmation that workers stopped. Reconciliation is an explicit
operator action, not an automatic retry of an ambiguous write.

## Verification

`tests/test_garmin_freshness.py` exercises empty checks, capped backlogs, delayed
uploads, failed older rows, anchor shifts, expiry/recovery, overlapping callers,
token-refresh/HTTP budgets, 429, partial health, committed cancellation state and
coaching preflight. `tests/test_garmin_sync_cost.py` runs the real importer
against a mocked Garmin session and bounds a first onboarding import's Garmin
requests and database statements per activity. Existing importer tests cover missing FIT, streams, matching,
strength and the takeover of legacy Strava rows. Frontend unit tests and
`frontend/browser-tests/garmin-connection.spec.ts` cover waiting, partial status,
foreground refresh, invalidation and the existing MFA/history flows.
