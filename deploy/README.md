# Deployment

Start with `README.md` for project overview.

Footnote supports one canonical deployment mechanism: run the Footnote server container.

Canonical artifacts:

- image build: `deploy/Dockerfile.server`
- entrypoint: `deploy/server-entrypoint.sh`
- compose wrapper: `deploy/compose.server.yml`
- Fly manifest: `deploy/fly/server.toml`

## Canonical Install Image

Use:

- `ghcr.io/footnote-ai/footnote:latest` (default branch)
- `ghcr.io/footnote-ai/footnote:sha-<shortsha>` (main-branch immutable build)
- `ghcr.io/footnote-ai/footnote:vX.Y.Z` and `ghcr.io/footnote-ai/footnote:X.Y.Z` (tag builds)

## Breaking Changes (Hard Cutover)

Removed from supported deploy surface:

- `deploy/compose.yml`
- `deploy/Dockerfile.backend`
- `deploy/Dockerfile.web`
- `deploy/Dockerfile.bot`
- split Fly manifests (`deploy/fly/backend.toml`, `deploy/fly/web.toml`, `deploy/fly/bot.toml`)
- split deploy model (separate backend/web/bot apps)

## Required Environment

Server runtime required keys:

- `INCIDENT_PSEUDONYMIZATION_SECRET`

Provider configuration is optional at startup:

- the server starts fail-open without `OPENAI_API_KEY` or `OLLAMA_BASE_URL`
- model-dependent features return setup-required responses until a provider is configured

Trace token resolution (server runtime):

- `TRACE_API_TOKEN > TRACE_API_TOKEN_FILE > /data/secrets/trace-api-token`
- token values are never logged
- `/data/secrets/trace-api-token` is generated once, then reused

Validate before deploy:

- local/server: `pnpm validate-env --target server`
- Fly server app: `pnpm validate-env --target fly-server`

## Local Discord Node Configuration (Canonical)

The server can supervise local Discord persona nodes from canonical server settings YAML.

- settings path env key: `FOOTNOTE_SERVER_SETTINGS_PATH` (optional)
- default server settings path: `/data/config/footnote.server.yaml`
- local nodes key: `settings.localNodes.nodes`
- missing `settings.localNodes.nodes`: server boots with zero nodes and logs `no_local_nodes_configured`

Security model:

- YAML stores env variable names, not raw secret values.
- Discord credentials are only required for nodes that are enabled.

Example (`version: 1`):

```yaml
version: 1
settings:
    localNodes:
        nodes:
            - id: footnote
              required: true
              credentials:
                  discordTokenEnv: FOOTNOTE_DISCORD_TOKEN
                  discordClientIdEnv: FOOTNOTE_DISCORD_CLIENT_ID
                  discordGuildIdsEnv: FOOTNOTE_DISCORD_GUILD_IDS
                  discordUserIdEnv: FOOTNOTE_DISCORD_USER_ID
                  incidentSecretEnv: INCIDENT_PSEUDONYMIZATION_SECRET
              profile:
                  id: footnote
                  displayName: Footnote
                  mentionAliases: [footnote]
```

Behavior:

- optional node missing creds/config => disabled + explicit log reason
- required node missing creds/config => startup failure
- node crash retry policy => unhealthy after 3 failures in 5 minutes

## Start / Stop (Docker)

Start:

`docker compose -f deploy/compose.server.yml up --build`

Stop:

`docker compose -f deploy/compose.server.yml down`

## Fly.io (Single App)

Deploy one server app:

- `fly deploy -c deploy/fly/server.toml`
- `./deploy/fly/deploy.sh`
- `./deploy/fly/deploy.ps1`

Lifecycle helpers:

- `./deploy/fly/start.sh` / `./deploy/fly/start.ps1`
- `./deploy/fly/stop.sh` / `./deploy/fly/stop.ps1`
- `./deploy/fly/restart.sh` / `./deploy/fly/restart.ps1`
- `./deploy/fly/clear-secrets.sh` / `./deploy/fly/clear-secrets.ps1`

## Notes

- Server listens on container port `3000` and is mapped to host port `8080` in compose.
- `/data` must be durable for persistent provenance/incident history and trace-token persistence.
- Local Discord persona nodes are supervised adapters; backend authority remains in the server process.
- Backend static serving remains fail-open when static build output is absent.
- Backend startup logs include Litestream replication visibility.

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
