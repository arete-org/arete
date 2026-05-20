# Deployment

Footnote deploys as one server container.

Canonical artifacts:

- `deploy/Dockerfile.server`
- `deploy/server-entrypoint.sh`
- `deploy/compose.yml`
- `deploy/fly/server.toml`

## First Setup

1. Run setup once:

```bash
pnpm setup
```

2. Keep or edit `footnote.yaml` (non-secret runtime settings):
    - default path: `./footnote.yaml`
    - advanced override: `FOOTNOTE_SETTINGS_PATH` env var

3. Set secrets only in `.env` (or platform secrets).

4. Validate env:

```bash
pnpm validate-env --target server
```

5. Start:

```bash
docker compose -f deploy/compose.yml up --build
```

## Settings vs Secrets

- `footnote.yaml`: non-secret runtime behavior
- `.env` / Fly secrets: secret values

`footnote.yaml` can contain env var names for Discord bot credentials (for example `discord-token-env: DISCORD_TOKEN`) but must not contain secret values.

## Discord Bots

A Discord bot entry tells the server to run one bot process.
You can run multiple bots by adding multiple items in `discord-bots`.

Minimal example:

```yaml
version: 1

discord-bots:
    - id: 'main-discord'
      enabled: true
      required: false
      credentials:
          discord-token-env: 'DISCORD_TOKEN'
          discord-client-id-env: 'DISCORD_CLIENT_ID'
          discord-guild-ids-env: 'DISCORD_GUILD_IDS'
          discord-user-id-env: 'DISCORD_USER_ID'
          incident-secret-env: 'INCIDENT_PSEUDONYMIZATION_SECRET'
      profile:
          id: 'default'
          display-name: 'Footnote'
          mention-aliases: []
```

Behavior:

- optional bot missing credentials: disabled with explicit log reason
- required bot missing credentials: startup fails
- no `discord-bots`: fail-open startup with zero bots

## Fly.io

Single-app deploy:

- `./deploy/fly/deploy.sh`
- `./deploy/fly/deploy.ps1`

Manual deploy:

```bash
fly deploy -c deploy/fly/server.toml
```
