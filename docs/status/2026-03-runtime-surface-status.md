# Runtime Surface Status

## Last Updated

2026-03-27

## Owners

- `packages/backend`
- `packages/agent-runtime`
- `docs`

## Purpose

Current runtime status for active surfaces. This file is a short operational snapshot.

Canonical source of truth for capabilities: [2026-03-runtime-capability-matrix.md](./2026-03-runtime-capability-matrix.md).

Historical closeout snapshot: [archive/2026-03-voltagent-reflect-runtime-status.md](./archive/2026-03-voltagent-reflect-runtime-status.md).

## Current Runtime Reality

- `POST /api/chat` uses backend planner/orchestrator with VoltAgent generation runtime.
- OpenAI and Ollama are both supported for text generation when configured.
- Search tooling is profile + provider-gated. `web_search` forwarding is mapped for OpenAI only.
- Internal image, TTS, and realtime voice routes are OpenAI-only and return `503` when `OPENAI_API_KEY` is missing.
- Backend remains the authority for trace metadata and LLM cost recording.

## Known Gaps

- No final deterministic breaker enforcement gate is active yet.
- Provider tool registry is still narrow (`web_search` for OpenAI only).
- Workflow lineage metadata is not yet extended for multi-step execution.

## Next Gates

1. Land deterministic breaker enforcement.
2. Decide tool/provider expansion gates (or explicit no-expansion posture).
3. Add workflow lineage metadata when multi-step execution is enabled.
