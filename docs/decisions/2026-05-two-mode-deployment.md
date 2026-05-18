# Two-Mode Deployment: All-in-One and Split

**Decision:** Support two deployment modes: a single-container all-in-one mode for personal/free-tier use, and the existing three-service split mode for multi-bot vendor deployments.  
**Date:** 2026-05-18

---

## 1. Context

The current three-service split (`backend`, `web`, `discord-bot`) is well-suited for multi-bot vendor deployments where many bot machines share one backend. Each bot carries its own `BOT_PROFILE_*` env vars and the backend remains the shared runtime boundary for orchestration, traces, incidents, review behavior, and cost recording.

The same split is a barrier for single-user 1-click hosting:

- It requires Docker Compose or three separate cloud apps.
- Persistent volumes on free-tier platforms are often paid or platform-specific.
- Internal networking config (`BACKEND_HOST`, `BACKEND_BASE_URL`, `TRACE_API_TOKEN`) adds setup friction.
- The `web` service currently serves static files with Caddy and proxies `/api/*`; it does not own application logic.

The multi-bot design still requires the bot to remain separate from the backend in vendor deployments. Each bot instance supplies profile-specific adapter context while one shared backend owns orchestration and trace persistence. Merging those roles in vendor mode would require running one full backend container per bot profile, which is more expensive and weakens the shared-backend model.

These two use cases have different shapes and should be served by different deployment modes.

---

## 2. Goals

- Enable a single `docker run` one-liner for personal/free-tier deployments.
- Preserve the existing split deployment for multi-bot vendor use without behavior changes.
- Eliminate the separate `web` container in all-in-one mode by having the backend serve the Vite build as static files.
- Eliminate the user-facing `TRACE_API_TOKEN` requirement in all-in-one mode by auto-generating it at container startup.
- Keep Footnote provenance, trace, auth, incident, review, and cost authority in the backend.
- Introduce no changes to core application logic in either mode.

---

## 3. Decision

### 3.1 Mode A: All-in-One (new)

Add a new all-in-one image for personal and free-tier deployments.

A new `deploy/Dockerfile.allinone` builds the Vite app, backend, and Discord bot into one image.

A process entrypoint starts both runtimes:

- Backend (`node dist/server.js`) serves the API and the Vite static build.
- Bot (`node dist/index.js`) connects to the backend at `http://localhost:3000`.
- `TRACE_API_TOKEN` is auto-generated at startup if unset, exported to both processes, and never logged.
- If either child process exits, the entrypoint shuts down the other process and exits non-zero so the platform can restart the container.

Example local deployment:

```sh
docker run -p 8080:3000 --env-file .env -v footnote-data:/data ghcr.io/footnote-ai/footnote:latest
```

All-in-one mode supports exactly one bot profile per container. Multi-profile deployments must use split mode.

### 3.2 Mode B: Split (unchanged)

Keep the existing split deployment as the default mode for multi-bot vendor deployments:

- `deploy/compose.yml`
- `deploy/fly.backend.toml`
- `deploy/fly.web.toml`
- `deploy/fly.bot.toml`
- existing deploy scripts and per-service images

The split mode remains the right shape when many independent Discord bot machines share one backend orchestration and trace pipeline.

### 3.3 Backend Static Transport

The backend already owns static/SPA transport code through `packages/backend/src/http/staticTransport.ts` and asset resolution through `packages/backend/src/http/assets.ts`.

All-in-one implementation should reuse and harden that path rather than adding a second `express.static` mechanism. Static serving must remain fail-open:

- If the Vite build output is present, the backend serves it.
- If the build output is absent, backend startup continues.
- Missing static assets return the existing static transport fallback/404 behavior.
- Startup logs should warn about missing static output without blocking API or bot operation.

### 3.4 Durability Boundary

All-in-one mode reduces process and networking complexity; it does not remove durability requirements.

Users who care about provenance, trace, and incident history must provide durable storage for `/data` or configure backup replication. If `/data` is ephemeral, the deployment is suitable only for throwaway testing.

---

## 4. High-Level Plan

### Phase 0: Backend Static Serving Verification

- Verify the backend static transport serves the packaged `packages/web/dist` output in an all-in-one image.
- Harden missing-build behavior so absence of `index.html` does not cause backend startup failure.
- Add startup logging that reports whether static web assets are available.
- Do not change the API surface or route semantics.

### Phase 1: All-in-One Dockerfile and Entrypoint

- Add `deploy/Dockerfile.allinone` with a multi-stage build:
    - web build stage
    - backend build stage
    - bot build stage
    - combined runtime stage
- Add an all-in-one entrypoint that:
    - auto-generates `TRACE_API_TOKEN` if not set,
    - exports `BACKEND_BASE_URL=http://localhost:3000` for the bot,
    - preserves optional Litestream backup support if `LITESTREAM_REPLICA_URL` is configured,
    - starts backend and bot as sibling child processes,
    - forwards shutdown signals to both processes,
    - exits non-zero when either process exits unexpectedly.

### Phase 2: Compose and Documentation

- Add `deploy/compose.allinone.yml` as a convenience wrapper for local testing of the all-in-one image.
- Update `deploy/README.md` to document both modes with a clear decision guide:
    - use all-in-one for personal/free-tier or single-profile deployments,
    - use split for multi-bot vendor deployments.
- Add a `docker run` one-liner to the root `README.md` quick-start section.
- Document that durable `/data` or backup replication is required for non-throwaway deployments.

### Phase 3: CI/CD

- Add a GitHub Actions job to build and push the all-in-one image to `ghcr.io/footnote-ai/footnote` on `main`.
- Keep existing per-service image builds and Fly deploy workflow unchanged.
- Add provider deploy buttons only after the image is published and a platform-specific smoke test confirms port, volume, and entrypoint behavior.

---

## 5. Invariants

- **Invariant A:** Split mode (`compose.yml`, Fly manifests, deploy scripts, and per-service images) must continue to work without behavior changes.
- **Invariant B:** All-in-one mode supports exactly one bot profile. Users needing multiple profiles must use split mode.
- **Invariant C:** Persistent data paths remain anchored at `/data`. Data written in all-in-one mode should be readable if the user later migrates to split mode.
- **Invariant D:** Auto-generated `TRACE_API_TOKEN` in all-in-one mode must not be logged or exposed in startup output.
- **Invariant E:** If either backend or bot exits in all-in-one mode, the container must stop so the host platform can restart it.
- **Invariant F:** All-in-one mode must not move provenance, trace, auth, incident, review, or cost authority out of the backend.
- **Invariant G:** Exposing the backend directly in all-in-one mode must preserve backend-owned HTTP protections, including route auth, rate limits, CSP, and trace authentication.

---

## 6. Non-Goals

- No database migrations, backfills, or compatibility layers.
- No multi-profile support inside one all-in-one container.
- No changes to vendor profile semantics.
- No changes to core chat, trace, incident, review, planner, or model-routing behavior.
- No replacement of the split deployment model.

---

## 7. Implementation Status

Status as of 2026-05-18:

- **Phase 0:** not started
- **Phase 1:** not started
- **Phase 2:** not started
- **Phase 3:** not started
