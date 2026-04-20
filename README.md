# Footnote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/footnote-ai/footnote)

AI you can inspect and steer.

Footnote is an AI assistant that attaches provenance and trace data to its answers, so you can see what information it used and what happened during the response.

This repo contains the Footnote product surfaces and the framework code behind them: the web app, the backend, and the Discord bot.

Built for human oversight, not "just trust me."

<img width="761" height="344" alt="image" src="https://github.com/user-attachments/assets/706ea443-7085-41c0-a7ee-06633f196acd" />

[Demo](https://ai.jordanmakes.dev) · [What You See](#what-you-see-after-asking) · [Quickstart](#quickstart) · [Learn More](#learn-more) · [Docs](#docs)

---

## Why Footnote

Most AI products give you an answer and hide the reasoning context.

Footnote takes the opposite approach: make responses easier to inspect, easier to challenge, and easier to steer. The goal is to support better human judgment, not replace it.

Why this repo exists:

- Footnote is both a user-facing assistant and the codebase for building and running it.
- The repo keeps the product behavior, provenance model, and deployment paths in one place.
- If you want to try it, self-host it, or contribute to it, this is the place to start.

With Footnote, you can:

- See how confident the AI is
- Check what information it used
- Understand the trade-offs behind an answer
- See what guardrails were applied

[Try the live demo](https://ai.jordanmakes.dev)

## What You See After Asking

When you ask Footnote a question, you get more than a plain answer.

- An answer in normal language
- Sources or evidence Footnote used when they are available
- Provenance metadata that shows how the response was produced
- A trace view that helps you inspect confidence, trade-offs, and applied constraints

The point is not to make the AI look smarter. The point is to make its output easier to check, challenge, and steer.

## Learn More

- Curious about the idea behind Footnote: start with [History](docs/History.md) and [Philosophy](docs/Philosophy.md)
- Developer who wants the system shape: read the [Architecture Reading Guide](docs/architecture/README.md)
- Contributor who wants repo rules: read [AGENTS.md](AGENTS.md) and the [AI Assistance Guide](docs/ai/README.md)
- Self-hoster who wants to run the stack: use [Quickstart](#quickstart) for local setup, then [deploy/README.md](deploy/README.md) for Docker and Fly.io
- Want the docs map: open [docs/README.md](docs/README.md)

## Quickstart

This starts the local backend + web app.

1. Run local setup:

```bash
pnpm setup
```

> If `pnpm` is not available yet, run `corepack enable` once, then run `pnpm setup`.

`pnpm setup` will:

- create `.env` from `.env.example` when missing
- generate local secrets when missing (`INCIDENT_PSEUDONYMIZATION_SECRET`, `TRACE_API_TOKEN`)
- install dependencies

To enable generation features, configure at least one provider:

```env
# Option A: OpenAI-backed providers
OPENAI_API_KEY=...

# Option B: Ollama-backed text runtime
OLLAMA_LOCAL_INFERENCE_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
```

2. Start backend + web:

```bash
pnpm dev
```

3. Open web app:

`http://localhost:8080`

## How It Works

1. You ask Footnote a question.
2. The backend generates a response using the configured model runtime.
3. Footnote returns the answer with inspectable metadata (confidence, sources, trade-offs, and applied constraints).

Representative metadata shape:

```json
{
    "confidence": "medium",
    "sources": ["..."],
    "tradeoffs": ["..."],
    "constraintsApplied": ["..."]
}
```

### TRACE Wheel

TRACE shows five response qualities at a glance: Tightness, Rationale, Attribution, Caution, and Extent.

See [Response Metadata](docs/architecture/response-metadata.md)
for the current metadata model, and the
[TRACE decision record](docs/decisions/2026-03-compact-provenance-TRACE.md)
for rationale.

## Advanced Setup

### Run Discord Bot + Web + Backend

If you want the Discord surface, set Discord credentials in `.env` and run:

```bash
pnpm start:all
```

Required Discord configuration includes:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_USER_ID`
- `DISCORD_GUILD_IDS` (preferred) or `DISCORD_GUILD_ID` (legacy fallback)

### VoltOps Observability

To enable VoltAgent runtime observability in VoltOps, set:

```env
VOLTAGENT_PUBLIC_KEY=pk_...
VOLTAGENT_SECRET_KEY=sk_...
```

### Multi-Bot Vendoring

You can run a vendored bot identity by setting:

- `BOT_PROFILE_ID`
- `BOT_PROFILE_DISPLAY_NAME`
- `BOT_PROFILE_PROMPT_OVERLAY` or `BOT_PROFILE_PROMPT_OVERLAY_PATH`
- `BOT_PROFILE_MENTION_ALIASES` (optional)

For precedence details, see [`docs/architecture/prompt-resolution.md`](docs/architecture/prompt-resolution.md).

## Docs

Start here: [Documentation Map](docs/README.md)

Docs are actively being improved as Footnote evolves. If something is unclear or hard to find, open a Discussion and we will point you to the right source.

## Contributing

Contribution docs are still in progress.

For now, please open an Issue or Discussion for non-trivial changes so we can align on scope early. Thoughtful critique, focused PRs, and experiments are welcome.

## Project Status

Footnote is pre-1.0 and moving quickly. Expect rapid iteration and occasional sharp edges while interfaces and workflows stabilize.

## License

Footnote is dual-licensed under MIT and the Hippocratic License v3 (HL3-CORE).

See [license strategy](docs/LICENSE_STRATEGY.md) for details.
