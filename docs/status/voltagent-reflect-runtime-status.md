# VoltAgent Reflect Runtime Status

## Last Updated

2026-03-17

## Purpose

Capture the completed Reflect runtime migration as a branch-level status snapshot.

This file is historical implementation context, not a primary AI quick-reference document. Durable guidance should come from `cursor.rules` and the VoltAgent decision record.

## Current State

Reflect now runs through the shared runtime seam behind backend:

- `web` calls `backend`
- `discord-bot` calls `backend`
- `backend` owns `POST /api/reflect`, auth, abuse controls, trace generation, response metadata, and API shaping
- `@footnote/agent-runtime` owns the replaceable generation runtime implementations

The active Reflect runtime is now VoltAgent for plain text generation. Search-enabled requests still use the legacy runtime path through the VoltAgent adapter's explicit fallback behavior so retrieval parity remains intact for this branch.

## Branch Outcome

The branch achieved the following:

- created `@footnote/agent-runtime` as a dedicated internal package
- established provider-neutral runtime types:
    - `RuntimeMessage`
    - `GenerationRequest`
    - `GenerationResult`
    - `GenerationRuntime`
    - `createGenerationRuntime()`
- moved the legacy OpenAI-backed generation behavior into a dedicated legacy runtime adapter
- added a VoltAgent-backed runtime adapter for stateless text generation
- cut backend Reflect over to the runtime seam
- kept planner behavior, prompt assembly, trace persistence, and response metadata in backend
- avoided any new public endpoint, service, or container

## What Remains True

- the reflect planner stays in `backend`
- prompt assembly stays in `backend`
- trace persistence and `ResponseMetadata` stay in `backend`
- legacy runtime behavior remains available internally for search fallback
- OpenAI-specific backend code is still used where it genuinely belongs today, especially planner execution

## Validation Snapshot

Validation for the completed branch includes:

- `packages/agent-runtime/test/index.test.ts`
- `packages/agent-runtime/test/legacyOpenAiRuntime.test.ts`
- `packages/agent-runtime/test/voltagentRuntime.test.ts`
- `packages/backend/test/reflectGenerationTypes.test.ts`
- `packages/backend/test/reflectPlanner.test.ts`
- `packages/backend/test/reflectService.test.ts`
- `packages/backend/test/reflectOrchestrator.test.ts`
- `packages/backend/test/reflectHandler.test.ts`
- `packages/backend/test/openaiService.metadata.test.ts`

Most recent validation run:

- `pnpm --filter @footnote/agent-runtime run build`
- `pnpm exec tsx --test packages/agent-runtime/test/index.test.ts packages/agent-runtime/test/legacyOpenAiRuntime.test.ts packages/agent-runtime/test/voltagentRuntime.test.ts`
- `pnpm --filter @footnote/backend run build`
- `pnpm exec tsx --test packages/backend/test/reflectGenerationTypes.test.ts packages/backend/test/reflectPlanner.test.ts packages/backend/test/reflectService.test.ts packages/backend/test/reflectOrchestrator.test.ts packages/backend/test/reflectHandler.test.ts packages/backend/test/openaiService.metadata.test.ts`
- `pnpm lint-check`
- `pnpm install --frozen-lockfile`

## Residual Limits

- VoltAgent is the active Reflect runtime, but search requests still fall back to the legacy runtime adapter
- this branch does not migrate voice or image generation
- this branch does not move planner logic into VoltAgent
- this branch does not replace Footnote-owned trace, incident, or provenance systems
