# Deployment (Issue #96)

This folder defines the minimal 3-service split for local/self-hosted Docker Compose.

Services:
- backend: Node server (`server.js`) for `/api/*`, Turnstile verification, rate limiting, tracing, and GitHub webhooks.
- web: builds the Vite app and serves it with Caddy, proxying `/api/*` to backend.
- discord-bot: Discord bot runtime only.

## Prerequisites
- Ensure `.env` is present at the repo root.

## Required environment
- backend: `OPENAI_API_KEY`
- discord-bot: `DISCORD_TOKEN`, `OPENAI_API_KEY`

## Optional environment
- backend: `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` (both required to enable CAPTCHA)
- backend: `GITHUB_WEBHOOK_SECRET` (enables blog sync)
- backend/bot: `LOG_LEVEL` (defaults to `debug`)
- backend: `ARETE_ALLOWED_ORIGINS`, `ARETE_FRAME_ANCESTORS` (override CORS/CSP allowlists)
- backend: `ARETE_DEFAULT_MODEL`, `ARETE_DEFAULT_REASONING_EFFORT`, `ARETE_DEFAULT_VERBOSITY` (reflect defaults)
- backend/bot: `TRACE_API_TOKEN` (required for authenticated trace writes)
- backend: `TRACE_API_RATE_LIMIT`, `TRACE_API_RATE_LIMIT_WINDOW_MS`, `TRACE_API_MAX_BODY_BYTES` (trace ingestion limits)

## Start
`docker compose -f deploy/compose.yml up --build`

## Stop
`docker compose -f deploy/compose.yml down`

## Fly.io
- Backend: `fly deploy -c deploy/fly.backend.toml`
- Web: `fly deploy -c deploy/fly.web.toml`
- Bot: `fly deploy -c deploy/fly.bot.toml`
- All three (bash): `./deploy/deploy-fly.sh`
- All three (PowerShell): `./deploy/deploy-fly.ps1`
  (Requires Fly CLI: https://fly.io/docs/flyctl/install/)
  TODO: add interactive prompts in the deploy scripts for setting Fly secrets (`fly secrets set`).
  Note: we use three separate Fly apps to mirror the Docker Compose service split.
  Note: web uses `BACKEND_HOST=arete-backend.internal` in `deploy/fly.web.toml`; update it if the backend app name changes.
  Secrets per app:
  - backend: `OPENAI_API_KEY`
  - backend (optional): `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`, `GITHUB_WEBHOOK_SECRET`
  - bot: `DISCORD_TOKEN`, `OPENAI_API_KEY`
  - bot (optional): `LOG_LEVEL`

## Notes
- Only the web service is exposed on host port 8080 (`http://localhost:8080`) to avoid admin privileges.
- The backend listens internally on port 3000 and stores data in `/data` (Docker volume: `arete-data`).
- Blog post JSONs are stored in backend-owned storage under `/data/blog-posts` and served via backend endpoints.
- The web app fetches runtime config from `/config.json` (proxied to the backend) to read `TURNSTILE_SITE_KEY`.
