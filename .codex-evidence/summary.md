# Build Timing Evidence (Ticket 2)

- Build #1 (`docker compose -f deploy/compose.yml build`): 127.42s
- Build #2 immediate rerun: 2.40s
- Invalidation rebuild (temporary lockfile content change + rebuild): 77.81s

## Install-step observations

From invalidation rebuild logs:

- backend install step reused store artifacts (`reused 577, downloaded 0`) and completed in ~4.6s (`Done in 4.6s using pnpm`)
- web install step reused store artifacts (`reused 353, downloaded 0`) and completed in ~3.7s (`Done in 3.7s using pnpm`)
- discord-bot install step reused store artifacts (`reused 519, downloaded 0`) and completed in ~4.7s (`Done in 4.7s using pnpm`)

## Smoke check notes

- Web root responded HTTP 200 at `http://localhost:8080/`.
- Web `/api` proxy path responded HTTP 200 at `http://localhost:8080/api/chat/profiles`.
- Bot did not stay healthy in local smoke test with placeholder credentials; logs show command-import/auth failures, but no native module load errors were found in runtime logs (`@discordjs/opus`, `zlib-sync`, `bufferutil`).
