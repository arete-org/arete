# Unified Arete experience

The retained Planning A, week-options dropdown and shared navigation are the
reference. The redesign extends the same identity to every existing analytics
family and adds coordinated Chiron attention and grouped planning proposals.
The application uses its existing APIs and calculations; Figma values and browser
fixtures are synthetic examples, never athlete records.

## Editable design and route coverage

[Design page](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=334-81),
[desktop prototype index](https://www.figma.com/proto/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=387-16088&starting-point-node-id=387-16088),
[mobile prototype index](https://www.figma.com/proto/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=387-16231&starting-point-node-id=387-16231).

The Figma audit covers 105 screens/states, 142 overlays, 168 plot components,
2,651 native reactions and 58 variant transitions. It found no image fills,
broken targets, inaccessible screens or cross-page prototype links. Those are
prototype inventory counts, not claims of 105 separate application pages.

| Product surface | Figma desktop / mobile nodes | Application and verification |
| --- | --- | --- |
| Dashboard | `336:109` / `340:542` | `HUD`, shared attention projection, existing fitness/form curves; dashboard, form-curve, briefing and check-in browser suites |
| Planning A | `336:216` / `340:620` | `QuestLog`, seven columns or day selector by available width; real HTTP CRUD and grouped changes in `planning-crud.spec.ts` |
| Week options | `353:2328` / `353:5813` | `WeekOptions`: sport, today, selection, refresh, focus return and outside dismissal |
| Analytics | `336:346` / `369:865` | `Analytics`; all 15 cards and 13 chart canvases, six periods, URL/reload state, absent samples in `analytics.spec.ts` |
| Annual review | `342:1129` / `373:10340` | `YearReview`; four monthly metrics, yearly CTL, sport/strength/record summaries, source activity links and empty year in `analysis-details.spec.ts` |
| Running detail | `373:13509` / `373:13840` | `SessionDetail`; three synchronized streams, laps, kilometers, intervals, zones and GPS |
| Cycling detail | `376:11677` / `376:12008` | Same owner and source data, speed/cadence/power units; no duplicate sport page |
| Strength | `338:340` / `375:11525` | `Log`, 20 muscle regions, weekly tonnage, exercise e1RM/records/suggestion; touch and native keyboard selector |
| Chiron | `376:17529` / `376:17709` | Existing mounted conversation owner, floating/docked/expanded modes; draft, file, live SSE and thread preservation |
| Prune appearance | `378:15685` / `378:16333` | Shared semantic colors; the four retained palettes are exercised in browser tests |

Analytics sections cover volume and CTL/ATL/TSB; heart-rate zones and sport mix;
cardiac decoupling, pace and records; elevation, cadence, VAM and descending;
readiness, HRV, sleep and resting heart rate. Native Figma section catalogs are
`396:16719`, `396:16809`, `396:16903`, `396:17011` and `396:17153` respectively.
Chiron's chart, context-gauge, archive and compaction states reuse their existing
components and protocols. Profile XP and sync states retain their current domain
owners and the shared typography, panels and navigation.

## Presentation contracts

`design.md` owns typography and semantic tokens. Interface text uses Inter;
brand/page headings use Cormorant Garamond. Charts use `chartTheme` and
`analytics/chartParts`; missing measurements create gaps, and sleep seconds are
converted to hours on the axis. Fact curves render immediately, without a partial
animation that could resemble missing data.

The 36–44 px title and 16/24 px card padding are shared. Analytics uses a container
query so a docked Chiron panel cannot force two narrow chart columns. Session
streams share their cursor. Lap detail is a keyboard-accessible dialog. Muscle
regions remain selectable by touch and a native select. At tablet widths Planning
reduces top spacing to keep the selected session above the fold.

The analytics period, annual year/metric and exercise selection live in the URL.
The server validates the selected period/year when contributing page context to
Chiron; chart point arrays and raw annual records stay outside that contribution.

Expanded Chiron changes the existing shell, not the conversation instance. A
reference card and messages can use two columns on desktop. Direct proposal and
follow-up references reuse `ProposalCard`/`FollowupCard`; a decision's remote
receipt remains visible after the source list refreshes. No model call is made
merely to open a reference, change a display mode or select a method.

The coordinated home now puts its first priority immediately after the greeting,
before goals, today's session and metrics. Its title, reason and action come from
the existing deterministic attention projection. An empty projection adds no task.
Goals live at `/planning/objectifs`; old Settings goal links redirect there.
Planning shows the cached connection status and last successful check, including
partial failures. Routine presets expose their schedule and approval contract
before the athlete activates them. The development-only `/design-system` route
previews the real components in all four palettes; see the
[component inventory](component-inventory.md).

## Coordinated coaching and rollout

Migration **53** adds athlete-owned `coach_attention_claims`,
`coach_attention_days` and `plan_change_sets`. Initial DDL, upgrade migration,
scoped views, export and deletion all include these tables. The previous release
can run against the additive schema; do not roll the migration backward.

`services/coaching_attention.py` derives source references from owned proposals,
follow-ups, native automation interrupts, evening messages and weekly reviews.
It validates revisions, deadlines, snoozes and recorded RPE, and reuses the
missed-session owner's late-sync rule. Approval takes priority, followed by
availability, other questions and recaps. Reading or archiving an inbox item
never answers a question or approves training changes.

- The admin-only `coaching_attention` flag is independent of `glm_flash` and off
  by default. The athlete must also enable `coordinated_coaching` in Coach settings.
- With either switch off, `GET /coach/attention` returns an observation projection;
  existing source cards/delivery policy remain active. The projection is a read,
  not another durable queue. Existing inbox receipts retain suppression outcomes.
- With both switches on, dashboard and Suivi share the top three references and
  an explicit remaining count. The scan rejects more than 100 candidates instead
  of silently dropping work. A pass has a five-second local deadline.
- Push attempts share a transactional daily cap: default two, configurable zero
  through three, by the athlete's local date. Quiet hours, category opt-outs,
  subscriptions and existing ten-device/ten-second transport bounds still apply.
  An uncertain send consumes its slot. A known event is never automatically replayed.
- Typed routine questions reuse the canonical session/RPE or plan/revision subject.
  Existing RPE returns immediately; an outstanding RPE points to the original
  follow-up. Native answered questions return their recorded answer. Unclassified
  free text is not guessed to be the same subject.
- In coordinated mode, the separately opted-in evening message can remain
  available in-app when push is disabled. An outstanding RPE reuses its existing
  question and spends no evening model request. The existing scheduler, selected
  hour, source claim and model/time budget still own generation.

Activation sequence: deploy the additive schema, inspect observation responses
and inbox outcomes, then enable the admin flag and athlete preference. Revert the
flag to stop coordination without changing model routing, deleting pending work
or replaying a failed send. Production scheduling behavior and live delivery
volume have not been measured by fixture tests.

## Evening reply continuation

The athlete can explicitly activate **Donner suite à mes réponses du soir** in
Suivi → Routines. It also requires both coordination switches. There is at most
one active evening routine per athlete. Saving an evening reply keeps the existing
once-only answer and journal operations, then queues an occurrence keyed by the
message ID. The dispatcher can recover a missing occurrence; neither path replays
an already recorded run. Replies before routine activation or current consent,
and replies about days already past, do not create catch-up work.

The run snapshots the question, answer and at most seven upcoming session
revisions in its existing definition JSON. It expires at the end of the relevant
athlete-local day. No schema migration or additional scheduler is needed. The
evening-message generation profile remains tool-free.

At the first automation segment, `agent/runtime/evening.py` asks Jev two typed
questions in one request: propose / clarify / record only, and whether an explicit
availability was declared. `coaching.py` composes the existing Jev service; the
agent owns this decision policy. The request has a 10-second deadline, a 4,096-token
envelope including 512 output tokens, zero retries, the existing explicit provider
price cap, and one durable automation model-request charge. Resumes use the saved
decision and native checkpoint. Record-only replies finish silently; the other
routes use the existing agent, domain previews and human approval. A timeout or
invalid decision fails visibly, with no fallback guess or automatic replay.

Availability is reusable only for the exact single planned session and revision
captured in the reply. Existing RPE ownership remains authoritative; unrelated
free text and ambiguous multi-session replies stay separate. Questions cannot
grant write permission or become permanent preferences. Source references connect
the evening reply, native approval, before/after preview and effect receipt. The
browser retains the originating evening identity while reviewing its continuation,
so returning through the original link preserves the thread and draft. Settled
runs refresh cached training facts and stop polling.

The existing post-session RPE and opted-in after-session routine provide the next
check-in after the adjusted session is imported. This continuation does not
implicitly activate another routine. See the [pilot checklist and measurements](coaching-pilot.md)
before enabling live delivery.

## Grouped planning decisions

`POST /coach/plan-changes` validates and stores an immutable before/after preview
for one to seven sessions; expiry is at most 48 hours and also respects the
session dates. It reuses single-session prescription and Garmin-reservation
validation. No workout changes at preview time.

`POST /coach/plan-changes/{id}/apply` requires the preview revision and a UUID
operation ID. One DuckDB transaction rechecks every owned source revision,
changes all sessions and records the outcome. Stale/foreign/expired inputs or a
late failure commit nothing. Retrying the same explicit operation after a lost
acknowledgement returns its saved receipt; a different operation conflicts.

A routine approval and its preview share one attention subject. While the native
approval is waiting, its existing review owns the single priority; applying,
dismissing, expiring or invalidating the preview removes that priority too.

The browser and native routine approval share `PlanChangeReview`. Preview tools
are classified as proposals, never as read-only operations; they retain budgets
and effect receipts. A routine's single native HITL approval covers the whole
apply operation. Review/apply does not need an auxiliary model request. Garmin
export remains an explicit separate operation, and Calendar uses its existing
reconciliation owner; local success does not claim remote success.

## Methods and request envelope

Ten native system skills now expose their French `metadata.display_name`, bounded
to 80 characters. Existing slugs remain unchanged. The four additions are
`training-trends`, `race-preparation`, `return-to-training` and
`strength-progression`. Each limits its initial reads/comparisons and reuses domain
calculations. Bodies enter MESSAGES only through native `read_file`, never SYSTEM
preloading. Skills grant no permissions.

Attention ranking, delivery arbitration, reference opening, method browsing and
plan review/apply add **zero model requests**. A method body may require a normal
agent round-trip when read. The native automation tests assert cumulative model
requests/tools/resumes, including the grouped preview/apply flow. No production
latency or token-cost reduction is claimed. Existing invocation and auxiliary
spans remain the measurement source.

The dashboard adds one bounded attention HTTP read after its main answer is
available. It reuses the query cache for 30 seconds. Browser request-budget tests
check the initial read, repeat visits and focus refresh; the first dashboard
render does not wait for the attention projection.

## Verification and evidence

Run `make check` plus `npm --prefix frontend run test:browser`. The latter includes
Chromium desktop, mobile Chromium and mobile WebKit suites. Normal tests mock
external I/O. `planning-crud.spec.ts` instead runs the real local HTTP API against
a disposable DuckDB database; it exercises writes and reloads without touching
MotherDuck or connected Garmin/Calendar accounts.

New coverage: `tests/test_coaching_coordination.py` (transaction rollback,
concurrent claims/apply, local-day quota, stale/foreign revisions, acknowledgement
replay, question reuse and migration 53); `tests/test_automations.py` (native
grouped approval); evening-message tests (in-app availability and no duplicate
RPE call); page-context tests (period/year validation and bounded aggregates).

Browser evidence is saved under `.context/`: `arete-analytics-{width}.png`,
`arete-year-{width}.png`, `arete-session-{id}-{width}.png`,
`arete-strength-{width}.png`, `arete-plan-change-{width}.png`, plus the existing
Chiron/theme/briefing screenshots. Those files are intentionally untracked;
CI uploads the `unified-experience-previews` artifact for seven days, and the PR
links the editable Figma prototypes for durable visual review.
