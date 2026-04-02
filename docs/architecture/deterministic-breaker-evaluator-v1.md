# Deterministic Safety Evaluator V1

The system is intentionally narrow. It gives Footnote one deterministic safety pass in `ethics-core`, one shared contract in `packages/contracts`, and one backend-owned orchestration handoff. It does not try to be a complete safety framework.

## Current Shape

The evaluator lives in `packages/backend/src/ethics-core/evaluators.ts`. Shared contracts live in `packages/contracts/src/ethics-core`. Backend orchestration calls the evaluator from `packages/backend/src/services/chatOrchestrator.ts`, converts the evaluator result into a `SafetyDecision`, and records that decision in response metadata and structured logs.

The evaluator is deterministic. The contracts are serializable. The backend is the only place that applies the result. Web and Discord consume backend output and do not re-implement policy logic.

## Naming And Contracts

`SafetyTier` and `SafetyRuleId` describe the stable classification vocabulary. `SafetyAction`, `SafetyReasonCode`, `SafetyEvaluationInput`, `SafetyEvaluationResult`, and `SafetyDecision` describe the evaluator and enforcement side.

The main types live in [types.ts](../../packages/contracts/src/ethics-core/types.ts). Runtime validation lives in [schemas.ts](../../packages/contracts/src/ethics-core/schemas.ts). Canonical rule tuples live in [safetyRuleMetadata.ts](../../packages/contracts/src/ethics-core/safetyRuleMetadata.ts).

## Input

The evaluator input is intentionally small:

```ts
export type SafetyEvaluationInput = {
    latestUserInput: string;
    conversation: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
    }>;
};
```

Today, only `latestUserInput` is used for rule matching. The conversation array is carried through so the interface can grow without another shape change, but the evaluator currently ignores prior turns for rule matching. That was a deliberate decision during implementation. We wanted deterministic behavior tied to the latest user turn, not ambiguous scanning across mixed-role history.

There is an explicit TODO in the code to expand this later once conversation lifecycle and summarization contracts are more settled. For now, callers should assume the evaluator is latest-turn scoped.

## Evaluation Model

The evaluator is pure local logic. There are no network calls, no clock reads, and no random branches. The rule set is small and explicit:

- `safety.self_harm.crisis_intent.v1`
- `safety.weaponization_request.v1`
- `safety.professional.medical_or_legal_advice.v1`

The matcher uses regex-based pattern checks over the trimmed latest user input. If more than one rule matches, precedence is fixed in code. High-safety rules win over medium-safety rules. Within a tier, explicit rule precedence decides the winner. The evaluator still returns `matchedRuleIds` so tests and audit tooling can see the full match set, not just the winning rule.

If evaluation throws, the path fails open to:

```ts
{
    action: 'allow',
    safetyTier: 'Low',
    ruleId: null,
    matchedRuleIds: [],
}
```

That fail-open behavior matches broader repo policy.

## Result And Decision Shapes

The evaluator returns `SafetyEvaluationResult`, which is a discriminated union. `allow` results carry no reason payload. Non-allow results require `ruleId`, `reasonCode`, and `reason`.

That result is then reduced into a smaller `SafetyDecision` for orchestration and metadata. The reduction step exists because orchestration mostly needs the final action and explanation, not every evaluator field.

This is the current split:

- `SafetyEvaluationResult` is the full evaluator output used in tests and backend logic.
- `SafetyDecision` is the compact enforcement-facing view attached to metadata and execution events.

The schemas enforce that non-allow decisions match the canonical tuple in `SAFETY_RULE_METADATA`. In other words, a rule ID cannot drift away from its expected action, reason code, or `SafetyTier` without validation failing.

## Rule Metadata

Rule metadata is centralized in one map:

```ts
export const SAFETY_RULE_METADATA: Readonly<
    Record<SafetyRuleId, SafetyRuleMetadata>
>;
```

That map currently defines:

- self-harm crisis intent -> `block` / `High` / `self_harm_crisis_intent`
- weaponization request -> `block` / `High` / `weaponization_request`
- professional medical or legal advice -> `safe_partial` / `Medium` / `professional_advice_guardrail`

Both the evaluator and the schemas use this as the source of truth. That keeps rule IDs, actions, reason codes, and `SafetyTier` values aligned.

## Backend Handoff

The backend remains the authority for applying evaluator output. `chatOrchestrator` builds a `SafetyEvaluationInput` from the normalized request, calls `evaluateSafetyDeterministic`, converts the result with `buildSafetyDecision`, and stores the outcome in execution metadata.

The evaluator currently runs in `observe_only` mode. The result is surfaced in logs and metadata, and the orchestrator can branch on it internally, but telemetry still treats the path as observe-only rather than as a hard enforcement boundary.

The important boundary is unchanged: backend owns the safety decision path, and clients render what backend emits.

## Metadata And Auditability

The evaluator output is present in `EvaluatorOutcome`, which includes:

- `mode`
- `provenance`
- `safetyDecision`

That outcome is stored in `ResponseMetadata.evaluator` and can also appear in `execution[]` timeline entries. This gives operators and UI surfaces enough information to show what fired, what action was selected, and why.

Execution formatting in `packages/contracts/src/ethics-core/executionFormatting.ts` now assumes the canonical evaluator shape. The old formatter fallback for legacy evaluator payloads was removed as part of the strict-contract cleanup, so malformed legacy-style payloads no longer get interpreted as if they were valid current data.

## Current Limits

This V1 path is intentionally conservative. It does not inspect attachments. It does not use trigger or surface metadata. It does not scan older conversation turns for safety rules. It does not redesign incident or review workflows. It also does not attempt broad policy coverage beyond the three baseline rule families above.

These limits keep the implementation small and predictable.

## What To Treat As Canonical

If you need to understand or extend this system, start from these files:

- [packages/contracts/src/ethics-core/types.ts](../../packages/contracts/src/ethics-core/types.ts)
- [packages/contracts/src/ethics-core/schemas.ts](../../packages/contracts/src/ethics-core/schemas.ts)
- [packages/contracts/src/ethics-core/safetyRuleMetadata.ts](../../packages/contracts/src/ethics-core/safetyRuleMetadata.ts)
- [packages/backend/src/ethics-core/evaluators.ts](../../packages/backend/src/ethics-core/evaluators.ts)
- [packages/backend/src/services/chatOrchestrator.ts](../../packages/backend/src/services/chatOrchestrator.ts)

If those files disagree with older notes, the code is authoritative.
