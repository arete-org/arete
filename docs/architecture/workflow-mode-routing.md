# Workflow Mode Routing

## Purpose

A workflow mode is the explicit high-level routing decision for chat execution.

Layer ownership is explicit: Execution Contract governs allowed policy shape,
chat orchestrator executes within that contract, workflow mode selects the
high-level execution posture, workflow profile defines concrete workflow
mechanics, TRACE describes answer temperament, and provenance/evidence metadata
records what actually happened.

The split between contract and workflow is intentional. The Execution Contract
preset answers what kind of run should govern the request, while the workflow
profile id answers what step pattern will carry that out. Keeping them separate
prevents one mixed naming layer that combines policy posture and step
mechanics.

The chosen mode is emitted as `workflowMode` in response metadata.
Each mode resolves to a concrete execution shape. The table below shows that
mapping in runtime terms.

## Mode Set

Canonical mode ids are `fast`, `balanced`, and `grounded`.

| Mode       | Execution Contract preset | Profile kind | Workflow profile id | Workflow use   | Review pass | Revise step  | Evidence level | Max workflow steps | Max deliberation calls |
| ---------- | ------------------------- | ------------ | ------------------- | -------------- | ----------- | ------------ | -------------- | ------------------ | ---------------------- |
| `fast`     | `fast-direct`             | `direct`     | `generate-only`     | `disabled`     | `excluded`  | `disallowed` | `minimal`      | 1                  | 0                      |
| `balanced` | `balanced`                | `reviewed`   | `bounded-review`    | `always`       | `included`  | `allowed`    | `balanced`     | 4                  | 2                      |
| `grounded` | `quality-grounded`        | `reviewed`   | `bounded-review`    | `policy_gated` | `included`  | `allowed`    | `strict`       | 8                  | 4                      |

## Selection Order

1. Use the requested mode when it is recognized.
2. Otherwise, if the Execution Contract provides a response mode, map it to canonical mode (`quality_grounded` -> `grounded`, `fast_direct` -> `fast`).
3. Otherwise, fall back to `grounded`.

This keeps the system available while preferring the more careful default
posture.

## Metadata Contract

`workflowMode` in response metadata records `modeId`, `selectedBy`,
`selectionReason`, optional `requestedModeId`, optional
`executionContractResponseMode`, and `behavior` (the concrete mapped behavior
tuple).
