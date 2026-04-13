# Footnote and Common Agentic Patterns

This page is a translation guide.

It helps contributors map common agent vocabulary onto Footnote's architecture
without erasing Footnote's own semantics.

Use it like this:

- start with the Footnote term,
- use the common pattern as orientation,
- keep Footnote's constraints as the real rule.

## Quick Crosswalk

- Routing -> `workflow mode` selection and `workflow profile` resolution
- Planning -> bounded planner step
- Reflection -> review / revise path, plus future bounded TRACE refinement
- Tool use -> Execution Contract-limited tool execution
- Memory -> planned, bounded by provenance and governance
- MCP -> protocol boundary for capability access, not policy authority

## Routing

**What common pattern it resembles**

Routing in other systems usually means deciding which execution path to take.
That may mean picking a fast path, a tool path, or a more careful multi-step
path.

**What Footnote calls it**

Footnote uses `workflow mode` for the high-level run choice and `workflow profile`
for the concrete executable shape.

Current examples:

- `workflow mode`: `fast`, `balanced`, `grounded`
- `workflow profile`: `generate-only`, `bounded-review`

**What constraints Footnote adds**

- Routing stays inside Execution Contract guardrails.
- Mode and profile are related, but they are not the same thing.
- Backend owns the final routing decision.
- Fail-open fallback still applies when requested routing input is missing or
  unknown.

**What it is not**

- not a free-form runtime graph builder
- not per-request workflow scripting
- not a license for callers or adapters to invent new authority semantics

## Planning

**What common pattern it resembles**

Planning resembles the common "planner" step that decides what kind of action
should happen next before execution continues.

**What Footnote calls it**

Footnote treats planning as a bounded planner step. It is part of orchestration,
not the owner of orchestration.

**What constraints Footnote adds**

- Planning is bounded in purpose and shape.
- Planner output can be adjusted or rejected by policy.
- Planner metadata is recorded as execution/provenance data.
- Planning must stay serializable and inspectable.
- Planning should align with steerability, provenance, and backend-owned
  control logic.

**What it is not**

- not unbounded planning loops
- not a self-directed agent deciding its own authority
- not a replacement for Execution Contract policy

## Reflection / Review

**What common pattern it resembles**

This resembles reflection, critique, or reviewer passes used in other agent
systems to assess and possibly improve a draft.

**What Footnote calls it**

Today Footnote has a review / revise path in bounded-review workflows.
Future TRACE refinement may add another bounded refinement seam, but still under
Footnote control.

**What constraints Footnote adds**

- Review is optional and policy-gated.
- Review decisions are bounded: finalize or revise.
- Revision stays inside grounding and provenance boundaries.
- TRACE remains Footnote-specific response temperament metadata, not a generic
  self-improvement score.
- Backend remains the authority for when review can happen and when it stops.

**What it is not**

- not uncontrolled self-critique
- not an endless improve-until-perfect loop
- not permission to rewrite provenance or blur sourced versus inferred content

## Tool Use

**What common pattern it resembles**

This resembles standard agent tool calling: a model or planner requests an
external capability, and runtime executes it if allowed.

**What Footnote calls it**

Footnote treats this as Execution Contract-limited tool execution with explicit
intent, eligibility, outcome state, and reason codes.

**What constraints Footnote adds**

- Tool use is governed by backend policy, not by tool adapters.
- Tool outcomes are normalized as `executed`, `skipped`, or `failed`.
- Non-executed outcomes need explicit reason codes.
- Provenance, reviewability, and cost accounting stay Footnote-owned.
- Fail-open behavior remains the default unless an explicit policy says
  otherwise.

**What it is not**

- not tools deciding policy
- not silent tool-intent dropping
- not a hidden side channel around provenance or review semantics

## Memory

**What common pattern it resembles**

This resembles agent memory: storing useful information across steps or across
requests.

**What Footnote calls it**

Memory is still planned work in Footnote. The near-term idea is bounded memory,
not open-ended agent identity or autonomous long-horizon recall.

**What constraints Footnote adds**

- Memory must fit provenance and governance requirements.
- Memory should stay behind Footnote's backend boundary.
- Public contract behavior must remain serializable and inspectable.
- Memory only helps if it improves user-visible transparency and steerability,
  not just runtime cleverness.

**What it is not**

- not a commitment to broad long-term memory now
- not hidden persistence that weakens user understanding
- not a reason to bypass provenance, review, or authority boundaries

## MCP as a Protocol Boundary

**What common pattern it resembles**

MCP resembles a standard protocol layer for exposing tools or resources to a
runtime in a more uniform way.

**What Footnote calls it**

For this pass, MCP is best understood as a possible protocol boundary for
capability access.

**What constraints Footnote adds**

- MCP is useful if it reduces coupling at the tool/resource boundary.
- MCP is not useful if it only adds protocol ceremony or just renames existing
  registry concepts.
- MCP does not replace backend policy, provenance, review, or governance
  authority.
- Local MCP exploration is valid, but this page does not commit Footnote to an
  MCP migration.

**What it is not**

- not a default replacement for the current tool architecture
- not policy authority
- not a replacement for Footnote's authority boundaries

## Bottom Line

Footnote does use some patterns that people will recognize from wider agent
systems.

But Footnote is not trying to become a generic vocabulary demo.

The semantic center stays the same:

- Execution Contract governs authority
- `workflow mode` and `workflow profile` govern run shape
- TRACE, provenance, and steerability stay Footnote-native
- backend remains the control-plane boundary
