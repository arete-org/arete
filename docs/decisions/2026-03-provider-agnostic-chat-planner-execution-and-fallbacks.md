# Decision: Provider-Agnostic Planner Execution and Safe Fallbacks

Date: 2026-03-28

This decision sets the long-term shape for chat planner execution now that planner output is structured and normalized. The short version is that planner policy belongs to backend core code, while provider integrations stay thin. OpenAI is one provider, not the planner architecture. We still keep provider adapters because each provider has different wire formats and tool-calling details, but those adapters should only do transport work and return raw planner output for backend-owned normalization.

Before this decision, planner behavior could drift across execution paths because transport concerns and policy concerns were easy to mix. That made it harder to reason about failures and harder to add new providers without re-implementing planner rules in multiple places. We are standardizing around one provider-agnostic normalization path so every provider gets the same validation behavior, the same correction behavior, and the same fallback semantics.

We are also clarifying what fallback means. We do not want planner glitches to create broad user-facing refusals. A safe default plan should be conservative, but it should still preserve fail-open behavior for normal, low-risk requests. In practice, the safe default plan keeps capabilities narrow (for example, no extra tools), keeps generation low-variance, and lets deterministic safety breakers remain the only hard-stop path for high-risk content.

The fallback model is now tiered. If planner output cannot be parsed at all, we use a full `safe_default_plan`. If planner output parses but has invalid fields, we prefer field-level correction and continue with the parts that are valid. If output is valid JSON but violates capability or policy constraints, we coerce or drop only the violating parts. This gives us granular control and reduces unnecessary full-plan fallback.

To make this observable, normalization emits explicit fallback metadata and correction metadata instead of relying on implicit signals. We now track fallback tier and correction codes so we can tell the difference between complete planner failure and partial correction. This keeps incident investigation straightforward and lets us improve prompts and schemas with concrete evidence.

We are also carrying the same idea into search planning details. For example, `topicHints` are bounded and advisory. Invalid hints are dropped without blocking execution. Legacy-style hints continue to work during transition, but we normalize them into one backend-owned shape so behavior is consistent regardless of provider path.

This decision is intentionally junior-friendly in implementation scope. If you work on planner code, ask one question first: "Is this provider transport, or is this planner policy?" If it is transport, keep it in the adapter. If it is policy, keep it in backend normalization and orchestration. That separation is the core of this decision.
