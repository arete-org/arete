# Onboarding Arete — personal knowledge

## 1. Problem Statement

A new athlete needs to give Chiron a useful starting point without having to
repeat their goal, sports and availability in the first conversation.

A summary that only appears in the UI is insufficient: confirmed answers must
reach the actual model context and remain correctable and forgettable.

The implementation uses the existing Markdown ledger and CompositeBackend.
It introduces no second biography store, migration or automatic model request.

---

## 2. Context & Background

[Figma Onboarding](https://www.figma.com/design/tYBFziSyBC4pfdAqiaDT4X/Arete?node-id=267-1123)
contains 20 main frames: five screens, mobile/desktop, Pierre/Prune, plus
Garmin, error, resume and keyboard examples. All athlete data there is illustrative.
The guide board documents the final Markdown contract.

`services/memory.py` already owns transactional, athlete-scoped Markdown files.
`LedgerBackend` is mounted at `/memories/` by the existing `CompositeBackend`.
`services/journal.py` contributes the ledger through the central context builder.

---

## 3. Goals & Non-Goals

- Collect an optional name, goal, description, race intent, sports, frequency,
  rest preferences, constraints and explicitly confirmed timezone.
- Preserve an incomplete draft through navigation and reload on this browser.
- Confirm once into `/memories/profile.md`; allow later correction/forgetting
  through the existing coach filesystem tools.
- Open a fresh Chiron thread with visible context and an empty composer.

No Strava, training-plan generation, phase mapping, installation prompt,
notifications, Slack or calendar configuration belongs in the flow.
The profile informs coaching; it does not overwrite application settings.

---

## 4. Architecture & Design

1. The authenticated app reads `GET /onboarding` for its current athlete.
2. The guided route reads the local draft keyed by athlete ID and schema version.
3. Each input updates that draft; a storage failure is shown without discarding it.
4. Back changes only the current step. Plus tard preserves the draft and returns home.
5. The dashboard entry resumes the same step in the same browser.
6. Garmin login/MFA and bounded explicit import reuse the existing components.
7. The recap shows actual connection/import state and explicitly missing answers.
8. Confirmation sends `POST /onboarding` with a UUID, expected ledger revision
   and bounded typed answers. The server derives ownership from authentication.
9. `services/onboarding.confirm` renders literal declarations, and
   `memory.append_entry` writes a server-dated profile atomically.
10. A fresh browser thread receives `onboarding:1`, a reference to the current
    athlete's live ledger, not a browser-supplied profile or another athlete ID.
11. `GET /onboarding/context` supplies visible context; `journal_block` supplies
    the complete current profile when a personal coaching request actually runs.
12. Edits/deletion use existing `edit_file`/`delete` through CompositeBackend.
    Reload and subsequent model boundaries read the current content.

The ledger receipt contains a command UUID and answer hash. A retry of the same
confirmation acknowledges the existing receipt; it never appends twice. Concurrent
initial writes use expected revision zero. A forgotten profile retains its tombstone
revision, so an old request cannot recreate it.

Resource envelope: zero model/provider calls for confirmation; one confirmation
HTTP request with a 20-second browser timeout, no automatic write retry. Drafts
are capped at 8,000 serialized characters; text answers at 80/180/280 characters,
sports at four, rest days at seven, sessions at 1–14. `profile.md` is capped at
8,000 characters on writes and context reads, with explicit failure on overflow.
The existing complete-request token budget remains authoritative.

---

## 5. Scope & Rollout

The route is `/onboarding`; authenticated unconfigured visitors enter from home.
Self-hosted users can use « Terminer ma configuration ». Existing conversations,
manual drafts and attachments remain owned by their existing browser threads.

Acceptance covers connected and disconnected paths, optional unknowns, resume,
failed confirmation with explicit retry, ownership isolation, concurrency,
idempotency, real Markdown persistence, context injection, and forgetting.
The new profile path uses existing tables and account lifecycle/export handling.

Draft resume across devices is outside this implementation. The confirmed profile
is server-side and follows the athlete across devices. Live Garmin and live model
quality are not claimed by offline tests; provider behavior is simulated there.

---

## 6. Safety & Guardrails

Skipped constraints stay unknown. No six-session default is selected. Race data
expresses intent and never creates a race plan or selects build/peak/recovery.
Credentials and MFA codes never enter the profile or browser onboarding draft.
Connected does not mean imported; an interrupted stream is never shown as success.
Opening Chiron sends nothing and does not fill the composer. Fixed starters require
an explicit click. Profile text is labelled athlete data, never permissions.

---

## 7. Implementation Handoff

- UI: `frontend/src/pages/Onboarding.tsx`, `onboarding.css`, and `lib/onboarding.ts`.
- API/domain: `api/onboarding.py`, `services/onboarding.py`, existing memory owner.
- Context/tools: `services/journal.py`, `agent/backends/journal.py`, `append_journal`.
- Conversation: existing `useCoachThreads`, with a live `OnboardingContext` region.
- Verification: `tests/test_onboarding.py`, filesystem tool tests and
  `frontend/browser-tests/onboarding.spec.ts`.

The browser suite launches a temporary real API/database for ledger operations.
Only Garmin, unrelated dashboard reads and the model transport are simulated.
Its screenshots are written under `.context/onboarding/`.

---

## 8. Before / After

Before: Chiron starts without an athlete-declared profile.
After: confirming « 3 séances, course et renforcement, mercredi indisponible »
creates readable Markdown available to the first and subsequent personal turns.
Correcting Wednesday to Friday changes the same file; forgetting removes its
content from the visible handoff and future context, with no hidden duplicate.

---

## 9. Result

The design and code share the same optional, resumable onboarding structure.
Personalization comes from one existing ledger, with no new model call or database
schema. Validation results and review screenshots are reported with the change.
