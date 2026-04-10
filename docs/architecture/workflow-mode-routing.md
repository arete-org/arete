# Workflow Mode Routing

## Purpose

A workflow mode is the explicit runtime routing decision for chat execution.

Layer ownership in this design:

- Execution Contract governs allowed policy shape.
- Chat orchestrator executes requests within that contract.
- Workflow mode selects high-level execution posture.
- Workflow profile defines concrete workflow mechanics.
- TRACE describes answer temperament.
- Provenance/evidence metadata records what actually happened.

Each maps to:

- Execution Contract preset
- Workflow profile
- Workflow enablement posture
- Review/revise posture
- Evidence strictness posture
- Step bounds

The chosen mode is emitted as `workflowMode` in response metadata.

## Mode Set

Canonical mode ids:

- `fast`
- `balanced`
- `grounded`

| Mode       | Execution Contract preset | Workflow profile class | Workflow profile id | Workflow execution | Review pass | Revise step  | Evidence posture | Max workflow steps | Max deliberation calls |
| ---------- | ------------------------- | ---------------------- | ------------------- | ------------------ | ----------- | ------------ | ---------------- | ------------------ | ---------------------- |
| `fast`     | `fast-direct`             | `direct`               | `generate-only`     | `disabled`         | `excluded`  | `disallowed` | `minimal`        | 1                  | 0                      |
| `balanced` | `balanced`                | `reviewed`             | `bounded-review`    | `always`           | `included`  | `allowed`    | `balanced`       | 4                  | 2                      |
| `grounded` | `quality-grounded`        | `reviewed`             | `bounded-review`    | `policy_gated`     | `included`  | `allowed`    | `strict`         | 8                  | 4                      |

## Selection Order

1. Use requested mode id when it is recognized.
2. Otherwise infer from Execution Contract response mode (`quality_grounded` -> `grounded`, `fast_direct` -> `fast`).
3. Otherwise fail open to `grounded`.

## Metadata Contract

`workflowMode` in response metadata records:

- `modeId`
- `selectedBy`
- `selectionReason`
- `requestedModeId` (when provided)
- `executionContractResponseMode` (when available)
- `behavior` (the concrete mapped behavior tuple)
