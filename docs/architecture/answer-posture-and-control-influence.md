# Answer Posture And Control Influence

One Footnote response can include several metadata records side by side.

They answer different questions. One record explains how the backend routed
the request. Another explains the posture of the answer. Another records which
controls and planner decisions materially affected the run.

This page focuses on the metadata used to understand answer posture and
control influence:

- TRACE
- planner execution events
- control-influence records
- the provenance records around them

## The quick map

The main fields are:

| Question                                                             | Concept           | Main fields                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How did the backend choose to run this request?                      | Mode              | `metadata.workflowMode.*`                                                                                                                                              |
| What posture did the answer aim for, and what posture was delivered? | TRACE             | `metadata.trace_target`, `metadata.trace_final`, `metadata.trace_final_reason_code`, plus summary chips such as `metadata.evidenceScore` and `metadata.freshnessScore` |
| Did planner output affect the run?                                   | Planner metadata  | planner entries in `metadata.execution[]`                                                                                                                              |
| Which internal controls materially affected execution or output?     | Control influence | `metadata.steerabilityControls.controls[]`                                                                                                                             |
| What happened, and how was it classified?                            | Provenance        | `metadata.provenance`, `metadata.provenanceAssessment`, with supporting records in `metadata.execution`, `metadata.workflow`, and `metadata.trustGraph`                |

## Routing, posture, and influence

These concepts are related, but they are not the same thing.

Mode is routing metadata.

It explains how the backend chose to run the request: which path it took,
where that choice came from, and whether workflow-owned escalation happened.

TRACE is answer-posture metadata.

It explains how the answer was shaped, not how the request was routed. If
`workflowMode.modeId = grounded`, that does not automatically mean the answer
had supporting evidence. Check citations, provenance assessment, and execution
records for that.

Planner metadata and control-influence records are influence records.

They explain what the system considered and what materially affected the run.
They do not replace workflow routing, and they do not replace provenance.

## TRACE

TRACE is the posture of the answer.

It records:

- the target posture: `trace_target`
- the delivered posture: `trace_final`
- the reason for any gap: `trace_final_reason_code`

The important boundary is simple:

- mode explains routing
- TRACE explains answer posture

Do not merge those ideas together in UI copy or trace explanations.

The current runtime stops at target, final, and reason code. It does not yet
implement a full TRACE lifecycle or history model.

## TRACE boundaries

TRACE metadata is control-plane metadata.

It should be generated out of band from assistant prose. User style requests,
persona overlays, or speech-style transformations must not be able to corrupt
TRACE schema generation.

That means:

- TRACE is not parsed from assistant footer text
- persona overlays do not own TRACE meaning
- presentation changes do not become execution authority

## Control influence records

`steerabilityControls` records which backend controls materially affected a
run.

That field name comes from the current schema. In practice, this is the
current control-influence record for the trace.

It is not:

- a policy engine
- a user control surface
- a workflow scripting layer

Each control record stores:

- control id
- value
- source
- rationale
- `mattered`
- impacted targets

The current controls are:

- `workflow_mode`
- `evidence_strictness`
- `review_intensity`
- `provider_preference`
- `persona_tone_overlay`
- `tool_allowance`

## Control classes

The controls are not interchangeable.

Execution controls:

- `workflow_mode`
- `evidence_strictness`
- `review_intensity`
- `tool_allowance`

These can change execution behavior. They affect routing, review posture,
evidence posture, or tool eligibility.

Presentation control:

- `persona_tone_overlay`

This affects presentation only. It must not change execution-contract
authority, evidence strictness, or review authority.

Preference signal:

- `provider_preference`

This is advisory by default. Runtime may honor it, override it, or replace it
through fallback. It is not execution authority unless policy explicitly says
otherwise.

## Precedence and guardrails

Control conflicts are resolved by one shared backend resolver:
`steerabilityControlPrecedence`.

Current precedence is:

- `execution_policy` > `preference_signal`
- `execution_policy` > `presentation_only`
- `preference_signal` > `presentation_only`

Current class mapping is:

- `execution_policy`: `workflow_mode`, `evidence_strictness`,
  `review_intensity`, `tool_allowance`
- `preference_signal`: `provider_preference`
- `presentation_only`: `persona_tone_overlay`

Guardrails:

- `provider_preference` cannot escalate into execution-policy authority
- `persona_tone_overlay` cannot escalate into execution-policy authority
- tone and preference requests are represented as outcomes, not authority
  commands

## What `mattered` means

`mattered = true` means the control had an observed material effect on the run
or the delivered answer.

A control does not matter just because it appears in metadata or was
considered during routing. It matters when it changes execution, review
behavior, provider or profile selection, tool eligibility, or final answer
posture.

Examples:

- if no tool was requested, `tool_allowance` is usually visible but not
  material
- if runtime considers a requested provider and then overrides it,
  `provider_preference` may still matter because it changed the selection path
- if no overlay is applied, `persona_tone_overlay` does not matter

`mattered` records observed effect. It does not prove full or exclusive
causality.

## Current visible states

`review_intensity` should stay aligned with workflow routing logic. If routing
and metadata drift apart, traces stop matching runtime behavior.

Current mapping:

- `none`: review excluded or disabled
- `light`: one deliberation pass
- `moderate`: two or three passes
- `high`: four or more passes

For `provider_preference`, the trace should preserve visible state:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

For `persona_tone_overlay`, the trace should preserve presentation state:

- `presentation_applied`
- `presentation_not_applied`

## Planner events

Planner activity belongs in `metadata.execution[]` as an explicit
`kind: "planner"` event.

Planner events include:

- `purpose`
- `contractType`
- `applyOutcome`
- `mattered`
- `matteredControlIds`

In the current chat orchestrator path:

- `purpose = chat_orchestrator_action_selection`
- `contractType = structured | text_json | fallback`
- `applyOutcome = applied | adjusted_by_policy | not_applied`

These fields are narrower than they may first look.

`purpose` identifies the bounded planner role in the workflow.

`contractType` identifies the planner execution path. `fallback` means the
planner path ended in backend fail-open fallback semantics.

`applyOutcome` records how planner output relates to final execution:

- `applied`: planner output was used without material policy adjustment
- `adjusted_by_policy`: planner output was accepted as input but changed by
  policy, routing, or surface constraints before final execution
- `not_applied`: planner output did not become the execution path

`mattered` and `matteredControlIds` use the same semantics here: observed
downstream effect through controls in this run.

Keep these boundaries clear:

- `mattered` does not claim exclusive or complete causal proof
- `adjusted_by_policy` does not mean planner output was discarded
- `fallback` does not mean planner output was partially trusted

The current chat path assumes one planner invocation per response. Execution
ordering is planner-first in `metadata.execution[]`.

If workflows later support multiple planner invocations or retries, add
explicit correlation. Do not let planner metadata turn into orchestration
authority.

## Control observability event

Every control decision also writes one structured event:
`chat.steerability.control_observability`.

Think of this as a compact audit note for the run. It is backend-owned,
versioned as `v1`, and used in both message and non-message paths.

Required `input` fields:

- `surface`
- `workflowModeId`
- `executionContractResponseMode`
- `selectedProfileId`
- `personaOverlaySource`
- `toolRequest.toolName`
- `toolRequest.requested`
- `toolRequest.eligible`

Required `decision` fields:

- `plannerApplyOutcome`
- `plannerMatteredControlIds`
- `controls`

Required `outcome` fields:

- `responseAction`
- `responseModality`
- `plannerStatus`
- `mattered`

Why this stays strict:

- if any required field is missing, the envelope is invalid
- tests should fail for that path
- runtime still fails open; if emission is invalid, log it and continue

## Provenance and related records

TRACE and control-influence records do not replace provenance.

Provenance is still the classified record of what happened. The label and
assessment fields give the reviewer-facing summary. Supporting execution,
workflow, and TrustGraph records provide the structural detail around it.

If you have a trace payload open, a common reading pattern is:

- `workflowMode` tells you how the request was routed
- `trace_target` and `trace_final` tell you the answer posture
- the planner event shows whether planner output was applied or adjusted
- `steerabilityControls` shows which controls materially affected the run
- provenance fields tell you how the run was classified afterward

## Metadata types

Some metadata is structural and some is summary-oriented.

Structural metadata is the durable record of what the runtime did. That mainly
includes:

- `metadata.workflowMode.*`
- `metadata.workflow`
- `metadata.execution`
- `metadata.trustGraph`

Heuristic metadata is the runtime's summarized posture or assessment. That
includes:

- `metadata.trace_target`
- `metadata.trace_final`
- `metadata.evidenceScore`
- `metadata.freshnessScore`
- parts of `metadata.provenanceAssessment`

Some fields are transitional because implementation is still moving toward a
longer-term shape. Today that mainly means:

- planner metadata living alongside, rather than inside, first-class workflow
  lineage
- TRACE target and final fields without a full lifecycle model
- compatibility mirrors or summary fields kept during contract cleanup

## Stable rules

These rules should stay true:

- TRACE remains answer-posture metadata
- `workflowMode` remains routing metadata
- control-influence records observed material influence, not total causal
  proof
- planner influence does not become workflow or policy authority
- persona overlays and style instructions must not corrupt metadata generation
- tone and provider preference must stay bounded under execution-policy rules

## Related docs

- [Workflow](./workflow.md)
- [Prompt Resolution Order](./prompt-resolution.md)
