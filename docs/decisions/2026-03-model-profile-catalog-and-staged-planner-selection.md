# Model Profile Catalog + Staged Planner Selection

**Decision:** Introduce a backend-owned model profile catalog first, then layer planner-driven profile selection in a separate follow-up branch.  
**Date:** 2026-03-25

---

## 1. Context

Footnote now has a cleaner runtime seam and basic model tier support, but model selection is still spread across defaults, planner behavior, and adapter logic. That makes it harder to add new models cleanly, reason about routing, and keep planner decisions auditable.

We want a stable model-selection foundation before expanding planner behavior. We also want to avoid changing too many risk-heavy parts (planner prompt/schema + runtime routing + config migration) in one branch.

---

## 2. Decision

Adopt a two-branch execution model:

1. **Branch A: Profile Catalog Foundation**
  Build the model profile catalog and runtime resolution path without changing planner selection behavior.
2. **Branch B: Planner Selection Integration**
  Teach the planner to choose response profiles using the new catalog metadata.

This keeps foundational routing changes and planner behavior changes isolated for safer review and rollback.

---

## 3. Scope and Boundaries

- This decision is provider-neutral and does not commit to any new provider rollout in this branch set.
- No new public API endpoints are required for v1.
- Backend remains the control plane. Runtime adapters remain internal execution layers.
- Footnote-owned provenance and trace semantics remain outside adapter internals.

---

## 4. Branch A — Profile Catalog Foundation

### 4.1 Goal

Create a data-driven profile catalog and deterministic runtime resolver, while keeping planner behavior functionally unchanged.

### 4.2 Substeps

1. **Define profile schema and validation**
  - Add a backend-owned catalog schema with warn-and-skip validation.
  - Required profile attributes:
    - `id`
    - `description`
    - `provider`
    - `providerModel`
    - `enabled`
    - `tierBindings` (current vocabulary: `text-fast`, `text-quality`)
    - `capabilities`
  - Optional profile attributes:
    - operational limits (`maxInputTokens`, `maxOutputTokens`)
    - bounded planner metadata (`costClass`, `latencyClass`)
2. **Add catalog storage and loading**
  - Store catalog in backend config as YAML.
  - Parse and validate at backend startup.
  - Keep fail-open semantics: invalid entries are skipped with warnings.
3. **Add default selector config**
  - Introduce `DEFAULT_PROFILE_ID`.
  - Use hard cutover semantics for this path (no compatibility bridge from legacy default selector behavior inside this branch plan).
4. **Implement runtime resolution**
  - Resolver accepts `GenerationRequest.model` as:
    - profile ID,
    - tier alias,
    - raw model string (fallback path).
  - Resolution fails open to default profile with warning on unknown/disabled/unusable targets.
5. **Integrate with existing runtime adapter seam**
  - Keep tier vocabulary stable (`text-fast`, `text-quality`).
  - Ensure adapter still resolves to a concrete runtime model string deterministically.
6. **Validate with targeted tests**
  - catalog parsing/validation tests
  - resolver behavior tests (profile/tier/raw/fallback)
  - regression tests for current tier behavior

### 4.3 Out of Scope for Branch A

- Planner choosing profile IDs.
- Planner prompt/schema updates for profile choice.
- Any new external profile-management API.

---

## 5. Branch B — Planner Selection Integration

### 5.1 Goal

Use the profile catalog for planner-selected response routing, while keeping planner execution stable and bounded.

### 5.2 Substeps

1. **Add planner selector config**
  - Introduce `PLANNER_PROFILE_ID` for the planner model path.
  - Keep planner execution model stable and explicit.
2. **Extend planner prompt contract**
  - Add response profile selection output (profile ID).
  - Provide bounded profile context in prompt input:
    - `id`
    - `description`
    - `costClass`
    - `latencyClass`
    - capability hints
3. **Update planner normalization/validation**
  - Validate selected profile ID.
  - On invalid/unsupported selection, fail open to default profile and log warning.
4. **Enforce runtime guardrails**
  - Runtime remains authoritative for capability checks.
  - Planner hints do not bypass runtime validation or fallbacks.
5. **Add planner-focused tests**
  - planner output parsing with selected profile
  - invalid selection fallback behavior
  - capability mismatch handling
  - full chat flow regression with profile-selected routing

### 5.3 Out of Scope for Branch B

- Automatic model discovery.
- Database-backed profile CRUD.
- Provider rollout work.

---

## 6. Invariants

- Backend remains the only public control-plane boundary.
- Runtime adapters resolve concrete execution targets; public contracts stay Footnote-owned.
- Unknown or invalid model selection input fails open to safe defaults with explicit warnings.
- Planner selection signals are advisory until validated by runtime guardrails.

---

## 7. Consequences

- Model routing becomes data-driven and easier to audit.
- Planner and runtime responsibilities become clearer:
  - planner chooses intent/profile target,
  - runtime enforces concrete feasibility and fallbacks.
- Branch-by-branch rollout reduces blast radius and improves review clarity.

