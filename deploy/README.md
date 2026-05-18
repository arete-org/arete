# Deployment

If you landed here first, start with the main README for the big-picture overview:
`README.md`

This folder supports server and node deployment topologies.

- `server-local-node`: one container runs the Footnote server and supervises one local Discord node.
- `server-external-nodes`: separate `backend`, `web`, and `discord-bot` services for shared-backend deployments.
- `server-only`: server runtime without an active local node.

Most people run the Footnote server. The server can include one local Discord node for simple self-hosting. Larger deployments can run nodes separately.

Services:

- backend: Node server (`server.js`) for `/api/*`, Turnstile verification, rate limiting, and tracing.
- web: builds the Vite app and serves it with Caddy, proxying `/api/*` to backend.
- discord-bot: Discord bot runtime only.

Server image and compose wrapper:

- image build: `deploy/Dockerfile.server`
- compose wrapper: `deploy/compose.server.yml`

## Prerequisites

- Ensure `.env` is present at the repo root.

## Required environment

- backend: `OPENAI_API_KEY`, `TRACE_API_TOKEN`
- discord-bot: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OPENAI_API_KEY`, `DISCORD_USER_ID`, `INCIDENT_PSEUDONYMIZATION_SECRET`, `TRACE_API_TOKEN`
- server (`server-local-node`): `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OPENAI_API_KEY`, `DISCORD_USER_ID`, `INCIDENT_PSEUDONYMIZATION_SECRET`, `TRACE_API_TOKEN`
    > Why `TRACE_API_TOKEN`? It's a shared key used to authenticate trace uploads from the bot to the backend.

Validate expected deployment env before deploy:

- backend: `pnpm validate-env --target fly-backend`
- bot: `pnpm validate-env --target fly-bot`
- server: `pnpm validate-env --target server`

## Optional environment

### Optional Services

- **Cloudflare Turnstile (abuse prevention)**  
  Turnstile protects public endpoints from abuse.  
  If **both keys** are set, CAPTCHA is enforced.  
  If **neither key** is set, CAPTCHA is skipped.
    ```env
    TURNSTILE_SITE_KEY=...
    TURNSTILE_SECRET_KEY=...
    ```
- **Cloudinary (image uploads)**  
  If Cloudinary credentials are provided, images can be uploaded and referenced in traces.  
  If not, the system falls back to attaching images directly in Discord.
    ```env
    CLOUDINARY_CLOUD_NAME=...
    CLOUDINARY_API_KEY=...
    CLOUDINARY_API_SECRET=...
    ```
    > If these are missing, images are still delivered via Discord attachments.
- **Storage Path**  
  Response traces are stored in SQLite:
    ```env
    PROVENANCE_SQLITE_PATH=/data/provenance.db
    ```
    > On Fly.io, `/data` is backed by a persistent volume. On other hosts, point this path at a durable directory.
- **Litestream backup replication**
  Backend image runs through Litestream and can continuously replicate both SQLite files.
    ```env
    LITESTREAM_REPLICA_URL=s3://<bucket>/<prefix>
    ```
    > Litestream reads `deploy/litestream.yml` and replicates `/data/provenance.db` and `/data/incidents.db`.

### Optional Environment Variables

- backend: `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` (both required to enable CAPTCHA)
- backend/bot: `LOG_LEVEL` (defaults to `debug`)
- backend: `ALLOWED_ORIGINS`, `FRAME_ANCESTORS` (override CORS/CSP allowlists)
- backend: `DEFAULT_MODEL`, `DEFAULT_REASONING_EFFORT`, `DEFAULT_VERBOSITY` (reflect defaults)
- backend: `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_LOCAL_INFERENCE_ENABLED` (Ollama cloud/local behavior)
- backend: `TRACE_API_RATE_LIMIT`, `TRACE_API_RATE_LIMIT_WINDOW_MS`, `TRACE_API_MAX_BODY_BYTES` (trace ingestion limits)
- backend: `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER`, `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_SERPAPI_API_KEY`, `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER_TIMEOUT_MS` (reverse-image provider runtime)
- backend: `LITESTREAM_REPLICA_URL` (SQLite replication target)
- bot: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (optional image uploads)
- bot: `BOT_PROFILE_ID`, `BOT_PROFILE_DISPLAY_NAME`, `BOT_PROFILE_PROMPT_OVERLAY_PATH` (optional persona overlays)
- bot: `WEB_BASE_URL` (recommended for split deployments so trace links open on the canonical web host)

## Start

Server (`server-local-node`):

`docker compose -f deploy/compose.server.yml up --build`

Split:

`docker compose -f deploy/compose.yml up --build`

## Stop

Server (`server-local-node`):

`docker compose -f deploy/compose.server.yml down`

Split:

`docker compose -f deploy/compose.yml down`

## Fly.io

- Backend: `fly deploy -c deploy/fly/backend.toml`
- Web: `fly deploy -c deploy/fly/web.toml`
- Bot: `fly deploy -c deploy/fly/bot.toml`
- All three (bash): `./deploy/fly/deploy.sh`
- All three (PowerShell): `./deploy/fly/deploy.ps1`
  (Requires Fly CLI: https://fly.io/docs/flyctl/install/)
  The scripts read `.env`, prompt for missing secrets, and run `pnpm validate-env` before deploy.
  Note: we use three separate Fly apps to mirror the Docker Compose service split.
  Note: web uses `BACKEND_HOST=footnote-backend.internal` in `deploy/fly/web.toml`; update it if the backend app name changes.
  GitHub Actions deploys use `.github/workflows/fly-deploy.yml` and only need the `FLY_API_TOKEN` secret; app names come from `deploy/fly/*.toml`.
  Secrets per app:
    - backend: `OPENAI_API_KEY`, `TRACE_API_TOKEN`
    - backend (optional): `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`, `LOG_LEVEL`, `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER`, `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_SERPAPI_API_KEY`, `CHAT_CONTEXT_REVERSE_IMAGE_SEARCH_PROVIDER_TIMEOUT_MS` (required as optional backend secrets when `reverse_image_search` runtime provider mode is enabled)
    - bot: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OPENAI_API_KEY`, `DISCORD_USER_ID`, `INCIDENT_PSEUDONYMIZATION_SECRET`, `TRACE_API_TOKEN`
    - bot (optional): `LOG_LEVEL`, `WEB_BASE_URL`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `BOT_PROFILE_ID`, `BOT_PROFILE_DISPLAY_NAME`, `BOT_PROFILE_PROMPT_OVERLAY_PATH`

## Execution Contract TrustGraph Rollout Boundary

- Backend `executionContractTrustGraph` runtime integration exists in this repo.
- External TrustGraph service implementation does not exist in this repo.
- This repo currently supports backend config hardening, runtime safety, and kill-switch rollback behavior.
- Full local Docker and Fly rollout for TrustGraph requires a pinned external service contract (image/repo, endpoint path, auth token contract, health behavior).
- Canonical rollback remains backend-side: set `EXECUTION_CONTRACT_TRUSTGRAPH_KILL_SWITCH=true`.

### Next steps

1. Pin external TrustGraph service image/repo.
2. Pin evidence endpoint path and health/readiness contract.
3. Pin auth token expectations and rotation approach.
4. Add compose TrustGraph service only after the external contract is pinned.
5. Add Fly TrustGraph app manifest only after the external contract is pinned.
6. Validate local full-stack path and private Fly path with backend kill-switch rollback test.

Template overlay paths:

- `packages/prompts/src/profile-overlays/danny.md`
- `packages/prompts/src/profile-overlays/myuri.md`

## Notes

- Split mode exposes only web on host port 8080 (`http://localhost:8080`); backend stays internal on port 3000.
- Server (`server-local-node`) exposes backend/web transport directly on host port 8080 -> container port 3000.
- The backend stores data in `/data` (Docker volume: `footnote-data`).
- Durable `/data` is required for persistent provenance/incident history. Ephemeral `/data` is suitable only for throwaway testing.
- Backend startup logs include Litestream replication visibility and latest known snapshot timestamp (or `none yet`).
- The web app fetches runtime config from `/config.json` (proxied to the backend) to read `TURNSTILE_SITE_KEY`.

## Litestream Restore Runbook

1. Stop backend writes and run restore commands to a temp directory:
    - `litestream restore -if-replica-exists -o /tmp/restore/provenance.db "${LITESTREAM_REPLICA_URL}/provenance"`
    - `litestream restore -if-replica-exists -o /tmp/restore/incidents.db "${LITESTREAM_REPLICA_URL}/incidents"`
2. Verify restored DBs are readable:
    - `sqlite3 /tmp/restore/provenance.db "select count(*) from provenance_traces;"`
    - `sqlite3 /tmp/restore/incidents.db "select count(*) from incidents;"`
3. Replace live files only during maintenance downtime:
    - copy restored files to `/data/provenance.db` and `/data/incidents.db`
    - restart backend container
4. Confirm backend boot logs show normal SQLite initialization and no Litestream replication errors.

