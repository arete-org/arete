# Risk Evaluation And Breakers

## Purpose

Define the deterministic safety layer that evaluates requests and decides whether a response may proceed.

This document is about the target architecture, not the current implementation state.

## Design Goal

Ethics-core is the final authority for breaker decisions.

Planner output may provide hints, but planner output must not be the sole safety control.

## Evaluation Contract

The intended evaluation contract is:

```ts
type BreakerAction =
    | 'allow'
    | 'block'
    | 'redirect'
    | 'safe_partial'
    | 'human_review';

type SafetyEvaluationResult = {
    safetyTier: 'Low' | 'Medium' | 'High';
    action: BreakerAction;
    ruleId: string | null;
    notes: string[];
};
```

The evaluator input should include:

- latest user request,
- relevant recent context,
- attachment or modality hints,
- provenance or retrieval hints when available,
- optional planner suspicion hints.

## Rule Model

Breaker rules should be deterministic and testable.

Starter rule families:

- self-harm or crisis escalation,
- medical and legal high-risk guidance,
- dangerous or weaponization guidance,
- privacy or identity misuse,
- explicit policy refusal categories.

Each rule should produce:

- one stable `ruleId`,
- one action,
- one documented rationale.

## Planner Relationship

The planner may:

- suggest a higher risk tier,
- provide context that a rule may use,
- help shape a safer allowed response.

The planner may not:

- bypass a breaker trip,
- downgrade a deterministic refusal rule,
- become the only source of risk classification.

## Enforcement Point

The breaker decision should run after the request context is assembled and before the final response is emitted.

High-level pipeline:

1. build evaluation input,
2. run deterministic ethics-core evaluation,
3. apply breaker action,
4. record any provenance or audit metadata,
5. send the resulting response or refusal.

## Fail-Open Policy

The default system posture is fail open.

That means operational uncertainty should degrade gracefully rather than block unrelated use.

The exception is an explicit refusal rule. When a rule requires blocking, the system must refuse even if other components would have replied.

## Provenance And Audit Implications

When a breaker changes the final outcome, the system should preserve enough metadata to explain:

- that a breaker was involved,
- which `ruleId` fired,
- which action was applied.

This metadata should be compact and privacy-safe.

## Invariants

- Ethics-core is the final decider for breaker actions.
- Deterministic rules are testable without an LLM call.
- Planner hints are optional inputs, never sole authority.
- Explicit refusal rules override normal response generation.
- Breaker outcomes are auditable with stable `ruleId` values.

## Failure Modes

Realistic failures to design for:

- A breaker rule silently fails and the pipeline sends a normal answer.
- Planner output labels content `Low` risk and the pipeline trusts it over a deterministic rule.
- A refusal path returns an empty or malformed user-facing message.
- Breaker logs omit `ruleId`, making later review impossible.

## Validation Expectations

This layer should eventually be covered by:

- unit tests for each deterministic rule,
- integration tests for pipeline enforcement,
- provenance tests confirming breaker metadata is surfaced correctly,
- logging tests proving breaker events are privacy-safe and correlated.

The status document should track which parts are implemented today.
