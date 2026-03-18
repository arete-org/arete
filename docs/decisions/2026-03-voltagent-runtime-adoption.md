# VoltAgent Runtime Adoption (Behind the Existing Backend)

**Decision:** Adopt VoltAgent as the primary agent-runtime framework behind Footnote's existing backend boundary, while keeping Footnote's user-facing API, provenance contract, and review surfaces owned by Footnote.  
**Date:** 2026-03-17

**Architectural outcome:** The adopted runtime boundary is `@footnote/agent-runtime`, which allows VoltAgent-backed text generation and legacy fallback runtimes to sit behind the existing backend contract.

---

## 1. Context

Footnote's current architecture already has some separation:

- the web app and Discord bot both go through the backend,
- the backend owns the public reflect API,
- global contracts standardize product-specific requirements (e.g., provenance, traceability).

At the same time, we still carry custom runtime work in areas that are not unique to the product:

- model-provider wiring,
- agent orchestration,
- memory and retrieval infrastructure,
- workflow composition,
- fallback and runtime resilience.

We want Footnote to focus primarily on the user-facing steerability and transparency experience, not on re-building every part of a general-purpose agent runtime from scratch.

VoltAgent is a strong candidate for that lower layer because it already provides agent/runtime capabilities that align with our desired direction:

- multi-provider model support,
- memory and retrieval primitives,
- workflow and sub-agent orchestration,
- built-in observability and runtime tooling.

---

## 2. Decision

Adopt VoltAgent as the default runtime framework for backend reflect/orchestration work, but place it behind a Footnote-owned runtime boundary rather than exposing VoltAgent directly to Footnote surfaces.

This means:

- `packages/backend` remains the network and control-plane boundary for `web` and `discord-bot`.
- VoltAgent integration should live behind a replaceable internal runtime boundary, in a **dedicated package** (rather than being spread throughout backend handlers).
- Footnote continues to own its user-facing contracts, including:
    - auth and abuse controls,
    - trace persistence,
    - provenance metadata,
    - incident/reporting flows,
    - risk and review surfaces,
    - public API shapes and compatibility.

We are explicitly **not** adopting a VoltAgent-first product architecture where `web` or `discord-bot` talk to VoltAgent directly.

---

## 3. Why This Direction

### 3.1 Focus Footnote on product-specific value

Footnote's distinguishing value is not "can call tools" or "can persist memory." Its distinguishing value is:

- steerability,
- transparency,
- provenance,
- reviewability,
- user-facing oversight.

Adopting VoltAgent lets Footnote spend less effort on generic runtime plumbing and more effort on those product-specific concerns.

### 3.2 Preserve a stable backend boundary

The backend is already the stable convergence point for:

- the web surface,
- the Discord bot,
- reflect orchestration,
- trace and incident persistence.

Keeping VoltAgent behind backend avoids introducing another externally visible service boundary or another required machine/container.

### 3.3 Keep the runtime replaceable

If VoltAgent is adopted directly inside backend handlers with no abstraction, it becomes harder to replace later and easier for framework-specific assumptions to leak into the product contract.

A dedicated runtime boundary keeps future options open:

- replacing VoltAgent,
- supporting multiple runtime implementations,
- swapping between frameworks for specific deployments,
- experimenting without changing public API contracts.

---

## 4. MVP Shape

The first milestone should be deliberately narrow.

### 4.1 Scope

The MVP should refactor the existing reflect path so the current `POST /api/reflect` endpoint keeps the same public role, but the backend can delegate the actual text-generation runtime to a swappable internal implementation.

### 4.2 Constraints

- Keep the existing `reflect` endpoint instead of adding a new one.
- Keep `web` and `discord-bot` calling `backend` exactly as they do today.
- Keep the runtime in-process behind `backend` rather than introducing a new service/container.
- Start with the text `reflect` path only.
- Exclude voice, image generation, and other OpenAI paths from the first migration.
- Keep Footnote-owned provenance and trace generation in backend.

### 4.3 Intent

The MVP should prove that Footnote can:

- preserve its current backend contract,
- swap runtime implementations behind that contract,
- evaluate VoltAgent on a real user-facing path,
- avoid premature infrastructure complexity.

---

## 5. Invariants

The implementation must preserve the following invariants:

- `web` and `discord-bot` continue to use `backend` as the sole public runtime entrypoint.
- Footnote remains the owner of user-facing provenance, trace, and review contracts.
- Runtime failures must not silently degrade Footnote's transparency guarantees.
- Missing or incomplete VoltAgent features must fail open to a Footnote-controlled fallback rather than breaking the product boundary.
- Adoption of VoltAgent must not require an additional machine or container for the MVP.

---

## 6. Consequences

- `backend` orchestration code will need to be refactored around a clearer internal runtime interface.
- Some existing OpenAI-specific reflect logic will move from "the implementation" to "the legacy runtime adapter."
- Footnote will gain a more explicit separation between:
    - product contract,
    - runtime framework,
    - storage/trace/review systems.
- The first adoption step will improve long-term flexibility even if VoltAgent is later replaced.

---

## 7. Follow-up Direction

If the MVP is successful, later phases may expand VoltAgent usage into:

- richer provider abstraction,
- memory and retrieval integration,
- workflow-driven orchestration,
- broader runtime replacement of custom backend agent logic.

Those later phases should remain conditional on proving that Footnote's product invariants stay intact under the new runtime layer.
