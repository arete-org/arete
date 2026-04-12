# Steerability Foundation (Internal Controls v1)

`steerabilityControls` records which backend controls materially affected a
run. The trace uses it to show what actually influenced execution. It is not a
policy engine, a user control surface, or a workflow scripting layer.

Each control record stores a control id, value, source, rationale,
`mattered`, and impacted targets.

The current controls are `workflow_mode`, `evidence_strictness`,
`review_intensity`, `provider_preference`, `persona_tone_overlay`, and
`tool_allowance`.

## Control Semantics

The shape is flat in v1, but the controls are not interchangeable.

Execution controls:

- `workflow_mode`
- `evidence_strictness`
- `review_intensity`
- `tool_allowance`

These change execution behavior. They affect routing, review behavior,
evidence posture, or tool eligibility.

Presentation control:

- `persona_tone_overlay`

This affects presentation only. It must not change execution-contract
authority, evidence strictness, or review authority.

Preference signal:

- `provider_preference`

This is advisory by default. Runtime may honor it, override it, or replace it
through fallback. Do not treat it as execution authority unless policy says so.

## Internal Precedence Matrix (Current Controls Only)

Steerability control conflicts for current internal controls are resolved by one
shared resolver in backend runtime code:
`steerabilityControlPrecedence`.

Current precedence:

- `execution_policy` > `preference_signal`
- `execution_policy` > `presentation_only`
- `preference_signal` > `presentation_only`

Current class mapping:

- `execution_policy`: `workflow_mode`, `evidence_strictness`,
  `review_intensity`, `tool_allowance`
- `preference_signal`: `provider_preference`
- `presentation_only`: `persona_tone_overlay`

Guardrails:

- `provider_preference` cannot escalate into execution-policy authority.
- `persona_tone_overlay` cannot escalate into execution-policy authority.
- Tone/presentation and preference requests are represented as outcomes, not
  authority commands.

`mattered = true` means the control had an observed material effect on the run
or the delivered answer.

A control does not matter just because it appears in metadata or was
considered during routing. It matters when it changes execution, review
behavior, provider or profile selection, tool eligibility, or final answer
posture.

Examples:

- If no tool was requested, `tool_allowance` is usually visible but not
  material.
- If runtime considers a requested provider and then overrides it,
  `provider_preference` may still matter because it changed the selection path.
- If no overlay is applied, `persona_tone_overlay` does not matter.

`mattered` records observed effect. It does not prove full or exclusive
causality.

`review_intensity` comes from the same workflow behavior logic used for runtime
routing in `workflowProfileRegistry`. If routing and metadata drift apart,
traces stop matching runtime behavior.

Current mapping:

- `none`: review excluded or disabled
- `light`: one deliberation pass
- `moderate`: two or three passes
- `high`: four or more passes

For `provider_preference`, the trace should preserve the visible state:

- `requested_honored`
- `requested_overridden`
- `advisory_honored`
- `advisory_overridden`
- `fallback_resolved`

For `persona_tone_overlay`, the trace should preserve explicit presentation
state:

- `presentation_applied`
- `presentation_not_applied`

## Planner Events

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

These fields are narrower than they may first look:

- `mattered` does not claim exclusive or complete causal proof
- `adjusted_by_policy` does not mean planner output was discarded
- `fallback` does not mean planner output was partially trusted

The current chat orchestrator assumes one planner invocation per response path.
Execution ordering is planner-first in `metadata.execution[]`.

If workflows later support multiple planner invocations or retries, add
explicit correlation. Do not let planner metadata turn into orchestration
authority.

## Control Observability Envelope

Every control decision also writes one structured event:
`chat.steerability.control_observability`.

Think of this as a compact audit note for each run. It is backend-owned,
versioned (`v1`), and used in both message and non-message paths.

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

Why this is strict:

- If any required field is missing, that envelope is invalid.
- Tests should fail for that path.
- Runtime still fails open. If emission is invalid, we log it and continue
  response execution.

Canonical planner event:

```json
{
    "kind": "planner",
    "status": "executed",
    "purpose": "chat_orchestrator_action_selection",
    "contractType": "text_json",
    "applyOutcome": "applied",
    "mattered": true,
    "matteredControlIds": ["tool_allowance"],
    "profileId": "openai-text-fast",
    "provider": "openai",
    "model": "gpt-5-nano",
    "durationMs": 17
}
```

Policy-adjusted example:

```json
{
    "execution": [
        {
            "kind": "planner",
            "status": "executed",
            "purpose": "chat_orchestrator_action_selection",
            "contractType": "text_json",
            "applyOutcome": "adjusted_by_policy",
            "mattered": true,
            "matteredControlIds": ["tool_allowance"],
            "profileId": "openai-text-fast"
        },
        {
            "kind": "tool",
            "status": "executed",
            "toolName": "web_search",
            "reasonCode": "search_rerouted_to_fallback_profile"
        },
        {
            "kind": "generation",
            "status": "executed",
            "profileId": "openai-text-medium"
        }
    ],
    "steerabilityControls": {
        "version": "v1",
        "controls": [
            {
                "controlId": "tool_allowance",
                "source": "planner_output",
                "mattered": true
            },
            {
                "controlId": "provider_preference",
                "source": "planner_output",
                "mattered": false
            }
        ]
    }
}
```

## Future Constraints

A few expansion points are already visible, and they need to stay bounded.

- If planner adjustments split into materially different classes, add detail
  alongside `applyOutcome`. Do not overload the top-level enum.
- If multiple planner passes or retries are introduced, add explicit
  correlation while keeping planner ownership bounded by workflow logic.
- If runtime can revise TRACE posture during review, keep target TRACE and
  final TRACE separate. `workflowMode` remains routing metadata. TRACE remains
  answer-posture metadata.

The trace should show what the runtime actually did, in a form contributors
can follow.
