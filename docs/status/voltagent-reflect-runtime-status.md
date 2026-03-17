# VoltAgent Reflect Runtime Status

## Last Updated

2026-03-17

## Purpose

Track the staged migration of the backend reflect generation path onto a new VoltAgent-backed runtime boundary.

This file should change as the branch evolves. The architecture and decision docs should stay more stable.

## Current State

Footnote currently has one stable public reflect boundary:

- `web` calls `backend`
- `discord-bot` calls `backend`
- `backend` owns `POST /api/reflect`, auth, abuse controls, trace generation, and response metadata

The backend still directly owns the current reflect planner and reflect generation implementation. The current generation path is OpenAI-specific in backend service code.

This branch is intended to introduce a replaceable runtime boundary without adding a new public endpoint or a new service/container.

Assumptions for this plan:

- `backend` remains the only public runtime entrypoint
- the first MVP is text-only reflect generation
- the reflect planner stays in `backend` for this branch
- Footnote-owned metadata, trace storage, and incident/review systems stay in `backend`
- direct cutovers are acceptable inside the branch as long as the branch ends green
- commits should stay small to medium where practical

### What we already have

- a stable backend reflect handler in `packages/backend/src/handlers/reflect.ts`
- a backend reflect planner in `packages/backend/src/services/reflectPlanner.ts`
- backend reflect orchestration in `packages/backend/src/services/reflectOrchestrator.ts`
- backend reflect generation and metadata assembly in `packages/backend/src/services/reflectService.ts`
- an OpenAI-specific backend generation wrapper in `packages/backend/src/services/openaiService.ts`
- web and Discord clients already standardized on the backend reflect API

### Validation baseline

Already in place:

- `packages/backend/test/reflectHandler.test.ts`
- `packages/backend/test/reflectOrchestrator.test.ts`
- `packages/backend/test/reflectPlanner.test.ts`
- `packages/backend/test/reflectService.test.ts`
- `packages/backend/test/openaiService.metadata.test.ts`

Still missing:

- internal runtime contract tests
- runtime-adapter conformance tests
- VoltAgent adapter tests
- backend tests that prove metadata and trace behavior remain stable after the runtime seam is introduced

## Working Plan

### Wave 1: Create The Runtime Boundary

Goal: establish a new internal runtime package and move reflect generation behind it without changing behavior yet.

#### 1A. Create `agent-runtime` package and internal contracts

Status: Planned

- add a new workspace package for runtime integration
- define Footnote-owned internal runtime interfaces for reflect generation
- add any required workspace TypeScript/build wiring so `backend` can depend on the new package cleanly

Acceptance:

- `backend` can import the new package through a stable workspace boundary
- no public API behavior changes yet
- the new package owns only internal runtime contracts at this stage

#### 1B. Route backend reflect generation through a legacy adapter

Status: Planned

- make `backend` call the new runtime seam for message generation
- implement a legacy adapter that preserves the current OpenAI-backed generation behavior
- keep planner selection, auth, trace generation, and response metadata in `backend`

Depends on:

- Wave 1A

Acceptance:

- `/api/reflect` behavior remains unchanged
- existing reflect tests still pass
- the runtime seam is now real, not just a placeholder package

### Wave 2: Reduce Backend Runtime Coupling

Goal: make the runtime boundary meaningful before introducing VoltAgent.

#### 2A. Move generation-specific logic into the runtime package

Status: Planned

- move generation-only normalization and adapter-facing logic out of backend service code
- keep backend focused on orchestration, metadata derivation, and trace persistence
- keep the planner in backend

Depends on:

- Wave 1B

Acceptance:

- backend no longer directly owns the low-level reflect generation path
- backend still owns Footnote-specific metadata and trace semantics
- no public API changes

### Wave 3: Introduce VoltAgent For Text Reflect Generation

Goal: add VoltAgent as a real runtime implementation for the existing reflect flow.

#### 3A. Add a VoltAgent adapter in the runtime package

Status: Planned

- add VoltAgent dependencies only where the new runtime package needs them
- implement a text-only VoltAgent adapter for the internal reflect runtime interface
- keep scope narrow:
  - no planner migration
  - no voice
  - no image generation
  - no durable memory
  - no RAG

Depends on:

- Wave 2A

Acceptance:

- the VoltAgent adapter can execute the current reflect generation contract
- adapter outputs can be consumed by backend metadata logic without changing public contracts
- adapter-specific tests cover normalized text output and runtime facts needed by backend

#### 3B. Cut backend reflect generation over to VoltAgent

Status: Planned

- change the runtime wiring so backend reflect generation uses the VoltAgent adapter
- keep the planner in backend
- keep the public endpoint and caller behavior unchanged

Depends on:

- Wave 3A

Acceptance:

- web and Discord continue using the same backend reflect API
- response metadata and trace storage still work through backend-owned paths
- no additional service/container is required

### Wave 4: Cleanup And Final Hardening

Goal: remove obsolete code and leave the branch in a stable final state.

#### 4A. Remove dead legacy generation code

Status: Planned

- remove backend reflect generation code that is no longer used after cutover
- keep any OpenAI code still needed for planner or non-reflect features

Depends on:

- Wave 3B

Acceptance:

- backend reflect generation no longer depends on the old direct implementation path
- planner and unrelated OpenAI-backed features continue to compile and behave correctly

#### 4B. Final regression pass

Status: Planned

- run the relevant reflect/backend validation paths
- update this status doc to reflect final outcomes and any deviations from the original plan

Depends on:

- Wave 4A

Acceptance:

- branch ends with the intended runtime boundary in place
- existing reflect contract remains stable
- remaining follow-up work is explicitly documented if anything is deferred

## Non-Goals For This Branch

- adding a new public reflect endpoint
- introducing another runtime service or container
- migrating voice or image generation
- moving the reflect planner into VoltAgent
- replacing Footnote trace, incident, or provenance systems
- making the entire repo provider-agnostic in one pass
