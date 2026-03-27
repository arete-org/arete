# Footnote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/footnote-ai/footnote)

AI you can inspect and steer.

Footnote is a transparency-first AI framework for people who want more than a black-box answer. It pairs responses with provenance and trace metadata so you can understand what happened, challenge weak output, and guide behavior over time.

Built for human oversight, not "just trust me."

![footnote_chat](https://github.com/user-attachments/assets/963e6144-7d83-4d90-a580-7fc5a01d3566)

[Demo](https://ai.jordanmakes.dev) · [Quickstart](#quickstart) · [Docs](#docs) · [Contributing](#contributing)

---

## Why Footnote

Most AI products give you an answer and hide the reasoning context.

Footnote takes the opposite approach: make responses easier to inspect, easier to challenge, and easier to steer. The goal is to support better human judgment, not replace it.

With Footnote, you can:

- See how confident the AI is
- Check what information it used
- Understand the trade-offs behind an answer
- See what guardrails were applied

[Try the live demo](https://ai.jordanmakes.dev)

## Quickstart

This starts the local backend + web app.

1. Install dependencies:

```bash
pnpm install
```

> If `pnpm` is not available yet, run `corepack enable` once, then run `pnpm install`.

2. Create a local env file from `.env.example`.

Set at least these keys in `.env` for a useful local run:

```env
OPENAI_API_KEY=...
INCIDENT_PSEUDONYMIZATION_SECRET=<generate-a-random-secret>
```

Generate a secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

3. Start backend + web:

```bash
pnpm dev
```

4. Open web app:

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

Learn more: [TRACE decision record](docs/decisions/2026-03-compact-provenance-TRACE.md)

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
