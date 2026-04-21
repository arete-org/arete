# Feature Proposal: Optional Langfuse Shadow Observability

**Last Updated:** 2026-04-21

---

## Overview

This proposal recommends a narrow experiment: optional **Langfuse** integration
as a shadow observability layer for Footnote maintainers and operators.

Footnote already records a lot about one response. Current response metadata
and trace storage cover routing, workflow lineage, planner influence,
provenance, TRACE posture, steerability controls, tool outcomes, and
backend-recorded cost. That is the right foundation for explaining one run.

The missing piece is a good maintainer view across many runs.

That gap is where Langfuse may help. Not as a replacement for Footnote traces,
and not as a new policy or provenance authority. More as an optional operator
workbench for cross-run inspection, debugging, evaluation collection, and drift
spotting.

The proposed direction is deliberately narrow:

- optional,
- disabled by default,
- metadata-only by default,
- fail-open,
- removable without changing Footnote's public product meaning.

Langfuse may help us inspect Footnote. It should not become the thing that
defines Footnote.

---

## Why This Is Worth Considering

Footnote's trace and metadata work already answers an important question:
"what happened here?"

For one response, maintainers can inspect:

- selected workflow mode,
- workflow lineage,
- planner influence recorded in `metadata.execution[]`,
- provenance classification,
- TRACE target/final posture,
- tool and evaluator outcomes,
- and backend-recorded usage/cost metadata.

That is useful for one run. It is less useful for watching patterns across many
runs.

A maintainer may want to know:

- which workflow modes are actually common,
- where planner or provider fallback happens,
- which model routes are expensive,
- whether a prompt change improved anything,
- whether one workflow path generates noisy review cycles,
- which runs should become eval examples,
- or whether a regression is only visible at aggregate scale.

Footnote could eventually build more of that natively. Some of it may belong in
Footnote over time. But a full cross-run observability and evaluation surface is
not the core product right now, and it is not free to build well.

Langfuse already operates in that space. It is worth trying only if the
experiment stays small and does not blur Footnote's own architecture.

---

## Footnote Context

Footnote is not just a thin wrapper around a model provider.

The project already has its own semantics for:

- Execution Contract authority,
- workflow mode and workflow profile selection,
- TRACE posture,
- provenance and response metadata,
- steerability controls,
- TrustGraph evidence handling,
- incident storage and audit,
- pseudonymization boundaries,
- and backend cost recording.

Those meanings are part of the product. They are not generic telemetry.

That matters because Langfuse uses similar words: traces, observations, scores,
prompts, datasets, evaluations. The overlap is useful, but it is also where the
risk lives.

A Langfuse trace is not automatically the same thing as a Footnote trace.
A Langfuse score is not automatically a Footnote policy signal.
A Langfuse prompt version is not automatically a safe replacement for Footnote's
prompt resolution.

Footnote's backend should remain the place where those meanings are decided.
Langfuse can receive a mirrored view of some runtime metadata, but it should not
become the source of truth for public trace retrieval, user-facing provenance,
incident records, Execution Contract behavior, or cost accounting.

Put simply: Langfuse can help maintainers inspect runs. Footnote still owns the
run.

---

## Current Code Alignment

This proposal assumes the current architecture and should be read with a few
repo realities in mind:

- Footnote already has optional observability-related wiring for VoltAgent
  tracing configuration. This proposal is not introducing the first
  observability seam in the repo. It is proposing a separate backend-owned
  shadow exporter for Footnote runtime metadata.
- The durable public trace key today is `responseId`. The current trace store
  and public trace routes are keyed around that concept. This proposal should
  not invent a second first-class "trace ID" concept unless the architecture
  changes later.
- Planner metadata affects execution today, but planner is not yet a first-class
  workflow step in current workflow lineage. Planner influence is recorded in
  `metadata.execution[]` and related metadata surfaces alongside workflow
  lineage.
- Backend is already the authority for LLM cost recording. Any export to
  Langfuse should mirror that backend-owned value, not replace it.
- Footnote does not currently have a broad, general-purpose user consent model.
  There is incident-specific consent metadata (`consentedAt`) in incident
  records, but this proposal should not imply that Langfuse integration plugs
  into a wider consent framework that does not yet exist.

These constraints are part of the proposal, not editorial footnotes.

---

## The Boundary We Should Keep

The boundary is simple.

Langfuse can inspect runs. It should not decide what a run means.

That means Langfuse should not replace:

- Footnote trace storage,
- public trace retrieval,
- response metadata assembly,
- workflow semantics,
- provenance labels,
- steerability semantics,
- incident storage and audit,
- pseudonymization boundaries,
- backend cost recording,
- or Execution Contract behavior.

It also should not become the place where policy-sensitive prompt layers are
edited outside normal repo review.

Observability tools can quietly become authority layers if a project stops
treating them as mirrors. That is the failure mode to avoid here.

If Langfuse is added, it should stay optional shadow telemetry: useful, narrow,
and removable.

---

## Why Langfuse Fits The Narrow Use Case

Langfuse fits best as operator-side observability.

The strongest fit is not the user-facing trace page. Footnote already has that,
and it should remain Footnote-owned.

The stronger fit is the maintainer view across many runs. That may include:

- finding fallback-heavy runs,
- comparing `fast`, `balanced`, and `grounded` patterns,
- spotting expensive provider paths,
- gathering examples for evals,
- or checking whether a prompt or workflow change helped in practice.

Langfuse also has practical integration paths through JS/TS SDKs and API-based
instrumentation. That gives Footnote options.

The first pass should still avoid broad auto-instrumentation. Footnote already
has meaningful backend-owned metadata. A small explicit exporter is easier to
review, easier to test, and easier to remove.

Langfuse also has a self-hosting path, which is important for Footnote. But it
is not lightweight. It adds real infrastructure and operational cost. That
means Langfuse should not become part of Footnote's default self-hosted stack.
It should stay optional for operators who decide the extra visibility is worth
it.

---

## What Langfuse Should Not Own

Langfuse should not own Footnote's public product truth.

Footnote should keep ownership of:

- trace storage and retrieval,
- response metadata,
- workflow lineage,
- planner influence metadata,
- provenance labels,
- steerability semantics,
- incident and audit records,
- pseudonymization,
- privacy and retention decisions around export,
- backend cost recording,
- Execution Contract behavior,
- and policy-sensitive prompt layers.

Some of that metadata may later be mirrored to Langfuse. But mirroring is not
ownership.

If a user asks what happened for one answer, Footnote should answer from
Footnote data.

If a maintainer wants to compare many runs, Langfuse may help.

That split is the proposal.

---

## Privacy Default

The default export should be conservative.

LLM traces can contain sensitive user text, assistant output, tool results,
prompt details, provider responses, local paths, secrets, and internal
metadata. Exporting all of that by default to an optional observability system
would be a poor fit for Footnote's privacy posture.

The first version should export metadata only.

That likely means things like:

- Footnote `responseId`,
- workflow mode,
- workflow step kinds and termination reason,
- planner status if available,
- evaluator/tool status if available,
- provider and model,
- duration,
- token usage,
- backend-recorded cost,
- and redacted tags useful for debugging.

The first version should not export:

- raw user messages,
- raw assistant messages,
- full prompts,
- raw planner payloads,
- raw provider responses,
- incident details,
- trace API tokens or service secrets,
- local filesystem paths,
- or unbounded tool outputs.

If content export is added later, it should be an explicit opt-in with an
unambiguous config flag. The default should remain `false`.

That is not paranoia. It is basic hygiene.

---

## How We Should Try It

The first step should be documentation, not code.

We should add a short architecture or proposal note that states the stance
clearly:

- Langfuse is optional shadow telemetry.
- Footnote remains the source of truth.
- Export is metadata-only by default.
- Langfuse is disabled by default.
- Export failures fail open.
- Raw content export is opt-in.
- Prompt management is not part of the first pass.
- Incidents, provenance, workflow authority, and cost stay Footnote-owned.

After that, add configuration without exporting anything yet. The config should
be deliberately boring: enabled flag, base URL, public/secret keys, content
export flag, and maybe an environment or sampling guard if needed.

Only then should we add a small shadow exporter.

That exporter should run after Footnote has already assembled the metadata it
would own anyway. It should mirror a minimal safe payload to Langfuse when
enabled. If Langfuse is down, slow, unreachable, misconfigured, or throws SDK
errors, Footnote should continue normally.

The integration should sit behind a small internal interface. Langfuse SDK
calls should not spread through handlers and services.

If the experiment proves useful, we can ask practical maintainer questions:

- Can we find fallback-heavy runs more easily?
- Can we compare workflow modes in a useful way?
- Can we inspect cost patterns without inventing a second cost authority?
- Can we collect better eval examples?
- Does this materially help maintainers?

If not, the feature should stay experimental or be removed. The integration
should earn its keep.

---

## Evaluation Work Later

Langfuse evaluation workflows may be useful after shadow observability proves
itself.

That could mean selected runs being copied into datasets, experiments, or score
tracking for prompt/model changes.

The important boundary is that eval results remain advisory unless Footnote
explicitly decides otherwise later.

A Langfuse score should not silently become policy.

If eval results ever influence production behavior, that should be a separate
proposal and a separate authority decision.

---

## Prompt Experiments Later

Langfuse prompt management is also a later possibility, not a first step.

Footnote's prompts are not just strings. Some prompt layers carry policy,
review posture, provenance expectations, and product meaning. Moving those
layers into an external prompt UI too early would blur review and deployment
boundaries.

If prompt management is tested later, start with non-governance prompt segments.

Keep policy, safety, provenance, and review-sensitive prompt layers in-repo
unless a later proposal explicitly changes that boundary.

---

## What Would Make This A Bad Idea

This integration is not automatically worth it just because Langfuse is useful.

It becomes a bad idea if:

- the infrastructure cost is too high for the value returned,
- maintainers do not actually use it,
- raw content starts leaking by default,
- Langfuse labels start replacing Footnote's provenance language,
- SDK details spread through backend code,
- prompt management sneaks in before the boundary is clear,
- or self-hosting Footnote starts feeling incomplete without a separate
  observability stack.

Those are not reasons to reject the experiment now. They are the conditions to
watch closely if the experiment begins.

---

## What This Proposal Does And Does Not Say

### This proposal does say

This proposal says Langfuse is worth exploring as optional maintainer/operator
tooling.

It may help with cross-run observability, debugging, evaluation collection, and
operational visibility.

It should start as a metadata-only mirror of Footnote-owned execution data.

It should be disabled by default and fail open.

### This proposal does not say

It does not say Langfuse should replace Footnote traces.

It does not say Langfuse should own provenance.

It does not say Langfuse should own incidents or audit records.

It does not say Langfuse should own cost accounting.

It does not say prompt management should move to Langfuse.

It does not say Langfuse should become part of Footnote's default self-hosted
stack.

It does not say user content should be exported by default.

Those would be different decisions.

---

## Proposed Direction

Footnote should try Langfuse as optional shadow observability.

The first implementation should be narrow:

- config first,
- metadata-only export,
- disabled by default,
- fail-open,
- no raw content by default,
- no prompt management,
- no incident replacement,
- no provenance replacement,
- no cost authority replacement.

If that proves useful, the integration can later grow into evaluation support
and carefully scoped prompt experiments.

The point is to get maintainer/operator benefits without letting an
observability tool become Footnote's source of truth.

---

## References And Notes

- Footnote Workflow Engine And Provenance:
  `docs/architecture/workflow-engine-and-provenance.md`
- Footnote Workflow Mode Routing:
  `docs/architecture/workflow-mode-routing.md`
- Footnote Execution Contract Authority Map:
  `docs/architecture/execution-contract-authority-map.md`
- Footnote Response Metadata:
  `docs/architecture/response-metadata.md`
- Footnote Incident Storage And Audit:
  `docs/architecture/incident-storage-and-audit.md`
- Footnote Prompt Resolution:
  `docs/architecture/prompt-resolution.md`
- VoltAgent Runtime Adoption:
  `docs/decisions/2026-03-voltagent-runtime-adoption.md`
- Langfuse GitHub:
  [https://github.com/langfuse/langfuse](https://github.com/langfuse/langfuse)
- Langfuse docs:
  [https://langfuse.com/docs](https://langfuse.com/docs)
- Langfuse observability overview:
  [https://langfuse.com/docs/observability/overview](https://langfuse.com/docs/observability/overview)
- Langfuse prompt management overview:
  [https://langfuse.com/docs/prompt-management/overview](https://langfuse.com/docs/prompt-management/overview)
- Langfuse evaluation overview:
  [https://langfuse.com/docs/evaluation/overview](https://langfuse.com/docs/evaluation/overview)
- Langfuse OpenTelemetry integration:
  [https://langfuse.com/integrations/native/opentelemetry](https://langfuse.com/integrations/native/opentelemetry)
- Langfuse self-hosting:
  [https://langfuse.com/self-hosting](https://langfuse.com/self-hosting)
- Langfuse license:
  [https://github.com/langfuse/langfuse/blob/main/LICENSE](https://github.com/langfuse/langfuse/blob/main/LICENSE)

---

_Prepared for maintainer discussion and later implementation planning within
Footnote._
