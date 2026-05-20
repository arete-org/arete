# Default Server Deployment With Discord Bots

Operational setup steps live in `deploy/README.md`.
This page explains why the server uses canonical YAML settings and env secrets.

**Decision:** Footnote supports one canonical deployment shape: a single server container that can supervise Discord bot subprocesses.
**Date:** 2026-05-18

---

## 1. Context

Footnote previously documented split and server-local deployment surfaces in parallel. That created duplicated deploy scripts, manifests, and operational guidance while preserving the same backend authority boundary.

This decision hard-cuts to one supported deployment mechanism:

- one server app/container
- backend remains runtime authority
- Discord bots are supervised subprocesses of that server

---

## 2. Canonical Runtime Model

### 2.1 Server authority

The server process remains authoritative for:

- orchestration and policy decisions
- provenance/trace/auth/incident/review behavior
- persistence and cost recording
- durable storage boundary (`/data`) and trace token lifecycle
- web and API serving
- public runtime boundary for web and Discord nodes

### 2.2 Discord bot supervision

Discord bots run as server-local child processes.

- backend exit => server container exits non-zero
- node crash => per-node restart attempts
- unhealthy threshold => 3 failures in 5 minutes per node
- unhealthy node => stop restarting that node; keep server running

### 2.3 Discord bot config contract

- canonical file: `footnote.yaml` at `FOOTNOTE_SETTINGS_PATH` (default `/data/config/footnote.yaml`)
- discord bots key: `discord-bots`
- missing canonical file => fail-open with zero bots and `no_discord_bots_configured` log
- required bot missing config/credentials => startup failure
- optional bot missing config/credentials => disabled with explicit log reason

Schema:

- `version: 1`
- `discord-bots[]`
    - `id`, `enabled`, `required`
    - `credentials` env-key references only
    - `profile` metadata (`id`, `display-name`, optional `overlay-path`, optional `mention-aliases`)

---

## 3. Trace Token Policy

Token resolution order remains unchanged:

1. `TRACE_API_TOKEN`
2. `TRACE_API_TOKEN_FILE`
3. `/data/secrets/trace-api-token` (generate once, persist, reuse)

Token values are never logged.

---

## 4. Hard-Cut Breaking Changes

Removed from active support:

- `deploy/compose.yml`
- `deploy/Dockerfile.backend`
- `deploy/Dockerfile.web`
- `deploy/Dockerfile.bot`
- split Fly manifests and multi-app deploy flows (`backend/web/bot`)

Canonical artifacts:

- `deploy/Dockerfile.server`
- `deploy/server-entrypoint.sh`
- `deploy/compose.yml`
- `deploy/fly/server.toml`
- `pnpm validate-env --target server`
- `pnpm validate-env --target fly-server`

No compatibility wrappers are kept in this cutover.

---

## 5. Future Note

External or split deployment can be revisited later, but is not part of current default supported deployment instructions.
