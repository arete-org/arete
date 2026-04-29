# Safety Evaluation

This describes Footnote safety evaluation behavior today.
It explains how Footnote decides whether a request can proceed normally,
should be constrained, or should be refused.

Safety evaluation has to answer a few questions before the final response goes
out:

- should the request proceed?
- if not, what action should apply?
- which rule explains that decision?
- what should metadata and logs show afterward?

Keep the layers separate:

1. Safety evaluation classifies the request.
2. Backend orchestration decides how to apply that result.
3. Metadata and logs explain what happened afterward.

Most safety bugs start when one layer quietly starts doing another layer's
job.

## Authority

`ethics-core` is the final authority for safety rule decisions.

Planner output may help with context or safer wording, but planner is not the
safety authority. It may not bypass a deterministic refusal rule, downgrade a
rule match, or become the only source of safety classification.

The backend is the only place that applies the evaluator result. Web and
Discord consume backend output. They do not re-implement policy logic.

## Runtime shape today

The current evaluator lives in:

```text
packages/backend/src/ethics-core/evaluators.ts
```

Shared contracts live in:

```text
packages/contracts/src/ethics-core/
```

Backend orchestration builds the evaluator input in:

```text
packages/backend/src/services/chatOrchestrator.ts
```

That path calls the deterministic evaluator, reduces the result into a
smaller safety decision, and records the outcome in response metadata and
structured logs.

The backend remains the authority for applying the result. Clients render what
backend emits.

## Safety actions

The shared contract is designed for a small set of safety actions:

- `allow`
- `block`
- `redirect`
- `safe_partial`
- `human_review`

Today the implemented rule set uses a narrower subset of that shape, but the
shared contract keeps room for future growth without another contract rewrite.

## Evaluation input

The evaluator input is intentionally small.

Today it includes:

- the latest user input
- recent conversation turns in a serializable shape

The important current boundary is simple: rule matching is latest-turn scoped.

The conversation array is carried through so the interface can grow later, but
today the evaluator does not scan older turns for rule matching. That keeps
the behavior deterministic and easy to test.

## Rule model

Breaker rules should stay deterministic and testable without an LLM call.

Each rule should produce:

- one stable `ruleId`
- one action
- one documented rationale

The current evaluator uses local pattern matching over trimmed user input. If
more than one rule matches, precedence is fixed in code. Higher-safety rules
win over lower-safety rules. Within the same tier, explicit rule precedence
decides the winner.

The evaluator still records the full match set for tests and audit tooling, so
operators can see more than just the winning rule.

## Rule families

The intended architecture covers a few starter families:

- self-harm or crisis escalation
- dangerous or weaponization guidance
- medical and legal high-safety guidance
- privacy or identity misuse
- explicit policy refusal categories

Today the implemented rules are narrower. The current rule metadata covers:

- `safety.self_harm.crisis_intent.v1`
- `safety.weaponization_request.v1`
- `safety.professional.medical_or_legal_advice.v1`

The canonical rule metadata lives in:

```text
packages/contracts/src/ethics-core/safetyRuleMetadata.ts
```

That map is the source of truth for rule id, action, reason code, and safety
tier alignment.

## Safety tiers and results

The evaluator uses stable safety tiers:

- `Low`
- `Medium`
- `High`

The full evaluator result is richer than the smaller orchestration-facing
decision. That split is intentional.

- `SafetyEvaluationResult` is the full evaluator output used in tests and
  backend logic.
- `SafetyDecision` is the compact enforcement-facing view attached to metadata
  and execution events.

Keep that split. Orchestration does not need every evaluator field, but tests
and contracts do.

## Planner boundary

Planner can help shape the request context, suggest a higher caution posture,
or help produce a safer allowed response.

Planner may not:

- bypass a breaker trip
- downgrade a deterministic refusal rule
- become the only source of safety classification

Planner influence belongs in metadata and trace. Safety authority stays in the
deterministic evaluator and the backend-owned enforcement path.

## Enforcement point

Safety evaluation should run after request context is assembled and before the
final response is emitted.

The intended flow is:

1. Build the evaluation input.
2. Run deterministic safety evaluation.
3. Apply the selected action.
4. Record metadata and logs.
5. Emit the resulting response or refusal.

Today the evaluator result is surfaced in metadata and logs, but the runtime
still treats the path as `observe_only` rather than as a full hard-enforcement
gate for every action. That is an important current limitation.

## Fail-open behavior

The repo posture is fail open unless an explicit rule requires refusal.

That means operational problems should degrade gracefully instead of blocking
unrelated requests. The current evaluator follows that rule. If evaluation
throws, the fallback result is an allowed, low-tier decision with no matched
rule.

The exception is the rule layer itself. When a deterministic rule says the
request should be refused, that rule is the safety authority the system is
working toward enforcing directly in the response path.

## Metadata, logging, and auditability

When safety evaluation changes or explains the final outcome, Footnote should
keep enough metadata to explain:

- that safety evaluation was involved
- which `ruleId` fired
- which action was selected
- why that action was selected

That metadata should stay compact, privacy-safe, and serializable.

The evaluator outcome is carried in response metadata and can also appear in
execution timeline entries.

Breaker logging uses two main events:

- `chat.orchestration.breaker_signal`
- `chat.orchestration.breaker_action_applied`

Structured safety logs should include stable correlation fields for:

- `conversationId`
- `requestId`
- `incidentId`
- `responseId`

Keep log payloads JSON-serializable. Do not log raw prompts, unbounded
conversation copies, or privacy-sensitive blobs just because a rule matched.

## Current limits

The current implementation is intentionally narrow.

Today it does not:

- inspect attachments
- use surface or trigger metadata for rule matching
- scan older conversation turns for rule matching
- cover the full target rule family set
- act as a complete incident or review framework

Those limits keep the implementation small and predictable, but they also mean
the doc should not imply broader coverage than the code actually has.

## Failure modes

Real failures to design for:

- a rule fails silently and the pipeline sends a normal answer
- planner labels something low-risk and the runtime trusts that over a
  deterministic rule
- a refusal path returns an empty or malformed user-facing message
- logs omit `ruleId`, which makes later review much harder

## Validation expectations

This layer should stay covered by:

- unit tests for each deterministic rule
- integration tests for orchestration behavior
- metadata tests that confirm safety details are surfaced correctly
- logging tests that prove events are privacy-safe and correlated

## Canonical files

If you need the real implementation boundary, start here:

- [types.ts](../../packages/contracts/src/ethics-core/types.ts)
- [schemas.ts](../../packages/contracts/src/ethics-core/schemas.ts)
- [safetyRuleMetadata.ts](../../packages/contracts/src/ethics-core/safetyRuleMetadata.ts)
- [evaluators.ts](../../packages/backend/src/ethics-core/evaluators.ts)
- [chatOrchestrator.ts](../../packages/backend/src/services/chatOrchestrator.ts)

If those files disagree with older notes, the code is authoritative.
