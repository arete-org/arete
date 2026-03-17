# VoltAgent Reflect Runtime Status

## Last Updated

2026-03-17

## Purpose

Track the branch work that introduces a replaceable generation/runtime boundary for Reflect before VoltAgent is wired in as a real implementation.

This file should reflect the branch's actual state. Architecture and decision docs should stay more stable.

## Current State

Footnote still has one stable public reflect boundary:

- `web` calls `backend`
- `discord-bot` calls `backend`
- `backend` owns `POST /api/reflect`, auth, abuse controls, trace generation, and response metadata

The branch now has a new internal runtime package at `packages/agent-runtime`, but backend Reflect still executes generation through the existing backend OpenAI path. No public API, endpoint, or container boundary has changed.

### What is already done

- `@footnote/agent-runtime` exists as a workspace package
- the runtime seam has been generalized away from Reflect-specific naming
- the package now exports canonical runtime-facing generation types:
    - `RuntimeMessage`
    - `GenerationRequest`
    - `GenerationResult`
    - `GenerationRuntime`
    - `createGenerationRuntime()`
- runtime-facing generation settings now live in `@footnote/agent-runtime`
- backend Reflect code imports and uses the canonical runtime-facing vocabulary instead of maintaining a duplicate local shape
- backend generation settings now use runtime-neutral search semantics:
    - `search`
    - `contextSize`
    - `intent`
    - `maxOutputTokens`
- the runtime result contract now includes normalized usage, retrieval, citations, and provenance facts
- `agent-runtime` currently exposes a placeholder factory only; no adapter construction exists yet

### What remains true today

- the reflect planner stays in `backend`
- prompt assembly stays in `backend`
- trace persistence and `ResponseMetadata` stay in `backend`
- the real generation call still happens in `packages/backend/src/services/openaiService.ts`
- backend does not yet call `createGenerationRuntime()` or a runtime adapter
- VoltAgent is not yet installed or wired into the runtime package

## Validation Baseline

Current validation now covers both the existing Reflect path and the new internal seam.

Already in place:

- `packages/agent-runtime/test/index.test.ts`
- `packages/backend/test/reflectGenerationTypes.test.ts`
- `packages/backend/test/reflectHandler.test.ts`
- `packages/backend/test/reflectOrchestrator.test.ts`
- `packages/backend/test/reflectPlanner.test.ts`
- `packages/backend/test/reflectService.test.ts`
- `packages/backend/test/openaiService.metadata.test.ts`

Most recent validation run:

- `pnpm --filter @footnote/agent-runtime run build`
- `pnpm --filter @footnote/backend run build`
- `pnpm exec tsx --test packages/agent-runtime/test/index.test.ts packages/backend/test/reflectGenerationTypes.test.ts packages/backend/test/reflectPlanner.test.ts packages/backend/test/reflectService.test.ts packages/backend/test/reflectOrchestrator.test.ts packages/backend/test/reflectHandler.test.ts`
- `pnpm lint-check`

Still missing:

- runtime-adapter conformance tests
- backend tests that prove `/api/reflect` still behaves the same after backend starts calling the runtime seam
- VoltAgent adapter tests
- end-to-end tests covering runtime-produced metadata facts flowing into backend trace storage

## Next Work

### 1. Make the seam real in backend execution

Backend Reflect should call the runtime seam for text generation instead of calling the OpenAI wrapper directly.

Expected outcome:

- `/api/reflect` behavior stays unchanged
- backend still owns planner behavior, metadata, traces, and API shape
- the new seam stops being placeholder-only

### 2. Add a legacy runtime adapter

Implement a backend-compatible adapter in `@footnote/agent-runtime` that preserves the current OpenAI-backed generation behavior behind the new seam.

Expected outcome:

- backend can depend on `GenerationRuntime`
- the legacy path remains the execution backend for now
- the cutover is architectural, not behavioral

### 3. Introduce VoltAgent as another runtime implementation

Once backend is using the seam, add a text-only VoltAgent adapter in `@footnote/agent-runtime`.

Expected outcome:

- VoltAgent dependencies live only in the runtime package
- backend contracts remain unchanged
- planner, traces, incidents, and response metadata remain backend-owned

### 4. Cut Reflect over and clean up

Switch backend Reflect generation to the VoltAgent adapter and remove dead direct-generation code that is no longer needed.

Expected outcome:

- web and Discord continue using the same backend reflect API
- no additional service or container is required
- remaining OpenAI code is limited to planner or other non-Reflect features that still need it

## Non-Goals For This Branch

- adding a new public reflect endpoint
- introducing another runtime service or container
- migrating voice or image generation
- moving the reflect planner into VoltAgent
- replacing Footnote trace, incident, or provenance systems
- making the entire repo provider-agnostic in one pass
