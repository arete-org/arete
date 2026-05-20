# Footnote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/footnote-ai/footnote)

Footnote is an AI assistant focused on transparency and provenance.

## Quickstart

1. Clone and start:

```bash
git clone https://github.com/footnote-ai/footnote.git
cd footnote
pnpm start
```

`pnpm start` will:

- create `.env` from `.env.example` if missing
- generate required local secrets if missing
- generate `footnote.yaml` if missing
- install dependencies if missing
- start backend + web

2. Add provider secrets in `.env` (optional at startup, required for model features):

```env
OPENAI_API_KEY=...
# or
OLLAMA_API_KEY=...
```

3. For later local runs, use:

```bash
pnpm start
```

Open `http://localhost:8080`.

Native wrappers (`.sh`, `.ps1`, `.exe`) are planned as follow-up work and are not part of this flow yet.

## Where Settings Go

- Non-secret runtime settings: `footnote.yaml`
- Secrets: `.env` (local) or platform secrets (for example Fly secrets)

Example `footnote.yaml`:

```yaml
version: 1

server:
    host: '::'
    port: 3000
    trust-proxy: false
    data-dir: '/data'

web:
    allowed-origins:
        - 'http://localhost:8080'
        - 'http://localhost:3000'
    frame-ancestors:
        - "'self'"
        - 'http://localhost:8080'
        - 'http://localhost:3000'

discord-bots: []
```

The server can supervise multiple Discord bots from `discord-bots`. Most users can keep it empty at first.

## Docker

```bash
pnpm validate-env --target server
docker compose -f deploy/compose.yml up --build
```

## Docs

- Deployment guide: [deploy/README.md](deploy/README.md)
- Prompt/profile config: [docs/architecture/prompt-resolution.md](docs/architecture/prompt-resolution.md)
- Docs map: [docs/README.md](docs/README.md)

## License

Footnote is dual-licensed under MIT and HL3-CORE. See [docs/LICENSE_STRATEGY.md](docs/LICENSE_STRATEGY.md).
