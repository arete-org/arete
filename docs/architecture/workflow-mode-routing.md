# Workflow Mode Routing

## Purpose

A workflow mode is the explicit high-level routing decision for chat execution.

Each part has a different job. The Execution Contract sets the allowed posture.
The chat orchestrator runs within that contract. Workflow mode is the
high-level choice, and workflow profile is the concrete step pattern. TRACE is
about answer temperament, while provenance and evidence metadata are about what
actually happened.

Keep contract posture and workflow mechanics separate. The Execution Contract
preset answers "what kind of run should govern this request?" The workflow
profile id answers "what step pattern should execute this run?" Mixing them
into one label makes naming and reasoning harder.

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
