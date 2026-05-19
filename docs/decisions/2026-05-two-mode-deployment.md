# Server and Nodes Deployment Topologies

**Decision:** Footnote deployment is modeled as a server authority with optional attached nodes.  
**Date:** 2026-05-18

---

## 1. Context

Footnote needs two operational shapes that preserve one architectural boundary:

- The **server** remains the authority for orchestration, traces, auth, incidents, review behavior, cost recording, storage, and web/API transport.
- **Nodes** are attached processes that provide adapter/persona/capability surfaces.

Today, the first supported node type is a Discord persona node.

The previous naming (`all-in-one` vs `split`) described packaging, not architecture. This decision pivots to topology language while preserving authority boundaries.

---

## 2. Topology Model

### 2.1 `server-local-node`

- One container runs the Footnote server and supervises one local Discord node.
- Backed by `deploy/Dockerfile.server`, `deploy/server-entrypoint.sh`, and `deploy/compose.server.yml`.
- Recommended for simple self-hosting.

### 2.2 `server-external-nodes`

- Server and nodes run as separate services/containers.
- Current reference compose remains `deploy/compose.yml`.
- Suitable when multiple independent node deployments share one backend.

### 2.3 `server-only`

- Server runtime without an active local node.
- Useful for web/API-only operation and future expansion paths.

---

## 3. Trace Token Policy (`server-local-node`)

`TRACE_API_TOKEN` is resolved in strict order:

1. `TRACE_API_TOKEN` env value.
2. `TRACE_API_TOKEN_FILE` path.
3. `/data/secrets/trace-api-token` (create if missing, then reuse).

Rules:

- Generated token is persistent and reused across restarts.
- Resolver attempts restrictive permissions where supported (`0700` dir, `0600` file).
- Startup logs report **token source only**, never token value.
- If token cannot be read/created and no env override exists, startup fails clearly.

Distributed (`server-external-nodes`) deployments may continue to provide `TRACE_API_TOKEN` explicitly through platform secrets.

---

## 4. Durability Boundary

Topology simplification does not remove durability requirements.

- `/data` remains the boundary for provenance/incident history and persisted local-node token material.
- Ephemeral `/data` is suitable only for throwaway testing.
- Durable `/data` (or backup replication) is required for persistent operation.

---

## 5. Deploy Folder Shape

Server and shared deploy artifacts remain at `deploy/` root.

Fly-specific assets are grouped under `deploy/fly/`:

- manifests: `deploy/fly/backend.toml`, `deploy/fly/web.toml`, `deploy/fly/bot.toml`
- scripts: `deploy/fly/deploy.{sh,ps1}`, `deploy/fly/start.{sh,ps1}`, `deploy/fly/stop.{sh,ps1}`, `deploy/fly/restart.{sh,ps1}`, `deploy/fly/clear-secrets.{sh,ps1}`

---

## 6. Invariants

- **Invariant A:** Server authority boundary remains unchanged.
- **Invariant B:** Local Discord runtime is a supervised node process, not merged backend logic.
- **Invariant C:** `server-external-nodes` behavior remains unchanged aside from naming/path references.
- **Invariant D:** Trace token value must never be logged.
- **Invariant E:** In `server-local-node`, if backend or local node exits unexpectedly, container exits non-zero.
- **Invariant F:** Backend static serving remains fail-open when static build output is absent.

---

## 7. Non-Goals

- No API schema changes.
- No database migrations/backfills.
- No token-key rename in this pass (`TRACE_API_TOKEN` remains canonical).
- No compatibility wrappers for renamed deploy files.

---

## 8. Implementation Status (this branch)

Completed:

- Renamed server topology artifacts:
    - `deploy/Dockerfile.server`
    - `deploy/server-entrypoint.sh`
    - `deploy/compose.server.yml`
- Updated deploy/docs language to server+nodes framing and topology IDs.
- Moved Fly assets into `deploy/fly/` and updated script/workflow references.
- Added `deploy/traceTokenResolver.mjs` with unit tests.
- Wired server startup to token resolver with persistent token behavior.
- Updated env validation target to `server`.
- Added server topology smoke script for lifecycle verification.
