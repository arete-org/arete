# Coach-led experience: validation and pilot

This rollout reuses the existing attention switches, automation limits and
notification receipts. Both coordination switches remain off by default. No
production configuration or athlete preference is changed by this implementation.

## Invocation envelope

| Action | Additional model requests | Bound and owner |
| --- | --- | --- |
| Rank home priorities, open card, save evening answer | 0 | Existing projection / HTTP reads; answer queues only |
| Classify one opted-in evening reply | 1 Jev request | 10 s, 4,096 tokens including 512 reserved output tokens, zero retry |
| Record-only reply | No generative call or notification | Existing run completes with saved receipt |
| Prepare and apply an adjustment | Existing automation calls + classifier | Shared 24 requests, 8 turns, 24 tool calls, 4 resumes; 120 s per segment / 240 s active |
| Review / approve | 0 at screen opening | Native interrupt; dispatcher resumes later |
| Planning source freshness | 0 | One cached HTTP status read, 60 s stale time, no retry |

The deterministic real-graph test of 45 → 25 minutes uses three requests before
approval (one Jev, preview, then approval request) and one after approval. It does
not establish production model accuracy or latency. Run counters accumulate
across resumes. `active_seconds` measures processing time; `finished_at-created_at`
also includes dispatch and athlete waiting. Preserve that distinction in reports.

## Speed evidence — ARE-170 and children

Offline measurements on 2026-10-23, using the same local Python environment,
`convert_to_openai_tool`, JSON with `ensure_ascii=False`, and `o200k_base` tokens.
Historical sources were extracted with `git archive`; no athlete database or
provider was queried. `scripts/measure_coach_runtime.py [source-root]` reproduces
the procedure; `.context/measure-*.json` retains the local outputs.

| Work | Before | Current | Interpretation |
| --- | --- | --- | --- |
| ARE-171 tool schemas | 49,844 chars / 14,640 tokens / 30 tools (`4235e1b2^`) | 32,909 chars / 9,262 tokens / 31 tools | 34% fewer characters, 37% fewer estimated tokens; includes the new evening trigger. HEAD before this change was 32,481 chars. Structured prescription creation still needs its separate call. |
| ARE-172 stable prefix | 5,967 chars shared with final call; 8,606 with changed sync state (`253de65e`) | 13,892 / 12,712 chars | Same synthetic 13,892-character prompt; reordered sections only. Change `6329a012` is now merged upstream; this branch also covers the body-log section in its ordering tests. This is cache eligibility, not a measured cache hit rate. |
| ARE-174 repeated ledger reads | Each of facts, journal and follow-ups read 4 times (`6a6d34ca^`) | Each read once across 4 context builds | Invocation cache already present; write invalidation and concurrent run isolation remain covered by behavior tests. |
| ARE-173 cold imports | Historical local samples 918–1,085 ms | Two current samples 777–874 ms | Too few samples and too much shared-machine noise to claim a speedup. Anthropic still loads transitively through pinned Deep Agents; the existing upstream-dependent test is skipped. Keep this gap open. |

ARE-209 now selects the official Playwright Noble image directly from the locked
`@playwright/test` version (currently 1.64.0), so a version bump selects its matching
image automatically. This removes the browser/apt install step; `npm ci` remains
reproducible and bounded to five minutes. The registry manifest was verified;
actual GitHub job wall time still needs a run. The pattern
follows [Playwright's CI guidance](https://playwright.dev/docs/ci).

Before a manual deployment, upgrade the outdated local Vercel CLI with
`npm i -g vercel@latest` (or `pnpm add -g vercel@latest`). This change does not
alter the deployment workflows' separately pinned CLI versions.

## Journey evaluation

Normal tests fake provider inference and exercise real domain/runtime boundaries:
duplicate and concurrent replies, same-session revision reuse, renewed consent,
cross-athlete isolation, late events, expired/stale previews, unknown remote writes,
approval resumes, and record-only silence. Browser journeys cover mobile/desktop
drafts, source links, before/after review, effect receipts and no model call on
opening. Existing notification concurrency and failure tests preserve the caps.

The synthetic classifier set is `tests/data/coaching/evening_decisions.jsonl`:
explicit constraints, thanks, one-off refusals, ambiguity, poor recovery and an
instruction embedded in an answer. Run:

```sh
uv run python scripts/evaluate_evening_decisions.py --live
```

It allows at most 32 sequential paid Jev requests with the production ten-second
deadline and no retries, reports labels, usage and median/max latency, and fails
on a mismatch. It reads no athlete database. Live evaluation was not run locally
because `OPENROUTER_API_KEY` was absent. Passing this small set is a regression
signal, not proof of safe or effective coaching. Keep the pilot off until those
outputs have been reviewed.

Local verification on 2026-10-23:

- After rebasing onto `b2b0c53b`, the full
  `PYTEST_ADDOPTS='-n 2 --dist=loadfile' make check` passed: 3,544 backend tests
  (two existing skips, three expected failures), lint, formatting, mypy, CI policy
  tests, transport tests, all 697 frontend tests and the production build. This
  includes the corrected KPI fixture, timezone and trace-correlation boundaries.
- Browser suites passed for attention, automations, briefing, evening replies,
  goals, themes, source/request counts, form curves, coach naming and mobile UX.
  The full run passed 261 of 263 cases and exposed two layout regressions. After
  corrections, 82 affected cases passed; the remaining tablet-spacing correction
  then passed all eight Planning/request journeys. Final lint/build passed too.
  Mobile UX includes Chromium and WebKit. Screenshots and full logs are in
  `.context/`; live provider and deployed UI behavior are not inferred from them.

## Preview and opted-in pilot

1. After local acceptance and authorized shipping, deploy through the existing PR
   preview workflow. Confirm `/api/health` is healthy; read real data only through
   authenticated HTTP. Do not run database scripts against MotherDuck.
2. Start with the admin `coaching_attention` flag off. Inspect the observation
   projection and existing source cards. Confirm no extra requests on home/card
   opening, current consent and source freshness, and empty-state silence.
3. Enable the admin flag in preview. On the explicit pilot athlete only, enable
   coordinated coaching and the evening message in Coach settings, then configure
   and activate the evening routine. There must be only one active evening owner.
   Check timezone, evening hour and notification categories/cap before activation.
4. Answer “Demain, je n’ai que 25 minutes”. Verify one queued occurrence, one Jev
   span, native proposal, unchanged plan before approval, and confirmed effect
   after the next dispatcher pass. Also test decline, ambiguity, new plan revision
   before approval, late activity import and a failed remote export. No failed or
   ambiguous write is automatically replayed.
5. Check the following session's existing RPE owner; optionally activate the
   after-session preset for adjustment follow-ups. No answer should be asked twice
   for the same subject/revision. One refusal must not change permanent preferences.
6. Review one week before expanding. Disable coordination or pause the evening
   routine to stop new segments. An already running synchronous write may finish;
   inspect its receipt instead of replaying it. No pending work is deleted by the
   flag change.

Measure proposal acceptance over actual offered proposals; evening replies over
successfully written messages (now exposed in the admin KPI table/CSV); duplicate
deliveries per attention subject; model requests and active latency per completed
action; provider-reported token cost from the Jev/agent traces. Report failed runs
and waiting time separately. Jev spans carry the automation thread ID and evening
source reference so their costs can be joined to the saved run. The 60% weekly acceptance and 40% evening-response
targets are hypotheses; samples and denominators must accompany them. Do not infer
a permanent preference from a dismissal.

## Ticket reconciliation

| Ticket | Local evidence / remaining acceptance |
| --- | --- |
| ARE-168 | Server evening/approval/RPE naming follows game opt-in; manifest colors match Pierre. Legacy token aliases, installed splash/icon verification and remaining identity coverage stay open. |
| ARE-102 / ARE-33 | Existing mobile launchers, sticky logging controls, 44 px touch targets and typography are exercised by mobile Chromium/WebKit tests; verify the deployed build before closing. |
| ARE-141 | Existing rituals retained; priority placement, reply continuation and evening response KPI added. Live acceptance/response targets unverified. |
| ARE-63 | Goals route, Garmin freshness and journal dictation guidance added. Per-source last successes/errors, dashboard dictation entry, moved-screen starters and reduction to eight Settings tabs remain open. |
| ARE-12 | Migration/review rules in `design.md`, shared-owner inventory, gallery evidence and the browser environment are documented. |
| ARE-136 / ARE-86 | Component inventory, Figma screen mappings and a four-theme gallery added. Complete per-primitive states and named Figma component mappings remain design work. |
| ARE-31 | Scheduled after the pilot validates the core journey; no gamification redesign bundled here. |

Do not close tickets based on this local checklist alone. Production switch values,
deployed UI acceptance and live notification volume remain rollout evidence.
