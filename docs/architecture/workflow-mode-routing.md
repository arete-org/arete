# Workflow Mode Routing

## Purpose

Workflow mode is the explicit runtime routing decision for chat execution.
It is not a planning hint.

Each mode deterministically maps to:

- Execution Contract preset
- Workflow profile
- Workflow enablement posture
- Review/revise posture
- Evidence strictness posture
- Step bounds

The chosen mode is emitted in response metadata as `workflowMode`.

## Mode Set

| Mode               | Execution Contract preset | Workflow profile | Workflow execution | Review pass | Revise step  | Evidence posture | Max workflow steps | Max deliberation calls |
| ------------------ | ------------------------- | ---------------- | ------------------ | ----------- | ------------ | ---------------- | ------------------ | ---------------------- |
| `fast-direct`      | `fast-direct`             | `generate-only`  | `disabled`         | `excluded`  | `disallowed` | `minimal`        | 1                  | 0                      |
| `balanced`         | `balanced`                | `bounded-review` | `always`           | `included`  | `allowed`    | `balanced`       | 4                  | 2                      |
| `quality-grounded` | `quality-grounded`        | `bounded-review` | `policy_gated`     | `included`  | `allowed`    | `strict`         | 8                  | 4                      |
| `bounded-review`   | `quality-grounded`        | `bounded-review` | `always`           | `included`  | `allowed`    | `strict`         | 4                  | 4                      |
| `generate-only`    | `fast-direct`             | `generate-only`  | `always`           | `excluded`  | `disallowed` | `minimal`        | 1                  | 0                      |

## Selection Order

1. Use requested mode id when it is recognized.
2. Otherwise infer from Execution Contract response mode (`quality_grounded` -> `quality-grounded`, `fast_direct` -> `fast-direct`).
3. Otherwise fail open to `bounded-review`.

## Metadata Contract

`workflowMode` in response metadata records:

- `modeId`
- `selectedBy`
- `selectionReason`
- `requestedModeId` (when provided)
- `executionContractResponseMode` (when available)
- `behavior` (the concrete mapped behavior tuple)
