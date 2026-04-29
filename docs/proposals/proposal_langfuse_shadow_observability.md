# Feature Proposal: Optional Langfuse Shadow Observability

**Last Updated:** 2026-04-21

---

## Overview

We should try Langfuse as optional shadow observability for Footnote.

Footnote already records enough information to explain one response: the
selected mode, workflow lineage, planner influence, provenance, TRACE posture
(the answer posture metadata described in
`docs/architecture/response-metadata.md`), tool outcomes, and backend-recorded
cost. That works well for a user-facing trace.

It does not give maintainers a great view across many runs.

Langfuse may help there. It can help maintainers inspect patterns, debug
failures, collect eval examples, compare cost patterns, and notice drift. It
should not replace Footnote traces, decide what provenance means, move prompts
out of review, or become part of the default self-hosted stack.

The first version should be boring: off by default, metadata-only, and
fail-open.

---

## Why This Is Worth Trying

Footnote's trace and metadata work answers a local question:

> What happened for this response?

That matters. It is part of the product.

But maintainers also need a broader view sometimes:

- where fallback happens,
- which workflow modes are common,
- which model routes are expensive,
- whether a prompt change helped,
- which runs should become eval examples,
- and whether a regression only shows up across many responses.

Footnote could build more of that itself, and some of it may eventually belong
in the product. But a full observability and evaluation surface is not the core
product right now.

Langfuse already works in that space. We do not need to move Footnote
observability into Langfuse. We should mirror enough safe metadata to find out
whether Langfuse is actually useful to maintainers.

---

## The Boundary

Footnote already has its own model for execution, workflow, provenance,
incidents, pseudonymization, cost, and traces. That stays in Footnote.

Langfuse uses similar words: traces, observations, scores, prompts, datasets,
evaluations. Those terms can be useful without becoming Footnote's language.

A Langfuse trace is not a Footnote trace.

A Langfuse score is not a policy signal.

A Langfuse prompt version is not automatically a safe replacement for Footnote
prompt resolution.

Langfuse can receive a mirrored view of some metadata. It should not replace:

- public trace retrieval,
- response metadata,
- workflow lineage,
- provenance labels,
- incident and audit records,
- pseudonymization boundaries,
- backend cost recording,
- Execution Contract behavior,
- or policy-sensitive prompt layers.

Some metadata can be mirrored. Mirroring is not ownership.

---

## How This Fits The Repo

The clean fit is a backend-owned exporter that runs after Footnote has already
assembled response metadata.

That matters. Langfuse should not sit inside request routing, planner
decisions, workflow policy, or response generation. It should receive a
mirrored view after Footnote has done its own work.

A few current repo details shape the first pass:

- `responseId` is the durable public trace key.
- Backend cost recording is already authoritative.
- Planner metadata can appear in workflow metadata as a `plan` step when
  available, but planner timing still lives before workflow execution in the
  main chat path.

One important caveat: Footnote does not currently have a broad user consent
model. Incident records have incident-specific consent metadata, but that is
not the same thing as a general consent framework for observability export. Do
not pretend that framework exists.

---

## Privacy Default

Start conservative.

The first version should send metadata, not content.

That can include things like:

- `responseId`,
- workflow mode,
- workflow step kinds,
- termination reason,
- planner status,
- evaluator or tool status,
- provider and model,
- duration,
- token usage,
- backend-recorded cost,
- and redacted debugging tags.

It should not export raw user messages, assistant messages, full prompts, raw
planner payloads, provider responses, incident details, trace tokens, secrets,
local paths, or unbounded tool output.

If content export is added later, it should be an explicit opt-in. The default
should remain off.

This is not a nice-to-have. It is the difference between observability and a
privacy foot-gun.

---

## How To Try It

Start with config and export policy.

The first implementation pass should define the configuration shape and the
redaction rules. That gives maintainers something concrete to review before
data starts moving.

The exporter can come after that. It should be small, backend-owned, and
isolated behind an internal interface. Langfuse SDK calls should not spread
through handlers and services.

When enabled, the exporter should run after Footnote has produced its own
response metadata. If Langfuse is down, slow, misconfigured, unreachable, or
throws SDK errors, Footnote should continue normally.

Then test it against a local or development Langfuse instance:

- Can we find fallback-heavy runs more easily?
- Can we compare workflow modes?
- Can we inspect cost patterns?
- Can we collect useful eval examples?
- Do maintainers actually use it?

If not, keep it experimental or remove it.

---

## Later Work

Eval workflows may be useful after shadow export proves itself. Selected runs
could become datasets, experiments, or scored examples. Those scores should
stay advisory unless Footnote explicitly decides otherwise.

Prompt management is also later. Footnote prompts are not just strings. Some
carry policy, review posture, provenance expectations, and product meaning. If
Langfuse prompt management gets tested, start with non-governance prompt
segments. Keep policy, safety, provenance, and review-sensitive prompt layers
in the repo unless a later proposal changes that line.

Adaptive workflow behavior is later still.

Langfuse may eventually provide aggregate signals that help Footnote tune
workflow behavior. TrustGraph may provide source or evidence signals. Operator
evals may identify weak paths.

Those signals should not directly steer live execution. If outside evidence
ever affects workflow behavior, it needs to pass through Footnote-owned policy
and show up in trace/provenance.

For now, keep the rule simple: Langfuse observes. Footnote decides.

---

## Proposed Direction

Proceed with a narrow Langfuse experiment:

1. Add config and export policy.
2. Add a small metadata-only shadow exporter.
3. Test against a local or development Langfuse instance.
4. Keep it only if it helps maintainers.

No raw content by default. No prompt management in the first pass. No
replacement of Footnote trace/provenance semantics.

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
- Footnote Incident Handling:
  `docs/architecture/incident-handling.md`
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
