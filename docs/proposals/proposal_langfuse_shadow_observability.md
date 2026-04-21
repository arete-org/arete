# Feature Proposal: Optional Langfuse Shadow Observability

**Last Updated:** 2026-04-21

---

## Overview

Footnote already records enough information to explain one response: the
selected mode, workflow lineage, planner influence, provenance, TRACE posture
(the answer posture metadata described in
`docs/architecture/response-metadata.md`), tool outcomes, and backend-recorded
cost.

That is the right foundation for a user-facing trace.

It does not give maintainers a great way to look across many runs.

That is the gap Langfuse might fill. It can help with cross-run inspection,
debugging, eval collection, cost patterns, and drift spotting. It should not
replace Footnote traces, own provenance semantics, move prompts out of review,
or become part of the default self-hosted stack.

The proposal is narrow: try Langfuse as optional shadow observability.

By default it should be off. If enabled, it should export metadata only. If it
fails, Footnote should keep running normally.

Langfuse can help maintainers inspect runs. Footnote still owns the run.

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

Langfuse already works in that space. The useful experiment is not "move
Footnote observability to Langfuse." The useful experiment is "mirror enough
safe metadata to see whether Langfuse helps maintainers."

---

## The Boundary

Footnote has its own meanings for execution, workflow, provenance, incidents,
pseudonymization, costs, and traces.

Those meanings stay in Footnote.

Langfuse uses similar words: traces, observations, scores, prompts, datasets,
evaluations. Those are Langfuse concepts. They can be useful without becoming
Footnote's product language.

A Langfuse trace is not a Footnote trace.

A Langfuse score is not a policy signal.

A Langfuse prompt version is not automatically a safe replacement for Footnote
prompt resolution.

Langfuse should not replace:

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

## Current Repo Fit

The repo already has a few seams that make this plausible.

Footnote has durable trace storage and public trace routes keyed around
`responseId`. It already records workflow and planner metadata. It already
treats backend cost recording as authoritative. It also has some optional
observability-related wiring around VoltAgent tracing.

That means Langfuse does not need to be pushed into request handling as a new
authority layer.

The clean fit is a backend-owned exporter that runs after Footnote has
assembled the metadata it already owns.

One important caveat: Footnote does not currently have a broad user consent
model. Incident records have incident-specific consent metadata, but that is
not the same thing as a general consent framework for observability export.
This proposal should not pretend that framework exists.

One more current-state caveat: planner metadata affects execution today, but
planner is not yet a first-class workflow step in workflow lineage.

---

## Privacy Default

The first version should export metadata only.

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

That is not a nice-to-have. It is the difference between observability and a
privacy foot-gun.

---

## How To Try It

Start with documentation and config, not runtime export.

The first implementation pass should add the configuration shape and the
redaction/export policy. That gives maintainers a place to review the boundary
before data starts moving.

A later pass can add the exporter. It should be small, backend-owned, and
isolated behind an internal interface. Langfuse SDK calls should not spread
through handlers and services.

When enabled, the exporter should run after Footnote has produced its own
response metadata. If Langfuse is down, slow, misconfigured, unreachable, or
throws SDK errors, Footnote should continue normally.

After that, test it against a local or development Langfuse instance and ask
boring practical questions:

- Does it make fallback-heavy runs easier to find?
- Does it help compare workflow modes?
- Does it make cost patterns easier to inspect?
- Does it help collect eval examples?
- Do maintainers actually use it?

If not, keep it experimental or remove it.

---

## What Comes Later

Langfuse eval workflows may be useful after shadow export proves itself.
Selected runs could become datasets, experiments, or scored examples.

Those scores should stay advisory unless Footnote explicitly decides otherwise.

Prompt management is also later. Footnote prompts are not just strings; some
carry policy, review posture, provenance expectations, and product meaning. If
Langfuse prompt management is tested, start with non-governance prompt
segments. Keep policy, safety, provenance, and review-sensitive prompt layers
in the repo unless a later proposal changes that boundary.

---

## When This Becomes A Bad Idea

This experiment should stop or stay parked if the value does not justify the
weight.

Warning signs:

- maintainers do not use it,
- the infra cost is too high,
- raw content starts exporting by default,
- Langfuse labels start replacing Footnote provenance language,
- SDK details leak across backend code,
- prompt management sneaks in before the boundary is clear,
- or self-hosting Footnote starts to feel incomplete without Langfuse.

The point is to learn whether the extra visibility is worth it. If it is not,
delete the integration. Do not let it become permanent just because it exists.

---

## What This Proposal Says

This proposal says Langfuse is worth trying as optional maintainer/operator
tooling.

It should start as a metadata-only mirror of Footnote-owned execution data.

It should be disabled by default, fail open, and remain removable.

It does not say Langfuse should replace Footnote traces, provenance, incidents,
cost accounting, prompt review, consent, or the default self-hosted stack.

Those would be separate decisions.

---

## Proposed Direction

Proceed with a narrow Langfuse experiment:

1. Document the stance.
2. Add config and export policy.
3. Add a small metadata-only shadow exporter.
4. Test against a local or development Langfuse instance.
5. Keep it only if it helps maintainers.

No raw content by default. No prompt management in the first pass. No
replacement of Footnote trace/provenance semantics.

---

## Longer-Term Direction

There is a larger idea behind this, but it should not be part of the first Langfuse integration.

In the future, Footnote may be able to adjust workflow execution based on evidence gathered outside the current request. That could include things like:

- eval results from previous runs,
- fallback patterns across providers,
- known weak prompt/model combinations,
- TrustGraph evidence about sources or claims,
- operator-reviewed examples,
- or aggregate quality signals from observability tools.

Used carefully, that could help Footnote choose a more appropriate workflow path. For example, it might route some requests toward a more careful review path, avoid a weak provider/model combination, require stronger grounding for certain source types, or flag a run for extra trace visibility.

That is not what the first Langfuse experiment should do.

The first Langfuse integration should observe. It should not steer.

Any future adaptive workflow behavior needs its own design decision, because it changes the authority model. The question would no longer be only “what happened?” It would become “what outside evidence is allowed to change what happens next?”

That boundary matters.

If external signals ever influence workflow execution, Footnote should keep a few rules:

- the Execution Contract still sets the allowed run rules;
- workflow still owns sequencing;
- external systems provide advisory signals, not hidden authority;
- any adjustment should be visible in trace/provenance;
- the reason for the adjustment should be recorded;
- stale or missing external signals should fail open or fall back predictably;
- user privacy and consent rules should apply before telemetry becomes control input;
- and no vendor tool should become the silent policy engine.

Langfuse might eventually help produce useful aggregate signals. TrustGraph might eventually provide source or evidence signals. Operator evals might eventually identify weak paths. But none of those should silently rewrite runtime behavior.

The safe path is:

1. observe runs;
2. evaluate patterns;
3. summarize findings;
4. let Footnote-owned policy decide whether those findings can affect workflow;
5. record any adjustment when it happens.

That keeps the door open without pretending the door is already safe to walk through.

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
