# Temporary Refactoring Reference (AI report from DeepWiki)

This document collects the current refactoring and quality concerns found in the Footnote codebase, and groups them into clean, branch-sized workstreams.

- one branch = one clear purpose
- refactors stay separate from behavior fixes
- testing and docs are included where they matter
- no branch should mix unrelated cleanup with functional changes

## Why this exists

- stubbed core logic
- disabled features hidden behind permissive constants
- declared-but-unused configuration
- TODO/debug code left in production paths
- docs that look complete but are actually scaffolds
- missing tests for important AI decision logic

This reference turns those findings into a clean branch list.

---

## Confirmed concerns

### Structural / tooling concerns
- `pnpm pre-review` is still a shell chain instead of one orchestrated validation flow.
- `scripts/validate-footnote-tags.js` is regex-heavy and misses `.tsx` coverage.
- Annotation docs and allowed values have drifted.
- Cursor config is spread across multiple files and contains stale references.
- The `@footnote-*` validator checks structure, not whether the implementation matches the annotations.

### Quality / implementation concerns
- `computeProvenance()` and `computeRiskTier()` are hardcoded stubs.
- `reduceContext()` is effectively disabled by a magic threshold value.
- `RealtimeEngagementFilter` has declared-but-unused or stubbed logic:
  - `decay` weight is not applied
  - `refineLLM()` returns the input unchanged
  - `scoreCostSaturation()` uses a guessed `* 0.1` proxy
- `resolveChannelOverrides()` always returns `undefined`.
- `budgetRemainingUsd` is always logged as `null`.
- Typos exist in identifiers and prompt/log strings.
- Debug logging marked `TODO: REMOVE` is still present.
- A large commented-out webhook block remains in production code.
- `docs/ai/refactoring_guru_playbook.md` is scaffolded but mostly empty.
- Important AI-facing modules have no direct regression tests.

---

## Branch list

## 1. `refactor/pre-review-orchestrator`

**Purpose:** Replace the current chained pre-review command with one orchestrated validation entrypoint.

**Why this branch exists:** Today, validation is split across separate commands with separate error formats and repeated filesystem work.

**What should go in this branch:**
- Add a single pre-review runner script.
- Centralize file walking and diagnostics formatting.
- Keep `tsc` and `eslint` as subprocesses, but report them through one result format.
- Add preflight checks for missing local binaries like `tsx`, `typescript`, and `eslint`.
- Add support for full and changed-file validation modes.

**What should not go in this branch:**
- No behavior changes in app code.
- No heuristic changes.
- No annotation format redesign.

---

## 2. `refactor/annotation-governance-core`

**Purpose:** Make `@footnote-*` validation consistent, explicit, and easier to maintain.

**Why this branch exists:** The current validator is regex-based, misses `.tsx`, and allows drift between docs and enforcement.

**What should go in this branch:**
- Create one canonical annotation schema.
- Replace regex parsing with a structured parser.
- Validate both `.ts` and `.tsx`.
- Enforce tag order and required rationale text.
- Update docs to match the real schema.
- Standardize valid values:
  - scope: `core`, `utility`, `interface`, `web`, `test`
  - level: `low`, `moderate`, `high`

**What should not go in this branch:**
- No decorators.
- No TypeScript transformers.
- No runtime behavior changes.

---

## 3. `quality/ai-generated-code-guardrails`

**Purpose:** Catch common AI-generated code problems earlier in validation.

**Why this branch exists:** Structure-only checks do not catch stubs, disabled logic, dead code, or suspicious placeholders.

**What should go in this branch:**
- Add validation rules for:
  - hardcoded stub returns in important modules
  - magic-number bypasses
  - TODO-marked disabled logic
  - long commented-out code blocks
  - production debug code marked for removal
  - obvious typo patterns in identifiers and user-facing strings
- Raise `no-explicit-any` from warning to error.

**What should not go in this branch:**
- No implementation of the flagged logic yet.
- No broad lint/style cleanup unrelated to the guardrails.

---

## 4. `quality/ethics-evaluators-implementation`

**Purpose:** Replace fake ethics logic with real deterministic heuristics.

**Why this branch exists:** `computeProvenance()` and `computeRiskTier()` currently present a high-confidence surface with no real logic behind it.

**What should go in this branch:**
- Implement basic deterministic provenance classification.
- Implement basic deterministic risk-tier classification.
- Keep the logic transparent and documented.
- Add direct tests for both functions.

**What should not go in this branch:**
- No LLM-based evaluator.
- No API changes.
- No broad ethics-core redesign.

---

## 5. `quality/engagement-and-budget-logic`

**Purpose:** Remove or complete declared features that currently do nothing.

**Why this branch exists:** Several important engagement and budget-related fields/methods exist in the code but are inert or placeholder-only.

**What should go in this branch:**
- Either apply `decay` in `RealtimeEngagementFilter` or remove it cleanly.
- Replace fake cost saturation math with real tracked logic.
- Either implement or remove `refineLLM()`.
- Either implement or remove `resolveChannelOverrides()`.
- Populate `budgetRemainingUsd` when real data exists, or omit it instead of logging `null`.
- Replace the disabled `reduceContext()` threshold with a real threshold strategy or explicit config flag.

**What should not go in this branch:**
- No logging refactor.
- No provider-agnostic pricing redesign.

---

## 6. `refactor/logging-factory`

**Purpose:** Standardize scoped logger creation and naming.

**Why this branch exists:** Logger setup is repeated manually, and some logger variables are inconsistently named.

**What should go in this branch:**
- Add a shared `createScopedLogger()` helper in package-local logger utilities.
- Replace direct `logger.child(...)` call sites.
- Clean up misleading names like `const console = ...`.
- Keep redaction behavior unchanged.

**What should not go in this branch:**
- No semantic logging policy rewrite.
- No behavior changes in business logic.

---

## 7. `refactor/cost-tracking-abstraction`

**Purpose:** Separate pricing logic from provider-specific and Discord-specific assumptions.

**Why this branch exists:** Cost tracking is currently too tightly coupled to current runtime details.

**What should go in this branch:**
- Introduce provider-neutral usage and pricing interfaces.
- Keep the current OpenAI implementation as the first adapter.
- Preserve `ChannelContextManager.recordLLMUsage()` compatibility.

**What should not go in this branch:**
- No second provider yet.
- No storage redesign.
- No UI changes.

---

## 8. `refactor/cursor-config-generation`

**Purpose:** Consolidate Cursor configuration into one source of truth.

**Why this branch exists:** Cursor config is spread across many files and contains stale references.

**What should go in this branch:**
- Add a single manifest for Cursor config.
- Generate the JSON config/task/snippet files from that manifest.
- Remove invalid or stale path references.
- Align generated files with the annotation schema and lint rules.

**What should not go in this branch:**
- No dynamic runtime prompt system.
- No changes to app prompts beyond config cleanup.

---

## 9. `refactor/provenance-presentation-tokens`

**Purpose:** Remove duplicated provenance UI constants.

**Why this branch exists:** Risk-tier colors are duplicated between Discord and web code.

**What should go in this branch:**
- Extract shared risk-tier presentation tokens.
- Use the shared tokens in Discord and web provenance components.

**What should not go in this branch:**
- No UI redesign.
- No behavior changes to provenance logic.

---

## 10. `refactor/header-scaffolding`

**Purpose:** Make it easier to create correct module headers.

**Why this branch exists:** The header format is strict, but authoring is still manual and easy to get wrong.

**What should go in this branch:**
- Add a small scaffolding command for new headers.
- Generate editor snippets from the same schema.
- Keep placeholders explicit so humans still write the real reasoning.

**What should not go in this branch:**
- No automatic ethics/risk inference.
- No editor auto-save mutation.

---

## 11. `quality/test-coverage-for-ai-decision-logic`

**Purpose:** Add regression protection around the most important AI-facing logic.

**Why this branch exists:** Several critical modules currently have no direct tests.

**Primary targets for new tests:**
- `CatchupFilter`
- `ChannelContextManager`
- `LLMCostEstimator`
- `RealtimeEngagementFilter`
- `computeProvenance`
- `computeRiskTier`

**What should go in this branch:**
- Focused unit tests for decision logic.
- Tests for fail-open behavior.
- Tests for cost/risk/provenance edge cases.

**What should not go in this branch:**
- No refactoring unless needed to make the code testable.
- No unrelated test cleanup.

---

## 12. `quality/docs-and-playbook-completion`

**Purpose:** Fix docs that currently create false confidence.

**Why this branch exists:** Some AI/process docs look complete but are only scaffolds.

**What should go in this branch:**
- Finish or trim `docs/ai/refactoring_guru_playbook.md`.
- Update AI workflow docs to match the real enforcement pipeline.
- Add a short reviewer checklist for common AI-generated-code failures:
  - stubs
  - disabled logic
  - typos
  - dead commented code
  - missing tests

**What should not go in this branch:**
- No implementation changes unless needed to keep docs accurate.

---

## Recommended order

1. `refactor/pre-review-orchestrator`
2. `refactor/annotation-governance-core`
3. `quality/ai-generated-code-guardrails`
4. `quality/ethics-evaluators-implementation`
5. `quality/engagement-and-budget-logic`
6. `refactor/logging-factory`
7. `refactor/cost-tracking-abstraction`
8. `refactor/cursor-config-generation`
9. `refactor/provenance-presentation-tokens`
10. `refactor/header-scaffolding`
11. `quality/test-coverage-for-ai-decision-logic`
12. `quality/docs-and-playbook-completion`
