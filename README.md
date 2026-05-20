# Footnote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/footnote-ai/footnote)

Footnote is an AI assistant that helps you see what is behind an answer.

Ask a question and Footnote gives you a response with receipts: source links, confidence and safety notes, and a trace page for digging deeper.

You can use Footnote in the browser, or run your own copy from this repo.

<img width="761" height="344" alt="image" src="https://github.com/user-attachments/assets/706ea443-7085-41c0-a7ee-06633f196acd" />

[Demo](https://ai.jordanmakes.dev) · [Reading a response](#reading-a-response) · [Quickstart](#quickstart) · [Docs](#docs)

---

## Why Footnote

Most AI tools give you a finished answer and leave the messy part out of view: where the answer came from, what was checked, and how confident the system should really sound.

Footnote keeps more of that context attached to the response. It will not make every answer correct, and it does not pretend to. It gives you more to inspect before you decide what to do with the answer.

## Reading a response

A Footnote response can include:

- the answer
- source links
- confidence and safety notes
- tradeoffs or constraints when they matter
- a trace page with more detail about the run

The trace helps you review the answer; it does not prove the answer is right. For the technical model, see [Response Metadata](docs/architecture/response-metadata.md).

## Quickstart

This starts the local backend and web app.

### Prerequisites

- Node.js installed
- `pnpm` available (or `corepack` enabled)
- At least one generation provider (e.g. Ollama, OpenAI)

### 1) Clone and bootstrap

```bash
git clone https://github.com/footnote-ai/footnote.git
cd footnote
pnpm setup
```

`pnpm setup` will:

- create `.env` from `.env.example` when missing
- generate local development secrets when missing (`INCIDENT_PSEUDONYMIZATION_SECRET`, `TRACE_API_TOKEN`)
- install dependencies

### 2) Configure environment

Configure at least one LLM provider:

```yaml
# Ollama (local)
OLLAMA_LOCAL_INFERENCE_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434

# Ollama (cloud)
# Cannot enable alongside local inference
OLLAMA_BASE_URL=https://api.ollama.com
OLLAMA_API_KEY=...

# OpenAI (cloud)
OPENAI_API_KEY=...
```

Discord credentials are only required when you enable local Discord persona nodes:

```yaml
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_IDS=...
```

For the full set of options, see `.env.example`.
Start with section `00) Start Here (minimum to run)`, then fill optional sections only as needed.

### 3) Launch

Start all services (including the standalone local Discord bot process):

```bash
pnpm start:all
```

Backend and web UI only:

```bash
pnpm dev
```

Open the web app at `http://localhost:8080`.

### Run with Docker

The canonical install path is the Footnote server container image:
`ghcr.io/footnote-ai/footnote`

```sh
docker run \
  --name footnote \
  -p 8080:3000 \
  --env-file .env \
  -v footnote-data:/data \
  ghcr.io/footnote-ai/footnote:latest
```

For production-like installs, pin to an explicit version tag:
`ghcr.io/footnote-ai/footnote:<version>`

For non-throwaway installs, `/data` must be durable because Footnote stores persistence and generated trace token state there.
The server can supervise local Discord persona nodes from `footnote.server.yaml` under `settings.localNodes.nodes`; if missing, the server starts with zero local nodes (fail-open).
If no inference provider is configured yet, server startup still succeeds; model-dependent requests return setup guidance until `OPENAI_API_KEY` or `OLLAMA_BASE_URL` is configured.

### Compose-based local server run

```bash
pnpm validate-env --target server
docker compose -f deploy/compose.server.yml up --build
```

### Advanced configuration

- [Deployment guide](deploy/README.md)
- [Prompt/profile configuration](docs/architecture/prompt-resolution.md)
- [Documentation map](docs/README.md)

## License

Footnote is dual-licensed under MIT and the Hippocratic License v3 (HL3-CORE).

See [license strategy](docs/LICENSE_STRATEGY.md) for details.
