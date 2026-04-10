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
Today, planner dispatch still happens in orchestration before workflow
execution. The target shape is for planner behavior to be represented as
bounded workflow step types so workflow remains the owner of when and why
planning runs.

The chosen mode is emitted as `workflowMode` in response metadata.
Each mode resolves to a concrete execution shape. The table below shows that
mapping in runtime terms.

## Mode Set

Canonical mode ids are `fast`, `balanced`, and `grounded`.

| Mode       | Contract preset    | Profile id       | Workflow used | Review | Revise | Evidence | Steps | Deliberation | Notes                                      |
| ---------- | ------------------ | ---------------- | ------------- | ------ | ------ | -------- | ----- | ------------ | ------------------------------------------ |
| `fast`     | `fast-direct`      | `generate-only`  | no            | no     | no     | minimal  | 1     | 0            | direct single-pass path                    |
| `balanced` | `balanced`         | `bounded-review` | yes           | yes    | yes    | balanced | 4     | 2            | reviewed default path                      |
| `grounded` | `quality-grounded` | `bounded-review` | conditional   | yes    | yes    | strict   | 8     | 4            | same profile as `balanced`, stricter guard |

`balanced` and `grounded` already show why the split matters: they share one
workflow profile (`bounded-review`) but differ in posture and limits.

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
