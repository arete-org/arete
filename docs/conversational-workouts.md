# Conversational workouts and Garmin Connect

Chat accepts requests such as “Prépare un fractionné mardi, avec 15 minutes
faciles, 6 × 400 m et 90 secondes de récupération, puis envoie-le sur Garmin”.
The planning toolkit persists a versioned coach prescription. The preloaded Garmin
toolkit inspects, exports and reconciles it without OCR or an import draft. Missing
required parameters are requested; an explicit export request supplies intent.
Attached documents use the same direct creation tool, with typed source references checked against the current thread. No import preview or extra confirmation is required.

The planning toolkit owns translation from shorthand to typed steps: `20x300 r100`
means 20 repeats of a 300 m effort and a 100 m recovery. Repeat counts and children
belong to the group; duration/distance and targets belong to each child. Cardio
prescriptions preserve existing warmup/cooldown blocks, adding missing ones by
default unless the athlete requests otherwise. Unspecified edges end on manual lap,
without invented durations or targets. A validation failure calls for correcting
the full prescription; a description-only edit does not fulfill a step change.
These are coach instructions, not server-side insertion into explicit prescriptions.

Typed steps reach the model through one tool,
`set_session_prescription(session_id, revision, prescription)`. Creation, single
updates and grouped previews carry no prescription, so the step schema (inlined to
the allowed repeat depth) is bound once per model call instead of three times.
Running, cycling, swimming, strength and other sports all take steps this way, which
is why a running-only notation could not replace it. A described tempo or interval
created without steps is saved with a `steps_required` notice and stays
unexportable until its steps are set: a structured creation costs one more model
request than before.

## Execution and UI

- A local acknowledgement requires no model request. Created sessions and export
  transitions arrive as `workout_update` events before the final answer. Each carries
  a thread, tool-call identifier, sequence, session revision and durable export state.
- The same card displays dates, literal step summaries, expandable prescriptions,
  local persistence and Garmin status in chat and inside existing Planning rows.
  Distance steps never receive a guessed duration.
- Selection, editing and sending use HTTP directly. Connect is the default; device
  discovery starts only when watch transfer is selected. A transfer request never
  claims successful receipt on the watch.
- Direct actions in chat append a factual message to the originating thread.
  Revision checks protect edits and selection; durable reservations protect writes
  from overlapping chat, Planning and daily jobs. Legacy IDs are verified and reused.
- A message's cards are read together (`GET /garmin/workouts?ids=…`, at most 50
  per request) and refresh after mutations, reconnection and, once a minute old,
  remount. Revision and durable update time reject stale state. Browser conversation storage accepts old messages
  and restores workout references; the server remains authoritative.
- Navigation/hiding the panel preserves the run in the app provider. Closing or
  reloading the tab does not promise background completion. Stop closes the response,
  not a committed remote write. Runs containing workouts have no automatic replay.
- Errors keep successful results visible. An uncertain operation requires Garmin
  reconciliation; no batch or write retry runs automatically.

The service batch is sequential: at most five sessions, 120 seconds total, 60 remote
requests, at most 12 requests per session, clamped to the invocation deadline.
Planning selects at most 50 sessions and sends batches of five, stopping on the
first failure. Cards poll only active writes, in one request for all of them,
every second for at most 150 seconds.
Chat retains eight main model requests, 32 tools and five minutes. One optional,
tool-free completion can propose the next message in the composer (five seconds,
512 output tokens, zero SDK retries); no auxiliary model request animates workout cards.

## Verification and measurement

`make check` covers backend, frontend unit tests, lint, types and build.
`cd frontend && npm run test:browser` includes a real chunked SSE fixture with
1, 10 and 30 second response delays, cards before `done`, hiding/reopening chat,
restoration, focus, mobile direct edits/exports, reduced motion and uncertain
export recovery without replay. The remote Garmin service is simulated; these
checks do not establish real account/device compatibility or model success rates.

Browser Performance measures include `coach:time-to-useful-result`,
`coach:time-to-scheduled`, `coach:total`, `coach:last-stream-gap`,
`workout:event-to-card` and `workout:action-total`. Marks and measures replace their
previous value rather than growing with conversation length. The card measure is
an effect-time approximation, not a browser paint or INP measurement. Browser test
attachments report simulated delay, time until the card is visible and recorded
measures. No measured production latency improvement is claimed.

A local mock-model context-budget run measured 5,565 approximate tokens before
history/page data: 1,312 system tokens and 4,249 schema tokens for 25 tools. Use
`scripts/agent_context_budget.py` with a disposable database to repeat it. Four
model calls for inspect → create → export → answer is a target, not a hard promise;
actual calls remain observable in the `Agent run:` log.

Before releasing, perform a separate live acceptance with Arthur's chosen future
session: inspect its content, request Connect export, verify content/date in Connect,
edit locally and verify dirty status, explicitly resend and verify the same remote
workout is reused. Request watch transfer only with an explicitly selected compatible
device and verify receipt on that device. Use a disposable session for cleanup.
No real Garmin writes are performed by the automated suite.

The planned comparison with the previous interface and Arthur's qualitative rating
of 1/10/30-second waits still requires a user session. Automated visibility timings
are not a usability study and do not validate the 100/200 ms design targets or INP.

## Strength planning

`create_planned_session(sport="strength", strength_text=...)` builds versioned
steps through the existing grammar, including specified rests and optional weights.
A title alone is rejected before persistence. The coach may compose a requested
future workout; logging performed sets uses one `save_workout` call, rejecting any incomplete parse without saving a partial session.
`set_session_prescription` may then group those sets into repeats or specify exact
Garmin exercise names; its sets must equal the ones already read from `strength_text`. Only explicit catalog equivalents are mapped; unknown
exercises fail conversion without a remote write. `export_garmin_sessions` uses the
same durable reservation, scheduling, verification and optional device-transfer
workflow as other sports. No automatic retry of an ambiguous write is added.

A strength exercise step ends on reps or, for timed work (a plank, a station
worked for a minute), on seconds; never on a distance. A step with no exercise
ends on the lap button and must name its station in its notes: Garmin has no
SkiErg nor burpee broad jump, and a distance (25 m of sled push in a timed
test) stays in the notes rather than becoming a guessed duration. Hyrox and
hybrid plans (`services/hybrid_strength.py`) write their strength sessions and
station circuits this way, with loads from the strength history and the
official HYROX station loads of the goal's division and category. An effort
lap step whose notes name an exercise Garmin has (« Squat 5x5 », « Wall
Ball ») is refused: that exercise is chosen with its reps or duration
instead. Notes starting with a distance, and warm-up or cool-down notes,
are not checked.

Sandbag lunges (« Fentes avec sac de sable ») became their own catalog
exercise without a data migration: sandbag lunges logged earlier stay under
lunges, with their records and trend; new ones count separately.

Known limit: the coach edits a strength session's steps through
`strength_text`, whose grammar check (`strength_sets`) reads reps only. A
generated circuit or upper-body session (timed planks and stations, lap
steps) cannot have its steps rewritten from chat; moving its date or status
still works, and Planning's step editor edits it directly.
